import { CLEARANCE, nextAltitude, seatWaypoint } from './altitude';
import { nextAttitude } from './attitude';
import { initEkf, predict, update, MEASUREMENT_MATRIX } from './ekf';
import {
  drainRate,
  failureReason,
  findPad,
  fitToRange,
  GROUND_TIME,
  LAND_DESCENT,
  LAND_SPEED,
  MAX_ATTEMPTS,
  planRoute,
  routeLimit,
  shouldReturn,
  startMission,
  TAKEOFF_CLIMB,
} from './mission';
import { gaussians, next } from './rng';
import { createTerrain, terrainKey, type Terrain } from './terrain';
import type { Config, Mission, Snapshot, Vec2, Vec3 } from './types';
import { retarget, riverWaypoints } from './waypoints';
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

const ground = { pitch: 0, roll: 0 } as const;

const startEkf = (pos: Vec3) =>
  initEkf([pos[0], pos[2], 0, 0, pressureAt(pos[1])], [25, 25, 100, 100, 1]);

/** Drone and estimator at rest on the pad, nose towards the first waypoint of the route. */
const onPad = (
  home: Vec3,
  waypoints: readonly Vec3[],
): Pick<Snapshot, 'waypoints' | 'drone' | 'ekf'> => ({
  waypoints,
  drone: { pos: home, wp: 1, heading: headingTo(home, waypoints[1]), ...ground },
  ekf: startEkf(home),
});

export const createSnapshot = (cfg: Config, terrain: Terrain): Snapshot => {
  const home = findPad(terrain, cfg.seed);
  const [waypoints, r1] = planRoute(cfg, terrain, cfg.seed, home, AIR_SPEED);
  const [weather, r2] = createWeather(cfg, r1);
  return {
    time: 0,
    rng: r2,
    config: cfg,
    weather,
    mission: startMission(home),
    ...onPad(home, waypoints),
  };
};

interface Motion {
  readonly pos: Vec3;
  readonly heading: number;
  /** Speed through the air, which sets the bank angle. */
  readonly airSpeed: number;
  /** Velocity through the air that the estimator is told about. */
  readonly air: Vec2;
  /** Within reach of the current target. */
  readonly arrived: boolean;
}

/** Holding station on the ground: the autopilot cancels the wind, so ground velocity is zero. */
const holding = (s: Snapshot, pos: Vec3, heading: number, arrived = false): Motion => ({
  pos,
  heading,
  airSpeed: 0,
  air: [-s.config.windX, -s.config.windZ],
  arrived,
});

const fly = (s: Snapshot, terrain: Terrain, dt: number, target: Vec3): Motion => {
  const { config: cfg } = s;
  const [px, py, pz] = s.drone.pos;
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
  return {
    pos: [nx, nextAltitude(terrain, py, nx, nz, heading, dt), nz],
    heading,
    airSpeed: AIR_SPEED,
    air,
    arrived: distance < ARRIVAL_RADIUS,
  };
};

const takeOff = (s: Snapshot, dt: number): Motion => {
  const [px, py, pz] = s.drone.pos;
  const top = s.mission.home[1] + CLEARANCE;
  const next = Math.min(top, py + TAKEOFF_CLIMB * dt);
  return holding(s, [px, next, pz], s.drone.heading, next >= top);
};

const land = (s: Snapshot, terrain: Terrain, dt: number): Motion => {
  const [px, py, pz] = s.drone.pos;
  const [hx, hy, hz] = s.mission.home;
  const distance = Math.hypot(hx - px, hz - pz);
  const stride = Math.min(distance, LAND_SPEED * dt);
  const k = distance < 1e-6 ? 0 : stride / distance;
  const ground = Math.max(hy, terrain.heightAt(px, pz));
  const ny = Math.max(ground, py - LAND_DESCENT * dt);
  const velocity: Vec2 = [((hx - px) * k) / dt, ((hz - pz) * k) / dt];
  return {
    pos: [px + (hx - px) * k, ny, pz + (hz - pz) * k],
    heading: s.drone.heading,
    airSpeed: Math.hypot(velocity[0], velocity[1]),
    air: [velocity[0] - s.config.windX, velocity[1] - s.config.windZ],
    arrived: ny <= ground,
  };
};

const moveFor = (s: Snapshot, terrain: Terrain, dt: number): Motion => {
  const { phase } = s.mission;
  switch (phase) {
    case 'grounded':
      return holding(s, s.drone.pos, s.drone.heading);
    case 'takeoff':
      return takeOff(s, dt);
    case 'landing':
      return land(s, terrain, dt);
    case 'returning':
      return fly(s, terrain, dt, s.waypoints[0]);
    case 'cruise':
      return fly(s, terrain, dt, s.waypoints[s.drone.wp]);
  }
};

/** Charge, trip meter and pad countdown after moving from `from` to `to`. */
const account = (m: Mission, from: Vec3, to: Vec3, rain: number, dt: number): Mission => {
  const flown =
    m.phase === 'grounded' ? 0 : Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const climb = (to[1] - from[1]) / dt;
  return {
    ...m,
    battery: Math.max(0, m.battery - drainRate(m.phase, climb, rain) * dt),
    groundLeft: m.phase === 'grounded' ? Math.max(0, m.groundLeft - dt) : m.groundLeft,
    trip: m.trip + flown,
    totalTrip: m.totalTrip + flown,
  };
};

/** A completed landing: score the flight, refill the battery and choose the next route. */
const touchDown = (s: Snapshot, terrain: Terrain): Snapshot => {
  const m = s.mission;
  const failed = m.aborted;
  const attempt = failed ? m.attempt + 1 : 0;
  const replan = !failed || attempt >= MAX_ATTEMPTS;
  const [waypoints, rng] = replan
    ? planRoute(s.config, terrain, s.rng, m.home, AIR_SPEED)
    : [s.waypoints, s.rng];
  return {
    ...s,
    rng,
    ...onPad(m.home, waypoints),
    mission: {
      ...m,
      phase: 'grounded',
      battery: 1,
      groundLeft: GROUND_TIME,
      aborted: false,
      attempt: replan ? 0 : attempt,
      successes: m.successes + (failed ? 0 : 1),
      failures: m.failures + (failed ? 1 : 0),
    },
  };
};

/** Phase changes that follow from where the drone has got to. */
const transition = (s: Snapshot, motion: Motion, terrain: Terrain): Snapshot => {
  const m = s.mission;
  const { wp } = s.drone;
  const wind: Vec2 = [s.config.windX, s.config.windZ];
  const goTo = (phase: Mission['phase'], patch: Partial<Mission> = {}): Snapshot => ({
    ...s,
    mission: { ...m, phase, ...patch },
  });
  switch (m.phase) {
    case 'grounded':
      return m.groundLeft <= 0 ? goTo('takeoff', { trip: 0 }) : s;
    case 'takeoff':
      return motion.arrived ? goTo('cruise') : s;
    case 'cruise': {
      if (wp === 0 && motion.arrived) return goTo('landing');
      if (
        wp !== 0 &&
        shouldReturn(m.battery, s.drone.pos, m.home, wind, s.weather.rain, AIR_SPEED)
      ) {
        return {
          ...s,
          drone: { ...s.drone, wp: 0 },
          mission: {
            ...m,
            phase: 'returning',
            aborted: true,
            lastFailure: failureReason(wind, s.weather.rain),
          },
        };
      }
      return motion.arrived
        ? { ...s, drone: { ...s.drone, wp: (wp + 1) % s.waypoints.length } }
        : s;
    }
    case 'returning':
      return motion.arrived ? goTo('landing') : s;
    case 'landing':
      return motion.arrived ? touchDown(s, terrain) : s;
  }
};

export const step = (s: Snapshot, terrain: Terrain, dt: number): Snapshot => {
  const { config: cfg } = s;
  const motion = moveFor(s, terrain, dt);
  const flying = s.mission.phase !== 'grounded';
  const attitude = flying
    ? nextAttitude(
        s.drone,
        motion.airSpeed,
        wrapAngle(motion.heading - s.drone.heading) / dt,
        (motion.pos[1] - s.drone.pos[1]) / dt,
        dt,
      )
    : ground;

  const [noise, r1] = gaussians(s.rng, 3);
  const measurement = [
    motion.pos[0] + noise[0] * GPS_SIGMA,
    motion.pos[2] + noise[1] * GPS_SIGMA,
    pressureAt(motion.pos[1]) + noise[2] * BARO_SIGMA,
  ];
  const ekf = update(
    predict(s.ekf, motion.air, dt, PROCESS_VARIANCE),
    measurement,
    MEASUREMENT_MATRIX,
    MEASUREMENT_VARIANCE,
  );
  const [weather, r2] = stepWeather(s.weather, cfg, dt, r1);

  const moved: Snapshot = {
    ...s,
    time: s.time + dt,
    rng: r2,
    drone: { ...s.drone, pos: motion.pos, heading: motion.heading, ...attitude },
    ekf,
    weather,
    mission: account(s.mission, s.drone.pos, motion.pos, weather.rain, dt),
  };
  return transition(moved, motion, terrain);
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
  const home = findPad(next, config.seed);
  const grounded = s.mission.phase === 'grounded';
  return [
    {
      ...s,
      config,
      waypoints: [seatWaypoint(next, home[0], home[2]), ...retarget(s.waypoints.slice(1), next)],
      drone: grounded ? { ...s.drone, pos: home } : s.drone,
      mission: { ...s.mission, home },
    },
    next,
  ];
};

/** Largest seed the UI offers; keeps seeds short enough to read and share. */
export const MAX_SEED = 99999;

/** Draws a fresh map seed from the simulation RNG, returning it with the advanced RNG state. */
export const drawSeed = (rng: number): readonly [number, number] => {
  const [v, r] = next(rng);
  return [Math.floor(v * (MAX_SEED + 1)), r];
};

/** Parses a user-supplied seed; anything not a whole number in range is rejected. */
export const parseSeed = (text: string): number | null => {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_SEED ? n : null;
};

/**
 * Starts afresh on the map for `seed`: new terrain, pad and route, with the drone and its
 * estimator waiting on the pad. Wind, sliders, toggles and the flight tallies are kept.
 */
export const newMap = (s: Snapshot, seed: number): readonly [Snapshot, Terrain] => {
  const config = { ...s.config, seed };
  const terrain = createTerrain(config);
  const fresh = createSnapshot(config, terrain);
  const { successes, failures, totalTrip } = s.mission;
  return [
    {
      ...s,
      config,
      waypoints: fresh.waypoints,
      drone: fresh.drone,
      ekf: fresh.ekf,
      mission: { ...fresh.mission, successes, failures, totalTrip },
    },
    terrain,
  ];
};

/** Index to head for when a new route replaces the old one mid-flight. */
const resumeIndex = (s: Snapshot, preferred: number): number =>
  s.mission.phase === 'returning' || s.mission.phase === 'landing' ? 0 : preferred;

export const randomisePath = (s: Snapshot, terrain: Terrain): Snapshot => {
  const [waypoints, rng] = planRoute(s.config, terrain, s.rng, s.mission.home, AIR_SPEED);
  return {
    ...s,
    rng,
    waypoints,
    drone: { ...s.drone, wp: resumeIndex(s, 1) },
    mission: { ...s.mission, attempt: 0 },
  };
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

/** Replaces the path with an out-and-back flight along the river, trimmed to what the battery allows; a no-op when there is no river. */
export const followRiver = (s: Snapshot, terrain: Terrain): Snapshot => {
  const river = riverWaypoints(terrain);
  if (river.length === 0) return s;
  const [hx, , hz] = s.mission.home;
  const waypoints = fitToRange([seatWaypoint(terrain, hx, hz), ...river], routeLimit(AIR_SPEED));
  return {
    ...s,
    waypoints,
    drone: { ...s.drone, wp: resumeIndex(s, Math.max(1, nearestWaypoint(waypoints, s.drone.pos))) },
    mission: { ...s.mission, attempt: 0 },
  };
};
