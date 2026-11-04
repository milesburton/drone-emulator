import { nextAltitude } from './altitude';
import { level, nextAttitude } from './attitude';
import { initEkf, predict, update, MEASUREMENT_MATRIX } from './ekf';
import { gaussians } from './rng';
import { createTerrain, terrainKey, type Terrain } from './terrain';
import type { Config, Snapshot, Vec2, Vec3 } from './types';
import { generateWaypoints, retarget, riverWaypoints } from './waypoints';
import { createWeather, startStorm, stepWeather } from './weather';

export const AIR_SPEED = 25;
export const ARRIVAL_RADIUS = 15;
/** Fastest the drone may turn, radians per second, so course changes are smooth arcs. */
export const MAX_TURN_RATE = 0.7;
export const GPS_SIGMA = 3;
export const BARO_SIGMA = 0.3;

const PROCESS_VARIANCE = [0.05, 0.05, 0.02, 0.02, 1.5];
const MEASUREMENT_VARIANCE = [GPS_SIGMA ** 2, GPS_SIGMA ** 2, BARO_SIGMA ** 2];

export const defaultConfig: Config = {
  seed: 1337,
  windX: 6,
  windZ: -3,
  terrainScale: 60,
  worldSize: 1000,
  resolution: 160,
  lakes: true,
  river: true,
  roads: true,
};

/** International barometric formula, hPa at altitude `y` metres. */
export const pressureAt = (y: number): number => 1013.25 * Math.exp(-y / 8400);

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Turns `heading` towards `desired` by at most `maxStep` radians. */
export const turnTowards = (heading: number, desired: number, maxStep: number): number => {
  const delta = wrapAngle(desired - heading);
  return wrapAngle(heading + Math.max(-maxStep, Math.min(maxStep, delta)));
};

const headingTo = (from: Vec3, to: Vec3): number => Math.atan2(to[2] - from[2], to[0] - from[0]);

const startEkf = (pos: Vec3) =>
  initEkf([pos[0], pos[2], 0, 0, pressureAt(pos[1])], [25, 25, 100, 100, 1]);

export const createSnapshot = (cfg: Config, terrain: Terrain): Snapshot => {
  const [waypoints, r1] = generateWaypoints(cfg, terrain, cfg.seed);
  const [weather, r2] = createWeather(cfg, r1);
  const pos = waypoints[0];
  return {
    time: 0,
    rng: r2,
    config: cfg,
    waypoints,
    drone: { pos, wp: 1, heading: headingTo(pos, waypoints[1]), ...level },
    ekf: startEkf(pos),
    weather,
  };
};

export const step = (s: Snapshot, terrain: Terrain, dt: number): Snapshot => {
  const { config: cfg } = s;
  const [px, py, pz] = s.drone.pos;
  const target = s.waypoints[s.drone.wp];
  const dx = target[0] - px;
  const dz = target[2] - pz;
  const distance = Math.hypot(dx, dz);
  const heading =
    distance < 1e-6
      ? s.drone.heading
      : turnTowards(s.drone.heading, Math.atan2(dz, dx), MAX_TURN_RATE * dt);
  const air: Vec2 = [Math.cos(heading) * AIR_SPEED, Math.sin(heading) * AIR_SPEED];

  const nx = px + (air[0] + cfg.windX) * dt;
  const nz = pz + (air[1] + cfg.windZ) * dt;
  const ny = nextAltitude(terrain, py, nx, nz, heading, dt);
  const attitude = nextAttitude(
    s.drone,
    AIR_SPEED,
    wrapAngle(heading - s.drone.heading) / dt,
    (ny - py) / dt,
    dt,
  );
  const wp = distance < ARRIVAL_RADIUS ? (s.drone.wp + 1) % s.waypoints.length : s.drone.wp;

  const [noise, r1] = gaussians(s.rng, 3);
  const measurement = [
    nx + noise[0] * GPS_SIGMA,
    nz + noise[1] * GPS_SIGMA,
    pressureAt(ny) + noise[2] * BARO_SIGMA,
  ];
  const ekf = update(
    predict(s.ekf, air, dt, PROCESS_VARIANCE),
    measurement,
    MEASUREMENT_MATRIX,
    MEASUREMENT_VARIANCE,
  );

  const [weather, r2] = stepWeather(s.weather, cfg, dt, r1);

  return {
    ...s,
    time: s.time + dt,
    rng: r2,
    drone: { pos: [nx, ny, nz], wp, heading, ...attitude },
    ekf,
    weather,
  };
};

/** Applies a config change, rebuilding terrain only if a terrain-affecting field changed. */
export const applyConfig = (
  s: Snapshot,
  terrain: Terrain,
  patch: Partial<Config>,
): readonly [Snapshot, Terrain] => {
  const config = { ...s.config, ...patch };
  if (terrainKey(config) === terrainKey(s.config)) return [{ ...s, config }, terrain];
  const next = createTerrain(config);
  return [{ ...s, config, waypoints: retarget(s.waypoints, next) }, next];
};

export const randomisePath = (s: Snapshot, terrain: Terrain): Snapshot => {
  const [waypoints, rng] = generateWaypoints(s.config, terrain, s.rng);
  return { ...s, rng, waypoints, drone: { ...s.drone, wp: 0 } };
};

export const triggerStorm = (s: Snapshot): Snapshot => ({
  ...s,
  weather: startStorm(s.weather),
});

const nearestWaypoint = (waypoints: readonly Vec3[], [px, , pz]: Vec3): number =>
  waypoints.reduce(
    (best, [x, , z], i) =>
      Math.hypot(x - px, z - pz) < best.d ? { i, d: Math.hypot(x - px, z - pz) } : best,
    { i: 0, d: Infinity },
  ).i;

/** Replaces the path with an out-and-back flight along the river; a no-op when there is no river. */
export const followRiver = (s: Snapshot, terrain: Terrain): Snapshot => {
  const waypoints = riverWaypoints(terrain);
  if (waypoints.length === 0) return s;
  return { ...s, waypoints, drone: { ...s.drone, wp: nearestWaypoint(waypoints, s.drone.pos) } };
};
