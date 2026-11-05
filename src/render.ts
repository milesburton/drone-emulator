import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { flightLine } from './altitude';
import { buildDrone } from './droneModel';
import { STATUS_STYLE, statusOf } from './status';
import { colourAt, roadRibbon, terrainCoords, type Terrain } from './terrain';
import type { Snapshot, Vec3 } from './types';
import { boltPoints, CLOUD_COUNT, cloudBase, isStormCloud, rainDrops, rainStreak } from './weather';
import { streakSegment, windSpeed } from './wind';

/**
 * The Three.js shell. Everything mutable lives inside this closure; it only ever
 * reads snapshots and never feeds anything back into the simulation.
 */
export interface View {
  readonly draw: (snapshot: Snapshot, terrain: Terrain) => void;
  readonly resize: () => void;
}

const RAIN_COUNT = 1800;
const WIND_COUNT = 450;
const ROTOR_SPEED = 60;
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

const buildRoad = (ribbon: readonly Vec3[]): THREE.Mesh => {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    ribbon.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  );
  const quads = ribbon.length / 2 - 1;
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
    new THREE.MeshLambertMaterial({ color: 0x46464c, side: THREE.DoubleSide }),
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
  camera.position.set(0, 220, 380);
  const controls = new OrbitControls(camera, canvas);
  controls.maxPolarAngle = Math.PI * 0.49;

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

  const cache = {
    terrain: null as Terrain | null,
    mesh: null as THREE.Mesh | null,
    roads: [] as THREE.Mesh[],
    waypoints: null as readonly Vec3[] | null,
    home: null as Vec3 | null,
    droneAt: new THREE.Vector3(),
    time: 0,
  };
  const tintTarget = new THREE.Color();

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
    cache.roads = terrain.routes.roads.map((road) => buildRoad(roadRibbon(road, terrain)));
    scene.add(cache.mesh, ...cache.roads);
    cache.terrain = terrain;
    water.scale.set(terrain.extent * 2, 1, terrain.extent * 2);
    water.position.y = terrain.waterLevel;
  };

  const syncWaypoints = (waypoints: readonly Vec3[], terrain: Terrain): void => {
    if (cache.waypoints === waypoints) return;
    markers.children.slice().forEach((m) => {
      markers.remove(m);
      disposeObject(m);
    });
    waypoints.forEach(([x, y, z]) => {
      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(6),
        new THREE.MeshBasicMaterial({ color: 0xffd60a }),
      );
      marker.position.set(x, y, z);
      markers.add(marker);
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
    s.weather.clouds.forEach((c, i) => {
      clouds[i].position.set(c.x, c.y, c.z);
      clouds[i].scale.setScalar(c.radius);
    });
    const [x, y, z] = s.drone.pos;
    const previous = cache.droneAt.clone();
    cache.droneAt.set(x, y, z);
    drone.position.copy(cache.droneAt);
    // The model faces +z; YXZ order applies roll, then pitch, then yaw. Three's +x rotation is nose-down.
    drone.rotation.set(-s.drone.pitch, Math.PI / 2 - s.drone.heading, s.drone.roll, 'YXZ');
    // Fade the body towards the colour of the current state rather than snapping to it.
    const fade = 1 - Math.exp(-TINT_RATE * Math.min(Math.max(s.time - cache.time, 0), 0.5));
    tintTarget.setHex(STATUS_STYLE[statusOf(s)].colour);
    tint.color.lerp(tintTarget, fade);
    tint.emissive.copy(tint.color).multiplyScalar(0.3);
    cache.time = s.time;
    rotors.forEach((rotor, i) => {
      rotor.rotation.y = s.time * ROTOR_SPEED * (i % 2 === 0 ? 1 : -1);
    });
    camera.position.add(cache.droneAt.clone().sub(previous));
    controls.target.copy(cache.droneAt);
    controls.update();
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

  return { draw, resize };
};
