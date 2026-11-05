import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { flightLine } from './altitude';
import { buildBridges } from './bridgeModel';
import { buildDrone } from './droneModel';
import { buildFlag, faceDownwind } from './flags';
import { STATUS_STYLE, statusOf } from './status';
import { disturbance, windStrength } from './sway';
import { swayUniforms } from './swayMaterial';
import { carsAt, createDrivers, type Driver } from './traffic';
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
import { streakSegment, windSpeed } from './wind';

/**
 * The Three.js shell. Everything mutable lives inside this closure; it only ever
 * reads snapshots and never feeds anything back into the simulation.
 */
export interface View {
  readonly draw: (snapshot: Snapshot, terrain: Terrain) => void;
  readonly resize: () => void;
  /** Free look: drag turns the camera in place and WASD flies it; turning it off returns to the drone. */
  readonly setFreeLook: (on: boolean) => void;
}

const RAIN_COUNT = 1800;
const WIND_COUNT = 450;
const ROTOR_SPEED = 60;
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
const FOG_NEAR = 600;
const FOG_FAR = 4200;
const TINT_RATE = 3;
const PAD_RADIUS = 8;
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
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 12000);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 10;

  const look = { free: false, framed: false, yaw: 0, pitch: 0, last: 0 };
  const held = new Set<string>();
  const aim = (): void => {
    camera.quaternion.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
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
    if (!look.free || typing || !(e.code in MOVE_KEYS)) return;
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

  const streaks = rainDrops(WIND_COUNT, 311);
  const windPositions = new Float32Array(WIND_COUNT * 6);
  const windGeometry = new THREE.BufferGeometry();
  windGeometry.setAttribute('position', new THREE.BufferAttribute(windPositions, 3));
  const windLines = new THREE.LineSegments(
    windGeometry,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 }),
  );
  windLines.frustumCulled = false;
  scene.add(windLines);

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

  const cache = {
    terrain: null as Terrain | null,
    drivers: [] as readonly Driver[],
    traffic: null as Traffic | null,
    mesh: null as THREE.Mesh | null,
    roads: [] as THREE.Mesh[],
    waypoints: null as readonly Vec3[] | null,
    home: null as Vec3 | null,
    forestTerrain: null as Terrain | null,
    forestHome: null as Vec3 | null,
    droneAt: new THREE.Vector3(),
    time: 0,
  };
  const tintTarget = new THREE.Color();

  const syncTraffic = (terrain: Terrain): void => {
    traffic.children.slice().forEach((m) => {
      traffic.remove(m);
      disposeObject(m);
    });
    cache.drivers = createDrivers(terrain);
    cache.traffic = buildTraffic(cache.drivers.length);
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
    waypoints.forEach(([x, y, z], i) => {
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
    (windLines.material as THREE.LineBasicMaterial).opacity =
      0.05 + (Math.min(speed, 20) / 20) * 0.15;
    streaks.forEach((offset, i) => {
      const [head, tail] = streakSegment(
        offset,
        windX,
        windZ,
        s.time,
        s.drone.pos,
        terrain.heightAt,
      );
      windPositions.set([...head, ...tail], i * 6);
    });
    windGeometry.attributes.position.needsUpdate = true;
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
    cache.traffic?.update(carsAt(terrain, cache.drivers, s.time));
    markers.children.forEach((flag) => faceDownwind(flag, s.config.windX, s.config.windZ));
    const gust = gustAt(s.time, s.weather.rain);
    const strength = windStrength(s.config.windX, s.config.windZ, gust);
    const air = new THREE.Vector2(s.config.windX + gust[0], s.config.windZ + gust[1]);
    swayUniforms.uTime.value = s.time;
    swayUniforms.uWind.value = strength;
    swayUniforms.uDir.value.copy(air.length() > 0.1 ? air.normalize() : air.set(0, 0));
    const wobble = disturbance(s.time, strength);
    s.weather.clouds.forEach((c, i) => {
      clouds[i].position.set(c.x, c.y, c.z);
      clouds[i].scale.setScalar(c.radius);
    });
    const [x, y, z] = s.drone.pos;
    const previous = cache.droneAt.clone();
    cache.droneAt.set(x, y, z);
    // Buffeting is drawn on the model only; the camera and the flight itself use the true position.
    drone.position.copy(cache.droneAt).add(new THREE.Vector3(...wobble.offset));
    // The model faces +z; YXZ order applies roll, then pitch, then yaw. Three's +x rotation is nose-down.
    drone.rotation.set(
      -(s.drone.pitch + wobble.pitch),
      Math.PI / 2 - s.drone.heading + wobble.yaw,
      s.drone.roll + wobble.roll,
      'YXZ',
    );
    // Fade the body towards the colour of the current state rather than snapping to it.
    const fade = 1 - Math.exp(-TINT_RATE * Math.min(Math.max(s.time - cache.time, 0), 0.5));
    tintTarget.setHex(STATUS_STYLE[statusOf(s)].colour);
    tint.color.lerp(tintTarget, fade);
    tint.emissive.copy(tint.color).multiplyScalar(0.3);
    cache.time = s.time;
    rotors.forEach((rotor, i) => {
      rotor.rotation.y = s.time * ROTOR_SPEED * (i % 2 === 0 ? 1 : -1);
    });
    const now = performance.now();
    const dt = Math.min((now - look.last) / 1000, 0.1);
    look.last = now;
    if (look.framed) camera.position.add(cache.droneAt.clone().sub(previous));
    else camera.position.copy(cache.droneAt).add(CAMERA_OFFSET);
    look.framed = true;
    held.forEach((code) => {
      const [x, z] = MOVE_KEYS[code] ?? [0, 0];
      // Level with the ground like an FPS: pitch steers the view but not the walking direction.
      const step = MOVE_SPEED * dt;
      camera.position.x += (x * Math.cos(look.yaw) + z * Math.sin(look.yaw)) * step;
      camera.position.z += (z * Math.cos(look.yaw) - x * Math.sin(look.yaw)) * step;
    });
    controls.target.copy(cache.droneAt);
    if (!look.free) controls.update();
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

  return { draw, resize, setFreeLook };
};
