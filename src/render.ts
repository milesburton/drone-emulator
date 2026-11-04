import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { positionOf } from './ekf';
import { colourAt, type Terrain } from './terrain';
import type { Snapshot, Vec3 } from './types';
import { boltPoints, CLOUD_COUNT, rainDrops } from './weather';

/**
 * The Three.js shell. Everything mutable lives inside this closure; it only ever
 * reads snapshots and never feeds anything back into the simulation.
 */
export interface View {
  readonly draw: (snapshot: Snapshot, terrain: Terrain) => void;
  readonly resize: () => void;
}

const RAIN_COUNT = 1800;
const RAIN_BOX = 400;
const RAIN_HEIGHT = 320;
const SKY_CLEAR = new THREE.Color(0x87b8e8);
const SKY_STORM = new THREE.Color(0x3b424d);

const buildTerrainMesh = (terrain: Terrain): THREE.Mesh => {
  const { worldSize, resolution } = terrain.cfg;
  const geometry = new THREE.PlaneGeometry(worldSize, worldSize, resolution - 1, resolution - 1);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  const colours = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const h = terrain.heightAt(positions.getX(i), positions.getZ(i));
    positions.setY(i, h);
    const [r, g, b] = colourAt(h, terrain);
    colours.set([r, g, b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
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
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 6000);
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

  const drone = new THREE.Mesh(
    new THREE.ConeGeometry(5, 14, 4).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x444444 }),
  );
  const estimate = new THREE.Mesh(
    new THREE.SphereGeometry(4, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
  );
  scene.add(drone, estimate);

  const clouds = Array.from({ length: CLOUD_COUNT }, buildCloud);
  clouds.forEach((c) => scene.add(c));

  const drops = rainDrops(RAIN_COUNT, 77);
  const rainPositions = new Float32Array(RAIN_COUNT * 6);
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const rain = new THREE.LineSegments(
    rainGeometry,
    new THREE.LineBasicMaterial({ color: 0xaecbe8, transparent: true, opacity: 0.5 }),
  );
  rain.frustumCulled = false;
  scene.add(rain);

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

  const cache = {
    terrain: null as Terrain | null,
    mesh: null as THREE.Mesh | null,
    waypoints: null as readonly Vec3[] | null,
    droneAt: new THREE.Vector3(),
  };

  const syncTerrain = (terrain: Terrain): void => {
    if (cache.terrain === terrain) return;
    if (cache.mesh) {
      scene.remove(cache.mesh);
      disposeObject(cache.mesh);
    }
    cache.mesh = buildTerrainMesh(terrain);
    scene.add(cache.mesh);
    cache.terrain = terrain;
    water.scale.set(terrain.cfg.worldSize, 1, terrain.cfg.worldSize);
    water.position.y = terrain.waterLevel;
  };

  const syncWaypoints = (waypoints: readonly Vec3[]): void => {
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
    const loop = [...waypoints, waypoints[0]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    pathLine.geometry.dispose();
    pathLine.geometry = new THREE.BufferGeometry().setFromPoints(loop);
    cache.waypoints = waypoints;
  };

  const syncRain = (s: Snapshot): void => {
    const intensity = s.weather.rain;
    rain.visible = intensity > 0.03;
    if (!rain.visible) return;
    (rain.material as THREE.LineBasicMaterial).opacity = 0.15 + intensity * 0.45;
    const [cx, cy, cz] = s.drone.pos;
    const fall = s.time * 90;
    drops.forEach(([ox, oy, oz], i) => {
      const y = (((oy * RAIN_HEIGHT - fall) % RAIN_HEIGHT) + RAIN_HEIGHT) % RAIN_HEIGHT;
      const x = cx + (ox - 0.5) * RAIN_BOX;
      const z = cz + (oz - 0.5) * RAIN_BOX;
      const top = cy - 120 + y;
      rainPositions.set([x, top, z, x, top - 6, z], i * 6);
    });
    rainGeometry.attributes.position.needsUpdate = true;
  };

  const syncLightning = (s: Snapshot, terrain: Terrain): void => {
    const { flash, strike, rain: intensity } = s.weather;
    const sky = SKY_CLEAR.clone().lerp(SKY_STORM, intensity);
    (scene.background as THREE.Color).copy(sky.lerp(new THREE.Color(0xffffff), flash * 0.6));
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
        boltPoints(strike, 220, ground).map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      );
    }
  };

  const draw = (s: Snapshot, terrain: Terrain): void => {
    syncTerrain(terrain);
    syncWaypoints(s.waypoints);
    s.weather.clouds.forEach((c, i) => {
      clouds[i].position.set(c.x, c.y, c.z);
      clouds[i].scale.setScalar(c.radius);
    });
    const [x, y, z] = s.drone.pos;
    const previous = cache.droneAt.clone();
    cache.droneAt.set(x, y, z);
    const target = s.waypoints[s.drone.wp];
    drone.position.copy(cache.droneAt);
    drone.lookAt(target[0], y, target[2]);
    const [ex, ez] = positionOf(s.ekf);
    estimate.position.set(ex, y + 8, ez);
    camera.position.add(cache.droneAt.clone().sub(previous));
    controls.target.copy(cache.droneAt);
    controls.update();
    syncRain(s);
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
