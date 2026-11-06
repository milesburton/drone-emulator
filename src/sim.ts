import { CLEARANCE, nextAltitude, seatWaypoint } from './altitude';
import { nextAttitude } from './attitude';
import { hitsCraft } from './craft';
import { beginCrash, fall, hasHitTerrain, hasImpacted } from './crash';
import { initEkf, predict, update, MEASUREMENT_MATRIX } from './ekf';
import {
  drainRate,
  failureReason,
  findPad,
  fitToRange,
  GROUND_TIME,
  isLost,
  LAND_DESCENT,
  LAND_SPEED,
  CRASH_TIME,
  MAX_ATTEMPTS,
  planRoute,
  routeLimit,
  shouldReturn,
  startMission,
  TAKEOFF_CLIMB,
} from './mission';
import { gaussians, next } from './rng';
import {
  aimAt,
  gateAt,
  nextTrackAltitude,
  steerClear,
  avoidables,
  speedFor,
  TRACK_TAKEOFF,
  trackPad,
  trackRoute,
} from './trackFlight';
import { trackFor } from './track';
import { crossing, hitsGate, hitsObstacle, type GateResult } from './gates';
import { FOOTPRINT, groundBeneath } from './altitude';
import { createTerrain, FENCE_HEIGHT, terrainKey, type Terrain } from './terrain';
import type { Config, Crash, CrashCause, Mission, Snapshot, Vec2, Vec3 } from './types';
import { retarget, riverWaypoints } from './waypoints';
import { clearStorm, createWeather, gustAt, startStorm, stepWeather } from './weather';

export const AIR_SPEED = 36;
export const ARRIVAL_RADIUS = 20;
/** Fastest the drone may turn, radians per second, so course changes are smooth arcs. */
export const MAX_TURN_RATE = 1.2;
export const GPS_SIGMA = 3;
export const BARO_SIGMA = 0.3;

const PROCESS_VARIANCE = [0.05, 0.05, 0.02, 0.02, 1.5];
const MEASUREMENT_VARIANCE = [GPS_SIGMA ** 2, GPS_SIGMA ** 2, BARO_SIGMA ** 2];

export const defaultConfig: Config = {
  mode: 'sortie',
  seed: 1337,
  biome: 'valley',
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

/** The pad for this mode: levelled ground in a sortie, the start spot ahead of the first gate on a track. */
const padFor = (cfg: Config, terrain: Terrain): Vec3 =>
  cfg.mode === 'track' ? trackPad(terrain, cfg.seed) : findPad(terrain, cfg.seed);

/** A fresh route for this mode, with the advanced RNG. */
const routeFor = (
  cfg: Config,
  terrain: Terrain,
  rng: number,
  home: Vec3,
): readonly [readonly Vec3[], number] =>
  cfg.mode === 'track'
    ? [trackRoute(terrain, cfg.seed), rng]
    : planRoute(cfg, terrain, rng, home, AIR_SPEED);

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
  const home = padFor(cfg, terrain);
  const [waypoints, r1] = routeFor(cfg, terrain, cfg.seed, home);
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
  /** Track mode: how the move went through the gate being flown to, if it crossed its plane. */
  readonly gate?: GateResult;
  /** Set while the drone is falling or wrecked; replaces the flight attitude. */
  readonly wreck?: { readonly pitch: number; readonly roll: number; readonly crash: Crash };
}

/** Holding station on the ground: the autopilot cancels the wind, so ground velocity is zero. */
const holding = (s: Snapshot, pos: Vec3, heading: number, arrived = false): Motion => ({
  pos,
  heading,
  airSpeed: 0,
  air: [-s.config.windX, -s.config.windZ],
  arrived,
});

/** Index of the gate being flown to, or null when heading for the pad (or not on a track). */
const gateIndex = (s: Snapshot, terrain: Terrain): number | null => {
  if (s.config.mode !== 'track') return null;
  const at = gateAt(s.drone.wp, trackFor(terrain, s.config.seed).gates.length, s.waypoints.length);
  return at === null ? null : at.gate;
};

/** The gate the drone is flying to, or null when heading for the pad (or not on a track). */
const gateTarget = (s: Snapshot, terrain: Terrain) => {
  if (s.config.mode !== 'track') return null;
  const gates = trackFor(terrain, s.config.seed).gates;
  const at = gateAt(s.drone.wp, gates.length, s.waypoints.length);
  return at === null ? null : gates[at.gate];
};

/** Result of the move to `pos` through the gate being flown to: undefined when no gate is the target, null when it did not cross. */
const gateFlown = (s: Snapshot, terrain: Terrain, pos: Vec3): GateResult | null | undefined => {
  const gate = gateTarget(s, terrain);
  return gate === null ? undefined : crossing(gate, s.drone.pos, pos);
};

const fly = (s: Snapshot, terrain: Terrain, dt: number, target: Vec3): Motion => {
  const { config: cfg } = s;
  const [px, py, pz] = s.drone.pos;
  const gate = gateTarget(s, terrain);
  const aim = gate === null ? target : aimAt(gate, s.drone.pos);
  const dx = aim[0] - px;
  const dz = aim[2] - pz;
  const distance = Math.hypot(dx, dz);
  const speed = speedFor(cfg);
  const gust = gustAt(s.time, s.weather.rain);
  // On a track the autopilot points into the wind by the crab angle that holds its line (it is told the wind).
  const course =
    cfg.mode === 'track'
      ? steerClear(
          Math.atan2(dz, dx),
          s.drone.pos,
          avoidables(trackFor(terrain, cfg.seed), gateIndex(s, terrain)),
          FOOTPRINT,
        )
      : Math.atan2(dz, dx);
  const crab =
    cfg.mode === 'track'
      ? Math.asin(
          Math.max(
            -0.95,
            Math.min(
              0.95,
              (-(cfg.windX + gust[0]) * Math.sin(course) +
                (cfg.windZ + gust[1]) * Math.cos(course)) /
                speed,
            ),
          ),
        )
      : 0;
  const heading =
    distance < 1e-6
      ? s.drone.heading
      : turnTowards(s.drone.heading, course - crab, MAX_TURN_RATE * dt);
  const air: Vec2 = [Math.cos(heading) * speed, Math.sin(heading) * speed];
  const nx = px + (air[0] + cfg.windX + gust[0]) * dt;
  const nz = pz + (air[1] + cfg.windZ + gust[1]) * dt;
  const ny =
    cfg.mode === 'track'
      ? nextTrackAltitude(terrain, py, nx, nz, target[1], dt)
      : nextAltitude(terrain, py, nx, nz, heading, dt);
  const pos: Vec3 = [nx, ny, nz];
  const through = cfg.mode === 'track' ? gateFlown(s, terrain, pos) : undefined;
  return {
    pos,
    heading,
    airSpeed: speed,
    air,
    // A gate is reached by crossing its plane, not by coming near; the pad by coming near.
    arrived: through === undefined ? distance < ARRIVAL_RADIUS : through !== null,
    ...(through === undefined || through === null ? {} : { gate: through }),
  };
};

const takeOff = (s: Snapshot, terrain: Terrain, dt: number): Motion => {
  const [px, py, pz] = s.drone.pos;
  const top =
    s.config.mode === 'track'
      ? Math.max(groundBeneath(terrain, px, pz), terrain.waterLevel) + TRACK_TAKEOFF
      : s.mission.home[1] + CLEARANCE;
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

/** A lost drone has no power: it falls, tumbles and lies where it hits until it is collected. */
const crash = (s: Snapshot, terrain: Terrain, dt: number): Motion => {
  const gust = gustAt(s.time, s.weather.rain);
  const down = fall(
    s.drone,
    s.drone.crash ?? beginCrash([0, 0, 0], [0, 0.5, 0.5]),
    terrain,
    [s.config.windX + gust[0], s.config.windZ + gust[1]],
    dt,
  );
  return {
    pos: down.pos,
    heading: down.heading,
    airSpeed: 0,
    air: [down.crash.vel[0] - s.config.windX, down.crash.vel[2] - s.config.windZ],
    arrived: down.crash.since !== null && s.mission.groundLeft <= 0,
    wreck: { pitch: down.pitch, roll: down.roll, crash: down.crash },
  };
};

const moveFor = (s: Snapshot, terrain: Terrain, dt: number): Motion => {
  const { phase } = s.mission;
  switch (phase) {
    case 'grounded':
      return holding(s, s.drone.pos, s.drone.heading);
    case 'takeoff':
      return takeOff(s, terrain, dt);
    case 'landing':
      return land(s, terrain, dt);
    case 'lost':
      return crash(s, terrain, dt);
    case 'returning':
      return fly(s, terrain, dt, s.waypoints[0]);
    case 'cruise':
      return fly(s, terrain, dt, s.waypoints[s.drone.wp]);
  }
};

/** Charge, trip meter and pad countdown after moving from `from` to `to`. */
const account = (
  m: Mission,
  from: Vec3,
  to: Vec3,
  rain: number,
  dt: number,
  impacted: boolean,
): Mission => {
  const waiting = m.phase === 'grounded' || (m.phase === 'lost' && impacted);
  const flown =
    m.phase === 'grounded' ? 0 : Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const climb = (to[1] - from[1]) / dt;
  return {
    ...m,
    battery: Math.max(0, m.battery - drainRate(m.phase, climb, rain) * dt),
    groundLeft: waiting ? Math.max(0, m.groundLeft - dt) : m.groundLeft,
    trip: m.trip + flown,
    totalTrip: m.totalTrip + flown,
  };
};

/**
 * A flight's end, on the pad or (when lost) after the drone is collected from where it came down:
 * score the flight, refill the battery and choose the next route.
 */
const touchDown = (s: Snapshot, terrain: Terrain, down = false): Snapshot => {
  const m = s.mission;
  // Every flight that ends in the wreck being collected ended in an impact, so a crash outranks a power loss.
  const crashed = down;
  const powerless = down && m.downBy === 'power';
  const failed = m.aborted && !down;
  const attempt = failed ? m.attempt + 1 : 0;
  const replan = down || !failed || attempt >= MAX_ATTEMPTS;
  const [waypoints, rng] = replan
    ? routeFor(s.config, terrain, s.rng, m.home)
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
      successes: m.successes + (failed || crashed ? 0 : 1),
      failures: m.failures + (failed ? 1 : 0),
      lost: m.lost + (powerless ? 1 : 0),
      crashed: m.crashed + (crashed ? 1 : 0),
      downBy: null,
      lapStart: null,
      outcome: crashed ? 'crashed' : failed ? 'failed' : 'success',
    },
  };
};

/** Power gone mid-air (flat battery or a strike on the terrain): momentum carries on while the airframe starts to tumble. */
const loseFlight = (
  s: Snapshot,
  wind: Vec2,
  downBy: 'power' | 'impact',
  cause: CrashCause,
): Snapshot => {
  const [a, r1] = next(s.rng);
  const [b, r2] = next(r1);
  const [c, r3] = next(r2);
  const h = s.drone.heading;
  return {
    ...s,
    rng: r3,
    drone: {
      ...s.drone,
      crash: beginCrash(
        [Math.cos(h) * speedFor(s.config) + wind[0], 0, Math.sin(h) * speedFor(s.config) + wind[1]],
        [a, b, c],
      ),
    },
    mission: {
      ...s.mission,
      phase: 'lost',
      downBy,
      crashCause: cause,
      groundLeft: CRASH_TIME,
    },
  };
};

/** Counts a gate flown through (or missed) on the mission. */
const tally = (m: Mission, gate: GateResult | undefined): Mission =>
  gate === undefined
    ? m
    : {
        ...m,
        passed: m.passed + (gate === 'pass' ? 1 : 0),
        missed: m.missed + (gate === 'miss' ? 1 : 0),
      };

/**
 * Lap timing on a track: gate 0 is the start/finish. The first arrival starts the clock; each later
 * arrival closes a lap, records it, and starts the next.
 */
const timeLap = (s: Snapshot, terrain: Terrain): Mission => {
  const m = s.mission;
  if (s.config.mode !== 'track') return m;
  const here = gateAt(
    s.drone.wp,
    trackFor(terrain, s.config.seed).gates.length,
    s.waypoints.length,
  );
  if (here === null || here.gate !== 0) return m;
  if (m.lapStart === null) return { ...m, lapStart: s.time };
  const lap = s.time - m.lapStart;
  return {
    ...m,
    laps: m.laps + 1,
    lapStart: s.time,
    lastLap: lap,
    bestLap: m.bestLap === null ? lap : Math.min(m.bestLap, lap),
  };
};

/** Phase changes that follow from where the drone has got to. */
const transition = (s: Snapshot, motion: Motion, terrain: Terrain): Snapshot => {
  const m = s.mission;
  const { wp } = s.drone;
  const gust = gustAt(s.time, s.weather.rain);
  const wind: Vec2 = [s.config.windX + gust[0], s.config.windZ + gust[1]];
  const goTo = (phase: Mission['phase'], patch: Partial<Mission> = {}): Snapshot => ({
    ...s,
    mission: { ...m, phase, ...patch },
  });
  const powerLoss = (): Snapshot => loseFlight(s, wind, 'power', 'power');
  const speed = speedFor(s.config);
  switch (m.phase) {
    case 'grounded':
      return m.groundLeft <= 0 ? goTo('takeoff', { trip: 0, outcome: null }) : s;
    case 'takeoff':
      return motion.arrived ? goTo('cruise') : s;
    case 'cruise': {
      if (wp === 0 && motion.arrived) return goTo('landing');
      if (isLost(m.battery, s.drone.pos, m.home, s.waypoints[wp], wind, s.weather.rain, speed)) {
        return powerLoss();
      }
      if (wp !== 0 && shouldReturn(m.battery, s.drone.pos, m.home, wind, s.weather.rain, speed)) {
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
        ? {
            ...s,
            drone: { ...s.drone, wp: (wp + 1) % s.waypoints.length },
            mission: tally(timeLap(s, terrain), motion.gate),
          }
        : s;
    }
    case 'returning':
      if (isLost(m.battery, s.drone.pos, m.home, m.home, wind, s.weather.rain, speed)) {
        return powerLoss();
      }
      return motion.arrived ? goTo('landing') : s;
    case 'lost':
      return motion.arrived ? touchDown(s, terrain, true) : s;
    case 'landing':
      return motion.arrived ? touchDown(s, terrain) : s;
  }
};

/** What the drone has just hit, if anything: the ground or water, another craft, or the track's gates and obstacles. */
const strikeCause = (
  s: Snapshot,
  terrain: Terrain,
  inAir: boolean,
  aloft: boolean,
): CrashCause | null => {
  const { pos } = s.drone;
  if (aloft && hitsCraft(pos, s.config.seed, s.time, terrain)) return 'craft';
  const arena = terrain.arena;
  if (
    aloft &&
    arena &&
    Math.hypot(pos[0] - arena.centre[0], pos[2] - arena.centre[2]) > arena.radius - FOOTPRINT &&
    pos[1] < arena.centre[1] + FENCE_HEIGHT
  ) {
    return 'fence';
  }
  if (aloft && s.config.mode === 'track') {
    const track = trackFor(terrain, s.config.seed);
    if (track.obstacles.some((o) => hitsObstacle(o, pos))) return 'obstacle';
    if (track.gates.some((g) => hitsGate(g, pos))) return 'gate';
  }
  if (inAir && hasHitTerrain(pos, terrain)) {
    return groundBeneath(terrain, pos[0], pos[2]) <= terrain.waterLevel ? 'water' : 'terrain';
  }
  return null;
};

export const step = (s: Snapshot, terrain: Terrain, dt: number): Snapshot => {
  const { config: cfg } = s;
  const { phase } = s.mission;
  const inAir = phase === 'cruise' || phase === 'returning';
  const aloft = inAir || phase === 'takeoff' || phase === 'landing';
  const cause = strikeCause(s, terrain, inAir, aloft);
  if (cause !== null) {
    const gust = gustAt(s.time, s.weather.rain);
    return loseFlight(s, [cfg.windX + gust[0], cfg.windZ + gust[1]], 'impact', cause);
  }
  const motion = moveFor(s, terrain, dt);
  const flying = s.mission.phase !== 'grounded' && s.mission.phase !== 'lost';
  const attitude = motion.wreck
    ? motion.wreck
    : flying
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
    drone: {
      ...s.drone,
      pos: motion.pos,
      heading: motion.heading,
      pitch: attitude.pitch,
      roll: attitude.roll,
      ...(motion.wreck ? { crash: motion.wreck.crash } : {}),
    },
    ekf,
    weather,
    mission: account(
      s.mission,
      s.drone.pos,
      motion.pos,
      weather.rain,
      dt,
      hasImpacted(s.drone.crash),
    ),
  };
  return transition(moved, motion, terrain);
};

/** Sortie and track use different pads and routes, so changing mode starts a fresh flight from the new pad. */
const switchMode = (
  s: Snapshot,
  config: Config,
  terrain: Terrain,
): readonly [Snapshot, Terrain] => {
  const home = padFor(config, terrain);
  const [waypoints, rng] = routeFor(config, terrain, s.rng, home);
  const { successes, failures, lost, crashed, totalTrip, laps, bestLap } = s.mission;
  return [
    {
      ...s,
      config,
      rng,
      ...onPad(home, waypoints),
      mission: {
        ...startMission(home),
        successes,
        failures,
        lost,
        crashed,
        totalTrip,
        laps,
        bestLap,
      },
    },
    terrain,
  ];
};

/** Applies a config change, rebuilding terrain only if a terrain-affecting field changed. */
export const applyConfig = (
  s: Snapshot,
  terrain: Terrain,
  patch: Partial<Config>,
): readonly [Snapshot, Terrain] => {
  const config = { ...s.config, ...patch };
  if (config.mode !== s.config.mode)
    return switchMode(
      s,
      config,
      terrainKey(config) === terrainKey(s.config) ? terrain : createTerrain(config),
    );
  if (terrainKey(config) === terrainKey(s.config)) return [{ ...s, config }, terrain];
  const next = createTerrain(config);
  const home = padFor(config, next);
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
  const { successes, failures, lost, crashed, totalTrip, laps, bestLap } = s.mission;
  return [
    {
      ...s,
      config,
      waypoints: fresh.waypoints,
      drone: fresh.drone,
      ekf: fresh.ekf,
      mission: { ...fresh.mission, successes, failures, lost, crashed, totalTrip, laps, bestLap },
    },
    terrain,
  ];
};

/** Index to head for when a new route replaces the old one mid-flight. */
const resumeIndex = (s: Snapshot, preferred: number): number =>
  s.mission.phase === 'returning' || s.mission.phase === 'landing' ? 0 : preferred;

export const randomisePath = (s: Snapshot, terrain: Terrain): Snapshot => {
  const [waypoints, rng] = routeFor(s.config, terrain, s.rng, s.mission.home);
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

export const calmStorm = (s: Snapshot): Snapshot => ({
  ...s,
  weather: clearStorm(s.weather),
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
  if (river.length === 0 || s.config.mode === 'track') return s;
  const [hx, , hz] = s.mission.home;
  const waypoints = fitToRange([seatWaypoint(terrain, hx, hz), ...river], routeLimit(AIR_SPEED));
  return {
    ...s,
    waypoints,
    drone: { ...s.drone, wp: resumeIndex(s, Math.max(1, nearestWaypoint(waypoints, s.drone.pos))) },
    mission: { ...s.mission, attempt: 0 },
  };
};
