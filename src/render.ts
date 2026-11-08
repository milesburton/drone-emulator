import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { flightLine } from './altitude';
import { buildBridges } from './bridgeModel';
import { hasImpacted } from './crash';
import { trackFor } from './track';
import { buildTrack } from './trackModel';
import { runFor } from './forestRun';
import { animalsFor } from './animals';
import { buildAnimals, buildRun, type AnimalsView } from './runModel';
import { buildCraftFx } from './craftFx';
import { buildRivalFx } from './rivalFx';
import { buildCrashFx } from './crashFx';
import { MICRO_SCALE } from './airframe';
import { buildDrone } from './droneModel';
import { buildAirlinerFx } from './airlinersFx';
import { bankFor } from './attitude';
import { buildFlag, faceDownwind } from './flags';
import { STATUS_STYLE, statusOf } from './status';
import { disturbance, windStrength } from './sway';
import { swayUniforms } from './swayMaterial';
import { advanceTo, carsAt, createDrivers, createFleet, type Driver, type Fleet } from './traffic';
import { buildTraffic, type Traffic } from './trafficModel';
import { buildForest } from './treeModel';
import { placeTrees } from './trees';
import { colourAt, roadRibbon, terrainCoords, type Terrain } from './terrain';
import type { Snapshot, Vec3 } from './types';
import {
  boltPoints,
  CLOUD_COUNT,
  cloudBase,
  gustAt,
  isStormCloud,
  rainDrops,
  rainStreak,
} from './weather';
import { buildStreamlines, STREAM_STEP, windSpeed } from './streamlines';

/**
 * The Three.js shell. Everything mutable lives inside this closure; it only ever
 * reads snapshots and never feeds anything back into the simulation.
 */
export interface View {
  readonly draw: (snapshot: Snapshot, terrain: Terrain) => void;
  readonly resize: () => void;
  /** Free look: drag turns the camera in place and WASD flies it; turning it off returns to the drone. */
  readonly setFreeLook: (on: boolean) => void;
  /** Track mode only: a camera high above the track looking down on it; off returns to the drone. */
  readonly setOverview: (on: boolean) => void;
}

const RAIN_COUNT = 1800;
const ROTOR_SPEED = 60;
/** Body colour of a wreck. */
const CHARRED = 0x1c1c1e;
const CAMERA_OFFSET = new THREE.Vector3(0, 18, 42);
const LOOK_SPEED = 0.004;
const LOOK_PITCH_LIMIT = Math.PI * 0.49;
const DOLLY_SPEED = 0.05;
const MOVE_SPEED = 80;
const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};
/** Noclip vertical flight: E rises, F lowers (neither is reserved by Chrome or Firefox). */
const RISE_KEYS: Readonly<Record<string, number>> = { KeyE: 1, KeyF: -1 };
const isFlyKey = (code: string): boolean => code in MOVE_KEYS || code in RISE_KEYS;
/** Height of the track-overview camera above the arena, metres. */
const OVERVIEW_HEIGHT = 420;
const FOG_NEAR = 600;
const FOG_FAR = 4200;
const TINT_RATE = 3;
/** Time constant of the drawn nose direction, seconds. */
const HEADING_LAG = 0.3;
/** The agile FPV craft turns sharply, so its drawn nose follows more closely. */
const AGILE_HEADING_LAG = 0.15;
/** Time constant of the drawn bank and pitch, seconds. */
const POSE_LAG = 0.3;
const PAD_RADIUS = 8;
/** How far past the pad's edge the finish flag stands. */
const FLAG_GAP = 10;

/** Beside the pad, to the left of the first leg, so the flag is never under the drone's takeoff or landing. */
export const finishFlagSpot = (waypoints: readonly Vec3[]): readonly [number, number] => {
  const [hx, , hz] = waypoints[0];
  const [nx, , nz] = waypoints[1] ?? waypoints[0];
  const len = Math.hypot(nx - hx, nz - hz) || 1;
  const offset = PAD_RADIUS + FLAG_GAP;
  return [hx + (-(nz - hz) / len) * offset, hz + ((nx - hx) / len) * offset];
};
const PAD_LIFT = 0.15;
const CLOUD_WHITE = new THREE.Color(0xffffff);
const CLOUD_STORM = new THREE.Color(0x4f5560);
const SKY_CLEAR = new THREE.Color(0x87b8e8);
const SKY_STORM = new THREE.Color(0x3b424d);

const buildTerrainMesh = (terrain: Terrain): THREE.Mesh => {
  const coords = terrainCoords(terrain);
  const n = coords.length;
  const geometry = new THREE.PlaneGeometry(1, 1, n - 1, n - 1);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  const colours = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const x = coords[i % n];
    const z = coords[Math.floor(i / n)];
    const h = terrain.heightAt(x, z);
    positions.setXYZ(i, x, h, z);
    const [r, g, b] = colourAt(h, terrain);
    colours.set([r, g, b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
};

/** Metres of road covered by one repeat of the lane texture (one dash plus one gap). */
const LANE_REPEAT = 12;

/** Asphalt with solid white edge lines and a dashed centre line; u runs across, v along the road. */
const laneTexture = (): THREE.CanvasTexture => {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#46464c';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#e8e8e0';
    ctx.fillRect(size * 0.05, 0, size * 0.04, size);
    ctx.fillRect(size * 0.91, 0, size * 0.04, size);
    ctx.fillRect(size * 0.48, 0, size * 0.04, size * 0.5);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

const buildRoad = (ribbon: readonly Vec3[], texture: THREE.Texture): THREE.Mesh => {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    ribbon.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );
  const quads = ribbon.length / 2 - 1;
  const along = Array.from({ length: quads + 1 }).reduce<number[]>((acc, _, q) => {
    if (q === 0) return [0];
    const [ax, , az] = ribbon[2 * q - 2];
    const [bx, , bz] = ribbon[2 * q];
    return [...acc, acc[q - 1] + Math.hypot(bx - ax, bz - az) / LANE_REPEAT];
  }, []);
  geometry.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      along.flatMap((v) => [0, v, 1, v]),
      2,
    ),
  );
  geometry.setIndex(
    Array.from({ length: quads }, (_, q) => [
      2 * q,
      2 * q + 1,
      2 * q + 2,
      2 * q + 1,
      2 * q + 3,
      2 * q + 2,
    ]).flat(),
  );
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide }),
  );
};

/** A flat grey disc with a yellow ring, lying just above the ground at the launch pad. */
const buildPad = (): THREE.Group => {
  const group = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(PAD_RADIUS, 32).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x5a5a60 }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(PAD_RADIUS * 0.75, PAD_RADIUS * 0.88, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd60a }),
  );
  ring.position.y = 0.05;
  group.add(disc, ring);
  return group;
};

const disposeObject = (obj: THREE.Object3D): void => {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
};

const buildCloud = (): THREE.Group => {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
  });
  [
    [0, 0, 0, 1],
    [0.7, -0.1, 0.2, 0.7],
    [-0.7, -0.1, -0.1, 0.75],
    [0.2, 0.15, -0.6, 0.6],
    [-0.2, 0.1, 0.6, 0.65],
  ].forEach(([x, y, z, s]) => {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), material);
    puff.position.set(x, y, z);
    puff.scale.set(s, s * 0.55, s);
    group.add(puff);
  });
  return group;
};

export const createView = (canvas: HTMLCanvasElement): View => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = SKY_CLEAR.clone();
  scene.fog = new THREE.Fog(SKY_CLEAR.clone(), FOG_NEAR, FOG_FAR);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 12000);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 10;

  const look = { free: false, overview: false, framed: false, yaw: 0, pitch: 0, last: 0 };
  const held = new Set<string>();
  const aim = (): void => {
    camera.quaternion.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
  };
  const setOverview = (on: boolean): void => {
    look.overview = on;
    controls.enabled = !on && !look.free;
    if (!on) look.framed = false;
  };
  const setFreeLook = (on: boolean): void => {
    if (on === look.free) return;
    look.free = on;
    controls.enabled = !on;
    held.clear();
    if (!on) look.framed = false;
    if (on) {
      const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      look.yaw = euler.y;
      look.pitch = euler.x;
    }
  };
  canvas.addEventListener('pointermove', (e) => {
    if (!look.free || e.buttons === 0) return;
    look.yaw -= e.movementX * LOOK_SPEED;
    look.pitch = Math.min(
      Math.max(look.pitch - e.movementY * LOOK_SPEED, -LOOK_PITCH_LIMIT),
      LOOK_PITCH_LIMIT,
    );
    aim();
  });
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
    if (!look.free || typing || !isFlyKey(e.code)) return;
    // Shift+W etc. are not reserved by Chrome or Firefox; still stop any default action.
    e.preventDefault();
    held.add(e.code);
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!look.free) return;
      e.preventDefault();
      camera.translateZ(e.deltaY * DOLLY_SPEED);
    },
    { passive: false },
  );

  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(300, 600, 200);
  scene.add(ambient, sun);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x2f6fb5, transparent: true, opacity: 0.8 }),
  );
  scene.add(water);

  const { group: drone, rotors, tint } = buildDrone();
  scene.add(drone);
  const crashFx = buildCrashFx();
  scene.add(crashFx.group);
  const airliners = buildAirlinerFx();
  scene.add(airliners.group);
  const fleet = buildCraftFx();
  scene.add(fleet.group);
  const rivals = buildRivalFx();
  scene.add(rivals.group);

  const clouds = Array.from({ length: CLOUD_COUNT }, buildCloud);
  clouds.forEach((c) => scene.add(c));

  const drops = rainDrops(RAIN_COUNT, 77);
  const stormIndices = Array.from({ length: CLOUD_COUNT }, (_, i) => i).filter(isStormCloud);
  const rainPositions = new Float32Array(RAIN_COUNT * 6);
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const rain = new THREE.LineSegments(
    rainGeometry,
    new THREE.LineBasicMaterial({ color: 0xaecbe8, transparent: true, opacity: 0.5 }),
  );
  rain.frustumCulled = false;
  scene.add(rain);

  // Wind as long streamlines bent by the terrain; rebuilt when the map or the wind changes.
  const windLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 }),
  );
  windLines.frustumCulled = false;
  scene.add(windLines);
  const flow = {
    terrain: null as Terrain | null,
    key: '',
    builtAt: -Infinity,
    /** Distance along its line of each segment end, for the travelling pulse. */
    arcs: new Float32Array(0),
    /** Local speed over the open speed at each segment end. */
    ratios: new Float32Array(0),
    colors: new Float32Array(0),
  };

  const bolt = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xf4f0ff }),
  );
  bolt.visible = false;
  scene.add(bolt);
  const flashLight = new THREE.PointLight(0xcfd8ff, 0, 2000);
  scene.add(flashLight);

  const markers = new THREE.Group();
  scene.add(markers);
  const pathLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffd60a }),
  );
  scene.add(pathLine);

  const pad = buildPad();
  pad.visible = false;
  scene.add(pad);

  const laneMap = laneTexture();
  const forest = new THREE.Group();
  scene.add(forest);

  const traffic = new THREE.Group();
  scene.add(traffic);

  const trackGroup = new THREE.Group();
  scene.add(trackGroup);
  const runGroup = new THREE.Group();
  scene.add(runGroup);

  const cache = {
    terrain: null as Terrain | null,
    drivers: [] as readonly Driver[],
    fleet: null as Fleet | null,
    traffic: null as Traffic | null,
    mesh: null as THREE.Mesh | null,
    roads: [] as THREE.Mesh[],
    waypoints: null as readonly Vec3[] | null,
    home: null as Vec3 | null,
    forestTerrain: null as Terrain | null,
    forestHome: null as Vec3 | null,
    animals: null as AnimalsView | null,
    runKey: null as string | null,
    runTerrain: null as Terrain | null,
    trackKey: null as string | null,
    trackTerrain: null as Terrain | null,
    droneAt: new THREE.Vector3(),
    scale: 1,
    time: 0,
    shownHeading: null as number | null,
    shownRoll: 0,
    shownPitch: 0,
  };
  const tintTarget = new THREE.Color();

  const syncTraffic = (terrain: Terrain): void => {
    traffic.children.slice().forEach((m) => {
      traffic.remove(m);
      disposeObject(m);
    });
    cache.drivers = createDrivers(terrain);
    cache.fleet = createFleet(terrain, cache.drivers);
    cache.traffic = buildTraffic(cache.drivers);
    traffic.add(cache.traffic.group);
  };

  const syncTerrain = (terrain: Terrain): void => {
    if (cache.terrain === terrain) return;
    if (cache.mesh) {
      scene.remove(cache.mesh);
      disposeObject(cache.mesh);
    }
    cache.roads.forEach((road) => {
      scene.remove(road);
      disposeObject(road);
    });
    cache.mesh = buildTerrainMesh(terrain);
    cache.roads = terrain.routes.roads.flatMap((road) => {
      const ribbon = roadRibbon(road, terrain);
      const bridges = buildBridges(road, ribbon, terrain);
      return bridges ? [buildRoad(ribbon, laneMap), bridges] : [buildRoad(ribbon, laneMap)];
    });
    scene.add(cache.mesh, ...cache.roads);
    cache.terrain = terrain;
    syncTraffic(terrain);
    water.scale.set(terrain.extent * 2, 1, terrain.extent * 2);
    water.position.y = terrain.waterLevel;
  };

  const syncWaypoints = (waypoints: readonly Vec3[], terrain: Terrain): void => {
    if (cache.waypoints === waypoints) return;
    markers.children.slice().forEach((m) => {
      markers.remove(m);
      disposeObject(m);
    });
    // The route is a round trip, so the first waypoint (the pad) is also the finish line.
    waypoints.forEach(([wx, y, wz], i) => {
      // The finish flag stands beside the pad, not on it, so the craft visibly lifts from and lands on the pad.
      const [x, z] = i === 0 ? finishFlagSpot(waypoints) : [wx, wz];
      const ground = terrain.heightAt(x, z);
      const flag = buildFlag(y - ground, i === 0 ? 'finish' : i);
      flag.position.set(x, ground, z);
      markers.add(flag);
    });
    const route = flightLine(waypoints, terrain);
    const loop = [...route, route[0]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    pathLine.geometry.dispose();
    pathLine.geometry = new THREE.BufferGeometry().setFromPoints(loop);
    cache.waypoints = waypoints;
  };

  const syncPad = (home: Vec3): void => {
    if (cache.home === home) return;
    pad.position.set(home[0], home[1] + PAD_LIFT, home[2]);
    pad.visible = true;
    cache.home = home;
  };

  const syncForest = (terrain: Terrain, home: Vec3): void => {
    if (cache.forestTerrain === terrain && cache.forestHome === home) return;
    forest.children.slice().forEach((m) => {
      forest.remove(m);
      disposeObject(m);
    });
    forest.add(...buildForest(placeTrees(terrain, home)).children);
    cache.forestTerrain = terrain;
    cache.forestHome = home;
  };

  /** The FPV track, drawn only in track mode and rebuilt when the map or seed changes. */
  const running = (s: Snapshot): boolean => s.config.mode === 'run';

  const syncTrack = (s: Snapshot, terrain: Terrain): void => {
    const on = s.config.mode === 'track';
    const running = s.config.mode === 'run';
    trackGroup.visible = on;
    runGroup.visible = running;
    // The sortie route and its flags have no place on a track or a run, and the scenery trees would clip the giant ones.
    markers.visible = !on && !running;
    pathLine.visible = !on && !running;
    forest.visible = !running;
    const runKey = running ? `${s.config.seed}` : null;
    if (runKey !== cache.runKey || terrain !== cache.runTerrain) {
      runGroup.children.slice().forEach((m) => {
        runGroup.remove(m);
        disposeObject(m);
      });
      if (running) {
        runGroup.add(buildRun(runFor(terrain, s.config.seed)));
        cache.animals = buildAnimals(animalsFor(terrain, s.config.seed));
        runGroup.add(cache.animals.group);
      } else {
        cache.animals = null;
      }
      cache.runKey = runKey;
      cache.runTerrain = terrain;
    }
    const key = on ? `${s.config.seed}` : null;
    if (key === cache.trackKey && terrain === cache.trackTerrain) return;
    trackGroup.children.slice().forEach((m) => {
      trackGroup.remove(m);
      disposeObject(m);
    });
    if (on) {
      trackGroup.add(buildTrack(trackFor(terrain, s.config.seed), terrain.heightAt, terrain.arena));
    }
    cache.trackKey = key;
    cache.trackTerrain = terrain;
  };

  const syncRain = (s: Snapshot, terrain: Terrain): void => {
    const intensity = s.weather.rain;
    rain.visible = intensity > 0.03;
    stormIndices.forEach((i) => {
      const puff = clouds[i].children[0] as THREE.Mesh;
      (puff.material as THREE.MeshLambertMaterial).color
        .copy(CLOUD_WHITE)
        .lerp(CLOUD_STORM, intensity);
    });
    if (!rain.visible) return;
    (rain.material as THREE.LineBasicMaterial).opacity = 0.15 + intensity * 0.45;
    drops.forEach((drop, i) => {
      const cloud = s.weather.clouds[stormIndices[i % stormIndices.length]];
      const ground = terrain.heightAt(
        cloud.x + (drop[0] - 0.5) * 1.6 * cloud.radius,
        cloud.z + (drop[2] - 0.5) * 1.6 * cloud.radius,
      );
      const [bottom, top] = rainStreak(drop, cloud, ground, s.time);
      rainPositions.set([...bottom, ...top], i * 6);
    });
    rainGeometry.attributes.position.needsUpdate = true;
  };

  const syncWind = (s: Snapshot, terrain: Terrain): void => {
    const { windX, windZ } = s.config;
    const speed = windSpeed(windX, windZ);
    windLines.visible = speed > 0.5;
    if (!windLines.visible) return;
    const key = `${windX},${windZ}`;
    // A slider drag changes the wind many times a second; rebuild at most every 120 ms and show the last lines between.
    const stale = flow.terrain !== terrain || flow.key !== key;
    if (stale && (flow.terrain !== terrain || performance.now() - flow.builtAt > 120)) {
      flow.builtAt = performance.now();
      const lines = buildStreamlines(terrain, windX, windZ);
      const positions: number[] = [];
      const arcs: number[] = [];
      const ratios: number[] = [];
      lines.forEach(({ points, speeds }) => {
        points.slice(1).forEach((b, i) => {
          const a = points[i];
          positions.push(...a, ...b);
          arcs.push(i * STREAM_STEP, (i + 1) * STREAM_STEP);
          ratios.push(speeds[i], speeds[i + 1]);
        });
      });
      windLines.geometry.dispose();
      windLines.geometry = new THREE.BufferGeometry();
      windLines.geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(positions), 3),
      );
      flow.colors = new Float32Array(positions.length);
      windLines.geometry.setAttribute('color', new THREE.BufferAttribute(flow.colors, 3));
      flow.arcs = new Float32Array(arcs);
      flow.ratios = new Float32Array(ratios);
      flow.terrain = terrain;
      flow.key = key;
    }
    // Pale blue where the air is slowed or sheltered, brighter white where it speeds over a crest, with a
    // slow pulse running downwind along every line.
    const strength = 0.35 + (Math.min(speed, 20) / 20) * 0.65;
    flow.arcs.forEach((arc, i) => {
      const pulse = 0.72 + 0.28 * Math.sin(arc * 0.05 - s.time * 2.2);
      const fast = Math.min(Math.max((flow.ratios[i] - 0.6) / 1.0, 0), 1);
      const light = strength * pulse;
      flow.colors[i * 3] = light * (0.55 + 0.45 * fast);
      flow.colors[i * 3 + 1] = light * (0.78 + 0.22 * fast);
      flow.colors[i * 3 + 2] = light;
    });
    windLines.geometry.attributes.color.needsUpdate = true;
  };

  const boltTop = (s: Snapshot, strike: readonly [number, number]): number =>
    s.weather.clouds
      .filter((_, i) => isStormCloud(i))
      .reduce(
        (best, c) =>
          Math.hypot(c.x - strike[0], c.z - strike[1]) < best.d
            ? { d: Math.hypot(c.x - strike[0], c.z - strike[1]), y: cloudBase(c) }
            : best,
        { d: Infinity, y: 220 },
      ).y;

  const syncLightning = (s: Snapshot, terrain: Terrain): void => {
    const { flash, strike, rain: intensity } = s.weather;
    const sky = SKY_CLEAR.clone().lerp(SKY_STORM, intensity);
    const skyColour = sky.lerp(new THREE.Color(0xffffff), flash * 0.6);
    (scene.background as THREE.Color).copy(skyColour);
    (scene.fog as THREE.Fog).color.copy(skyColour);
    ambient.intensity = 0.7 - intensity * 0.35 + flash * 0.9;
    sun.intensity = 1.1 - intensity * 0.7;
    flashLight.intensity = flash * 6;
    const visible = strike !== null && flash > 0.25;
    bolt.visible = visible;
    if (visible && strike) {
      const ground = terrain.heightAt(strike[0], strike[1]);
      flashLight.position.set(strike[0], 150, strike[1]);
      bolt.geometry.dispose();
      bolt.geometry = new THREE.BufferGeometry().setFromPoints(
        boltPoints(strike, boltTop(s, strike), ground).map(
          ([x, y, z]) => new THREE.Vector3(x, y, z),
        ),
      );
    }
  };

  const draw = (s: Snapshot, terrain: Terrain): void => {
    syncTerrain(terrain);
    syncWaypoints(s.waypoints, terrain);
    syncPad(s.mission.home);
    syncForest(terrain, s.mission.home);
    syncTrack(s, terrain);
    if (running(s)) cache.animals?.update(terrain, s.time);
    traffic.visible = s.config.traffic;
    if (cache.fleet && s.config.traffic) {
      // A restart rewinds the clock; start the traffic over rather than running it backwards.
      const base = cache.fleet.time > s.time ? createFleet(terrain, cache.drivers) : cache.fleet;
      cache.fleet = advanceTo(terrain, cache.drivers, base, s.time);
      cache.traffic?.update(carsAt(terrain, cache.drivers, cache.fleet, s.time));
    }
    markers.children.forEach((flag) => faceDownwind(flag, s.config.windX, s.config.windZ));
    const gust = gustAt(s.time, s.weather.rain);
    const strength = windStrength(s.config.windX, s.config.windZ, gust);
    const air = new THREE.Vector2(s.config.windX + gust[0], s.config.windZ + gust[1]);
    swayUniforms.uTime.value = s.time;
    swayUniforms.uWind.value = strength;
    swayUniforms.uDir.value.copy(air.length() > 0.1 ? air.normalize() : air.set(0, 0));
    const wobble = disturbance(s.time, strength);
    airliners.update(s.config.seed, s.time, terrain.extent);
    fleet.update(s.config.seed, s.time, terrain);
    s.weather.clouds.forEach((c, i) => {
      clouds[i].position.set(c.x, c.y, c.z);
      clouds[i].scale.setScalar(c.radius);
      // Cloud would hide the track from above.
      clouds[i].visible = !look.overview;
    });
    // The micro drone of the track and the run is drawn small, with its camera, pad and effects to match.
    const scale = s.config.mode === 'sortie' ? 1 : MICRO_SCALE;
    if (scale !== cache.scale) {
      cache.scale = scale;
      look.framed = false;
      drone.scale.setScalar(scale);
      pad.scale.setScalar(scale);
      controls.minDistance = 10 * scale;
    }
    const [x, y, z] = s.drone.pos;
    const previous = cache.droneAt.clone();
    cache.droneAt.set(x, y, z);
    // Buffeting is drawn on the model only; the camera and the flight itself use the true position.
    const crashed = s.drone.crash;
    // A dead drone is not buffeted by the autopilot's wind model; it just falls.
    drone.position.copy(cache.droneAt);
    if (!crashed) drone.position.add(new THREE.Vector3(...wobble.offset).multiplyScalar(scale));
    // The drawn heading trails the simulated one a little, so the nose never snaps when a turn begins.
    const elapsed = s.time - cache.time;
    const heading =
      crashed || cache.shownHeading === null || elapsed <= 0 || elapsed > 0.5
        ? s.drone.heading
        : cache.shownHeading +
          Math.atan2(
            Math.sin(s.drone.heading - cache.shownHeading),
            Math.cos(s.drone.heading - cache.shownHeading),
          ) *
            (1 -
              Math.exp(-elapsed / (s.config.mode === 'sortie' ? HEADING_LAG : AGILE_HEADING_LAG)));
    // Bank follows the turn actually drawn (coordinated turn), and both angles ease rather than step.
    const drawnRate =
      cache.shownHeading === null || elapsed <= 0 || elapsed > 0.5
        ? 0
        : Math.atan2(
            Math.sin(heading - cache.shownHeading),
            Math.cos(heading - cache.shownHeading),
          ) / elapsed;
    const ease = elapsed > 0 && elapsed <= 0.5 ? 1 - Math.exp(-elapsed / POSE_LAG) : 1;
    const flying = s.drone.pos[1] - terrain.heightAt(x, z) > 1;
    const rollGoal = flying ? bankFor(s.drone.speed ?? 0, drawnRate) : s.drone.roll;
    cache.shownRoll += (rollGoal - cache.shownRoll) * ease;
    cache.shownPitch += (s.drone.pitch - cache.shownPitch) * ease;
    cache.shownHeading = heading;
    // The model faces +z; YXZ order applies roll, then pitch, then yaw. Three's +x rotation is nose-down.
    drone.rotation.set(
      -((crashed ? s.drone.pitch : cache.shownPitch) + (crashed ? 0 : wobble.pitch)),
      Math.PI / 2 - heading + (crashed ? 0 : wobble.yaw),
      (crashed ? s.drone.roll : cache.shownRoll) + (crashed ? 0 : wobble.roll),
      'YXZ',
    );
    // Fade the body towards the colour of the current state rather than snapping to it.
    const fade = 1 - Math.exp(-TINT_RATE * Math.min(Math.max(s.time - cache.time, 0), 0.5));
    tintTarget.setHex(hasImpacted(crashed) ? CHARRED : STATUS_STYLE[statusOf(s)].colour);
    tint.color.lerp(tintTarget, fade);
    tint.emissive.copy(tint.color).multiplyScalar(0.3);
    cache.time = s.time;
    rotors.forEach((rotor, i) => {
      // Without power the rotors stop and their translucent discs vanish; one is torn off on impact.
      if (!crashed) rotor.rotation.y = s.time * ROTOR_SPEED * (i % 2 === 0 ? 1 : -1);
      rotor.children.forEach((part, k) => {
        part.visible = k > 0 || !crashed;
      });
      rotor.visible = !(i === 0 && hasImpacted(crashed));
    });
    crashFx.update(
      crashed?.since ?? null,
      [x, y, z],
      [s.config.windX + gust[0], s.config.windZ + gust[1]],
      terrain,
      scale,
      terrain.heightAt(x, z) <= terrain.waterLevel,
    );
    rivals.update(s, terrain, scale);
    const now = performance.now();
    const dt = Math.min((now - look.last) / 1000, 0.1);
    look.last = now;
    // Free look is noclip: the camera is detached from the drone, so wind and flight never move it.
    if (look.overview && (s.config.mode === 'track' || s.config.mode === 'run')) {
      // A run is seen from over the middle of the line from pad to goal, higher up to take in all of it.
      const run = s.config.mode === 'run' ? runFor(terrain, s.config.seed) : null;
      const [cx, cy, cz] = run
        ? [
            (run.start[0] + run.goal[0]) / 2,
            (run.start[1] + run.goal[1]) / 2,
            (run.start[2] + run.goal[2]) / 2,
          ]
        : trackFor(terrain, s.config.seed).centre;
      const height = run ? OVERVIEW_HEIGHT * 0.8 : OVERVIEW_HEIGHT * 0.5;
      camera.position.set(cx, cy + height, cz + height * 0.45);
      camera.lookAt(cx, cy, cz);
    } else if (!look.free) {
      if (look.framed) camera.position.add(cache.droneAt.clone().sub(previous));
      else
        camera.position.copy(cache.droneAt).add(CAMERA_OFFSET.clone().multiplyScalar(scale * 1.6));
      look.framed = true;
    }
    held.forEach((code) => {
      const [x, z] = MOVE_KEYS[code] ?? [0, 0];
      // Level with the ground like an FPS: pitch steers the view but not the walking direction.
      const step = MOVE_SPEED * Math.max(scale, 0.35) * dt;
      camera.position.y += (RISE_KEYS[code] ?? 0) * step;
      camera.position.x += (x * Math.cos(look.yaw) + z * Math.sin(look.yaw)) * step;
      camera.position.z += (z * Math.cos(look.yaw) - x * Math.sin(look.yaw)) * step;
    });
    controls.target.copy(cache.droneAt);
    if (!look.free && !look.overview) controls.update();
    syncRain(s, terrain);
    syncWind(s, terrain);
    syncLightning(s, terrain);
    renderer.render(scene, camera);
  };

  const resize = (): void => {
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(clientHeight, 1);
    camera.updateProjectionMatrix();
  };

  return { draw, resize, setFreeLook, setOverview };
};
