import { CLEARANCE, LANE_SPACING, MIN_CLEARANCE, nextAltitude, seatWaypoint } from './altitude';
import { nextAttitude } from './attitude';
import {
  AGILE_CLIMB_FACTOR,
  AGILE_YAW_ACCEL_PER_RATE,
  approach,
  smoothClimb,
  SPEED_ACCEL,
  turnSmoothly,
  YAW_ACCEL_PER_RATE,
} from './smooth';
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
import { searchPad } from './pad';
import { gaussians, next } from './rng';
import {
  aimAt,
  gateAt,
  nextTrackAltitude,
  steerClear,
  avoidables,
  speedFor,
  turnRateFor,
  TRACK_TAKEOFF,
  trackPad,
  trackRoute,
} from './trackFlight';
import { trackFor } from './track';
import { animalAt, animalsFor, hitsAnimal } from './animals';
import { tunnelCarrot, tunnelHold } from './tunnels';
import {
  goalIndex,
  near,
  nextRunAltitude,
  planCourse,
  runFor,
  runRoute,
  strikes,
} from './forestRun';
import { crossing, hitsGate, hitsObstacle, hitsSky, type GateResult } from './gates';
import { AIRFRAME_RADIUS, footprintFor } from './airframe';
import { groundBeneath } from './altitude';
import { createTerrain, FENCE_HEIGHT, terrainKey, type Terrain } from './terrain';
import type {
  Agent,
  Config,
  Crash,
  CrashCause,
  Mission,
  Rival,
  Snapshot,
  Vec2,
  Vec3,
} from './types';
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
  rivals: 7,
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

/** The shared course of a track or run, started from this pilot's own pad instead of the main drone's. */
const fromPad = (route: readonly Vec3[], home: Vec3): readonly Vec3[] => [home, ...route.slice(1)];

/** A fresh route for this mode, with the advanced RNG. */
const routeFor = (
  cfg: Config,
  terrain: Terrain,
  rng: number,
  home: Vec3,
): readonly [readonly Vec3[], number] =>
  cfg.mode === 'track'
    ? [fromPad(trackRoute(terrain, cfg.seed), home), rng]
    : cfg.mode === 'run'
      ? [fromPad(runRoute(runFor(terrain, cfg.seed)), home), rng]
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
    rivals: makeRivals(cfg, terrain, home),
  };
};

/** Seconds between one rival's takeoff and the next, so they do not all leave the pads together. */
export const START_STAGGER = 3;
/** Metres between neighbouring pads in the grid round the main pad on a shared start (track and run). */
export const PAD_SPACING = 4;
const PAD_SLOTS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
/** Metres between pads on the fallback grid for a sortie: more than two airframes' reach. */
const SORTIE_PAD_SPACING = 28;
/** Least distance between two sortie pads. */
const PAD_SEPARATION = 60;
const RIVAL_SALT = 0x9e3779b1;

/** Pad for rival `i` (0-based): its own ground in a sortie, or a slot on the start line beside the main pad. */
const rivalPad = (
  cfg: Config,
  terrain: Terrain,
  i: number,
  taken: readonly Vec3[],
  base: Vec3,
): Vec3 => {
  if (cfg.mode === 'sortie') {
    const searched = Array.from({ length: 6 }, (_, k) =>
      searchPad(terrain, cfg.seed + (i + 1) * 7919 + k * 104729),
    );
    // Tight terrain offers few pads; failing a distant one, take a spot on a wide grid round the main pad.
    const grid = PAD_SLOTS.map(([ahead, aside]): Vec3 => {
      const x = base[0] + ahead * SORTIE_PAD_SPACING;
      const z = base[2] + aside * SORTIE_PAD_SPACING;
      return [x, terrain.heightAt(x, z), z];
    });
    const apart = (c: Vec3, least: number): boolean =>
      taken.every((p) => Math.hypot(p[0] - c[0], p[2] - c[2]) >= least);
    return (
      searched.find((c) => apart(c, PAD_SEPARATION)) ??
      [...searched, ...grid].find((c) => apart(c, SORTIE_PAD_SPACING * 0.9)) ??
      grid[i % grid.length]
    );
  }
  // A grid round the main pad, square to the first leg, so every pilot lines up on the first gate much as the main one does.
  const route = routeFor(cfg, terrain, cfg.seed, base)[0];
  const forward = headingTo(base, route[1]);
  const [ahead, aside] = PAD_SLOTS[i % PAD_SLOTS.length];
  const x = base[0] + (Math.cos(forward) * ahead - Math.sin(forward) * aside) * PAD_SPACING;
  const z = base[2] + (Math.sin(forward) * ahead + Math.cos(forward) * aside) * PAD_SPACING;
  return [x, terrain.heightAt(x, z), z];
};

/** The other pilots for this map: each has its own pad, route, RNG and battery, and leaves a little after the last. */
export const makeRivals = (cfg: Config, terrain: Terrain, playerHome: Vec3): readonly Rival[] =>
  Array.from({ length: cfg.rivals }).reduce<readonly Rival[]>((rivals, _, i) => {
    const home = rivalPad(
      cfg,
      terrain,
      i,
      [playerHome, ...rivals.map((r) => r.mission.home)],
      playerHome,
    );
    const [waypoints, rng] = routeFor(
      cfg,
      terrain,
      (cfg.seed ^ RIVAL_SALT) + (i + 1) * 40503,
      home,
    );
    return [
      ...rivals,
      {
        id: i + 1,
        lane: i + 1,
        kind: i % 2 === 0 ? 'quad' : 'octo',
        control: 'auto',
        rng,
        path: undefined,
        ...onPad(home, waypoints),
        mission: { ...startMission(home), groundLeft: GROUND_TIME + (i + 1) * START_STAGGER },
      },
    ];
  }, []);

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

/** Pilots in the air within this many airframe reaches of a pad keep its owner from taking off. */
const PAD_CLEAR_REACHES = 6;

/** No other pilot in the air close to this pilot's pad. */
const padClear = (s: Snapshot, others: readonly Nearby[]): boolean => {
  const range = Math.max(20, PAD_CLEAR_REACHES * footprintFor(s.config));
  const [hx, , hz] = s.mission.home;
  return others.every(
    (o) =>
      Math.hypot(o.pos[0] - hx, o.pos[2] - hz) > range ||
      !(AIRBORNE.has(o.phase) || (o.ready && o.lane < (s.lane ?? 0))),
  );
};

/** Another pilot in the air, as the others see it. */
interface Nearby {
  readonly pos: Vec3;
  readonly lane: number;
  readonly phase: Mission['phase'];
  /** On the pad with the countdown done: about to take off. */
  readonly ready: boolean;
}

const AIRBORNE: ReadonlySet<Mission['phase']> = new Set([
  'takeoff',
  'cruise',
  'returning',
  'landing',
]);

const inAirNow = (others: readonly Nearby[]): readonly Nearby[] =>
  others.filter((o) => AIRBORNE.has(o.phase));

/** Pilots in a sortie keep apart by height: a pilot rises above each lower-lane pilot within this horizontal range. */
export const SEPARATION_RANGE = 160;
export const SEPARATION_LIFT = 20;

const separationLift = (s: Snapshot, others: readonly Nearby[]): number =>
  s.config.mode !== 'sortie'
    ? 0
    : SEPARATION_LIFT *
      inAirNow(others).filter(
        (o) =>
          o.lane < (s.lane ?? 0) &&
          Math.hypot(o.pos[0] - s.drone.pos[0], o.pos[2] - s.drone.pos[2]) < SEPARATION_RANGE,
      ).length;

/** Vertical acceleration of takeoff and landing, m/s squared. */
const TAKEOFF_ACCEL = 6;
/** Braking on the final approach, m/s squared. */
const LAND_BRAKE = 12;
/** Slowest the drone is flown, m/s; keeps the steering maths finite as it builds speed. */
const MIN_SPEED = 6;

/**
 * Altitude after limiting vertical acceleration, so climbs and descents ease in and out. It may lag the
 * controller's demand, but never drops below half the demanded clearance above the ground.
 */
const smoothHeight = (
  s: Snapshot,
  terrain: Terrain,
  cfg: Config,
  py: number,
  demanded: number,
  x: number,
  z: number,
  dt: number,
): number => {
  const climb = smoothClimb(
    s.drone.climb ?? 0,
    (demanded - py) / dt,
    dt,
    cfg.mode === 'sortie' ? 1 : AGILE_CLIMB_FACTOR,
  );
  const smoothed = py + climb * dt;
  const g = Math.max(terrain.waterLevel, groundBeneath(terrain, x, z, footprintFor(cfg)));
  if (demanded <= g) return demanded;
  // A sortie keeps its full minimum clearance; the small FPV modes may lag by up to half of theirs.
  const floor =
    cfg.mode === 'sortie' ? Math.min(demanded, g + MIN_CLEARANCE) : g + 0.5 * (demanded - g);
  return Math.max(smoothed, floor);
};

const fly = (
  s: Snapshot,
  terrain: Terrain,
  dt: number,
  target: Vec3,
  others: readonly Nearby[],
): Motion => {
  const { config: cfg } = s;
  const [px, py, pz] = s.drone.pos;
  const gate = gateTarget(s, terrain);
  const aim = gate === null ? target : aimAt(gate, s.drone.pos);
  const dx = aim[0] - px;
  const dz = aim[2] - pz;
  const distance = Math.hypot(dx, dz);
  const cruise = speedFor(cfg);
  // Speed builds up from the pad rather than starting at full cruise.
  const speed = Math.max(MIN_SPEED, approach(s.drone.speed ?? MIN_SPEED, cruise, SPEED_ACCEL * dt));
  const gust = gustAt(s.time, s.weather.rain);
  // On a track the autopilot points into the wind by the crab angle that holds its line (it is told the wind).
  // On a forest run the trunks and limbs around the drone are what it steers through.
  const around = cfg.mode === 'run' ? near(runFor(terrain, cfg.seed), px, pz, speed * 2.2) : null;
  // Lining up for a tunnel, or inside one, the drone is drawn onto its axis rather than just towards the far waypoint.
  const carrot =
    cfg.mode === 'run'
      ? tunnelCarrot(runFor(terrain, cfg.seed).tunnels, s.drone.pos, s.drone.heading)
      : null;
  const toward = carrot ? Math.atan2(carrot[2] - pz, carrot[0] - px) : Math.atan2(dz, dx);
  const steered =
    cfg.mode === 'track'
      ? steerClear(
          toward,
          s.drone.pos,
          avoidables(trackFor(terrain, cfg.seed), gateIndex(s, terrain)),
          AIRFRAME_RADIUS,
        )
      : around
        ? planCourse(
            terrain,
            s.drone.pos,
            s.drone.heading,
            toward,
            speed,
            [cfg.windX + gust[0], cfg.windZ + gust[1]],
            animalsFor(terrain, cfg.seed),
            s.time,
            around,
            runFor(terrain, cfg.seed).tunnels,
          )
        : toward;
  const course = steered;
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
      : turnSmoothly(
          s.drone.heading,
          s.drone.yawRate ?? 0,
          course - crab,
          turnRateFor(cfg, MAX_TURN_RATE),
          dt,
          cfg.mode === 'sortie' ? YAW_ACCEL_PER_RATE : AGILE_YAW_ACCEL_PER_RATE,
        ).heading;
  const air: Vec2 = [Math.cos(heading) * speed, Math.sin(heading) * speed];
  const nx = px + (air[0] + cfg.windX + gust[0]) * dt;
  const nz = pz + (air[1] + cfg.windZ + gust[1]) * dt;
  const ny =
    cfg.mode === 'track'
      ? nextTrackAltitude(terrain, py, nx, nz, target[1], dt)
      : cfg.mode === 'run'
        ? nextRunAltitude(
            terrain,
            py,
            nx,
            nz,
            heading,
            tunnelHold(runFor(terrain, cfg.seed).tunnels, s.drone.pos, s.drone.heading),
            dt,
          )
        : nextAltitude(
            terrain,
            py,
            nx,
            nz,
            heading,
            dt,
            (s.lane ?? 0) * LANE_SPACING + separationLift(s, others),
          );
  const pos: Vec3 = [nx, smoothHeight(s, terrain, cfg, py, ny, nx, nz, dt), nz];
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
      ? Math.max(groundBeneath(terrain, px, pz, AIRFRAME_RADIUS), terrain.waterLevel) +
        TRACK_TAKEOFF
      : s.mission.home[1] + CLEARANCE;
  // Spool up, then ease off as the hover height is reached.
  const rate = approach(
    s.drone.climb ?? 0,
    Math.min(TAKEOFF_CLIMB, Math.max(0.8, 1.5 * (top - py))),
    TAKEOFF_ACCEL * dt,
  );
  const next = Math.min(top, py + rate * dt);
  return holding(s, [px, next, pz], s.drone.heading, next >= top);
};

const land = (s: Snapshot, terrain: Terrain, dt: number): Motion => {
  const [px, py, pz] = s.drone.pos;
  const [hx, hy, hz] = s.mission.home;
  const distance = Math.hypot(hx - px, hz - pz);
  // Brake smoothly onto the pad and ease the descent off just above the ground.
  const speed = approach(
    s.drone.speed ?? LAND_SPEED,
    Math.min(LAND_SPEED, Math.max(1.5, Math.sqrt(2 * LAND_BRAKE * distance))),
    LAND_BRAKE * dt,
  );
  const stride = Math.min(distance, speed * dt);
  const k = distance < 1e-6 ? 0 : stride / distance;
  const ground = Math.max(hy, terrain.heightAt(px, pz));
  const sink = approach(
    -(s.drone.climb ?? 0),
    Math.min(LAND_DESCENT, Math.max(0.6, 1.2 * (py - ground))),
    TAKEOFF_ACCEL * dt,
  );
  const ny = Math.max(ground, py - sink * dt);
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

const moveFor = (s: Snapshot, terrain: Terrain, dt: number, others: readonly Nearby[]): Motion => {
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
      return fly(s, terrain, dt, s.waypoints[0], others);
    case 'cruise':
      return fly(s, terrain, dt, s.waypoints[s.drone.wp], others);
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
  if (s.config.mode === 'run') {
    // Reaching the goal closes a run, timed from take-off.
    if (s.drone.wp !== goalIndex(runFor(terrain, s.config.seed)) || m.lapStart === null) return m;
    const time = s.time - m.lapStart;
    return {
      ...m,
      laps: m.laps + 1,
      lastLap: time,
      bestLap: m.bestLap === null ? time : Math.min(m.bestLap, time),
    };
  }
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
const transition = (
  s: Snapshot,
  motion: Motion,
  terrain: Terrain,
  others: readonly Nearby[],
): Snapshot => {
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
      // A pilot holds on the pad while another is in the air close by, so two never climb out together.
      return m.groundLeft <= 0 && padClear(s, others)
        ? goTo('takeoff', { trip: 0, outcome: null })
        : s;
    case 'takeoff':
      return motion.arrived
        ? goTo('cruise', s.config.mode === 'run' ? { lapStart: s.time } : {})
        : s;
    case 'cruise': {
      // With rivals on the course the run is one-way: out and back along one corridor would meet head-on in
      // the tunnels, so a pilot who reaches the goal is collected from it, as a wreck is, and set down on its pad.
      if (
        s.config.mode === 'run' &&
        s.config.rivals > 0 &&
        wp === goalIndex(runFor(terrain, s.config.seed)) &&
        motion.arrived
      ) {
        return touchDown({ ...s, mission: timeLap(s, terrain) }, terrain);
      }
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
  others: readonly Nearby[],
): CrashCause | null => {
  const { pos } = s.drone;
  if (aloft && hitsCraft(pos, s.config.seed, s.time, terrain)) return 'craft';
  // Two pilots whose airframes touch both crash: each is checked against the other's position.
  const reach = 2 * footprintFor(s.config);
  if (
    aloft &&
    inAirNow(others).some(
      (o) => Math.hypot(o.pos[0] - pos[0], o.pos[1] - pos[1], o.pos[2] - pos[2]) < reach,
    )
  ) {
    return 'craft';
  }
  const arena = terrain.arena;
  if (
    aloft &&
    arena &&
    Math.hypot(pos[0] - arena.centre[0], pos[2] - arena.centre[2]) >
      arena.radius - AIRFRAME_RADIUS &&
    pos[1] < arena.centre[1] + FENCE_HEIGHT
  ) {
    return 'fence';
  }
  if (aloft && s.config.mode === 'track') {
    const track = trackFor(terrain, s.config.seed);
    if (track.obstacles.some((o) => hitsObstacle(o, pos))) return 'obstacle';
    if (track.sky.some((o) => hitsSky(o, pos))) return 'obstacle';
    if (track.gates.some((g) => hitsGate(g, pos))) return 'gate';
  }
  if (aloft && s.config.mode === 'run' && strikes(runFor(terrain, s.config.seed), pos)) {
    return 'obstacle';
  }
  if (
    aloft &&
    s.config.mode === 'run' &&
    animalsFor(terrain, s.config.seed).some((a) => hitsAnimal(animalAt(terrain, a, s.time), pos))
  ) {
    return 'animal';
  }
  const footprint = footprintFor(s.config);
  if (inAir && hasHitTerrain(pos, terrain, footprint)) {
    return groundBeneath(terrain, pos[0], pos[2], footprint) <= terrain.waterLevel
      ? 'water'
      : 'terrain';
  }
  return null;
};

const stepAgent = (
  s: Snapshot,
  terrain: Terrain,
  dt: number,
  others: readonly Nearby[],
): Snapshot => {
  const { config: cfg } = s;
  const { phase } = s.mission;
  const inAir = phase === 'cruise' || phase === 'returning';
  const aloft = inAir || phase === 'takeoff' || phase === 'landing';
  const cause = strikeCause(s, terrain, inAir, aloft, others);
  if (cause !== null) {
    const gust = gustAt(s.time, s.weather.rain);
    return loseFlight(s, [cfg.windX + gust[0], cfg.windZ + gust[1]], 'impact', cause);
  }
  const motion = moveFor(s, terrain, dt, others);
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
      ...(flying && !motion.wreck
        ? {
            yawRate: wrapAngle(motion.heading - s.drone.heading) / dt,
            climb: (motion.pos[1] - s.drone.pos[1]) / dt,
            speed: motion.airSpeed,
          }
        : { yawRate: 0, climb: 0, speed: undefined }),
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
  return transition(moved, motion, terrain, others);
};

/** A rival's own state as a snapshot of its own world, so the one flight model serves every pilot. */
const viewOf = (s: Snapshot, a: Agent): Snapshot => ({
  ...s,
  rng: a.rng,
  waypoints: a.waypoints,
  path: a.path,
  lane: a.lane,
  drone: a.drone,
  ekf: a.ekf,
  mission: a.mission,
  rivals: [],
});

const agentOf = (s: Snapshot): Agent => ({
  rng: s.rng,
  waypoints: s.waypoints,
  path: s.path,
  lane: s.lane,
  drone: s.drone,
  ekf: s.ekf,
  mission: s.mission,
});

/**
 * Advances the world one step: the main drone and every rival fly by the same rules. Weather and
 * time are the world's and move once, with the main drone; pilots in the air can hit each other.
 */
export const step = (s: Snapshot, terrain: Terrain, dt: number): Snapshot => {
  if (s.rivals.length === 0) return stepAgent(s, terrain, dt, []);
  const pilots: readonly Agent[] = [s, ...s.rivals];
  const nearby = pilots.map((a): Nearby => ({
    pos: a.drone.pos,
    lane: a.lane ?? 0,
    phase: a.mission.phase,
    ready: a.mission.phase === 'grounded' && a.mission.groundLeft <= 0,
  }));
  const othersOf = (k: number): readonly Nearby[] => nearby.filter((_, j) => j !== k);
  const main = stepAgent(s, terrain, dt, othersOf(0));
  const rivals = s.rivals.map((r, i): Rival => ({
    ...r,
    ...agentOf(stepAgent(viewOf(s, r), terrain, dt, othersOf(i + 1))),
  }));
  return { ...main, rivals };
};

/** Sortie and track use different pads and routes, so changing mode starts a fresh flight from the new pad. */
const switchMode = (
  s: Snapshot,
  config: Config,
  terrain: Terrain,
): readonly [Snapshot, Terrain] => {
  const home = padFor(config, terrain);
  // Seeded by the map, so a shared link opens on the same route.
  const [waypoints] = routeFor(config, terrain, config.seed, home);
  const { successes, failures, lost, crashed, totalTrip, laps, bestLap } = s.mission;
  return [
    {
      ...s,
      config,
      path: undefined,
      ...onPad(home, waypoints),
      rivals: makeRivals(config, terrain, home),
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
  if (terrainKey(config) === terrainKey(s.config)) {
    const rivals =
      config.rivals === s.config.rivals ? s.rivals : makeRivals(config, terrain, s.mission.home);
    return [{ ...s, config, rivals }, terrain];
  }
  const next = createTerrain(config);
  const home = padFor(config, next);
  const grounded = s.mission.phase === 'grounded';
  // A run's goal depends on the terrain, so a new terrain means a new route.
  const [fresh, rng] = config.mode === 'run' ? routeFor(config, next, s.rng, home) : [null, s.rng];
  return [
    {
      ...s,
      config,
      rng,
      waypoints: fresh ?? [
        seatWaypoint(next, home[0], home[2]),
        ...retarget(s.waypoints.slice(1), next),
      ],
      drone: grounded ? { ...s.drone, pos: home } : s.drone,
      mission: { ...s.mission, home },
      rivals: makeRivals(config, next, home),
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
      path: undefined,
      drone: fresh.drone,
      ekf: fresh.ekf,
      rivals: fresh.rivals,
      mission: { ...fresh.mission, successes, failures, lost, crashed, totalTrip, laps, bestLap },
    },
    terrain,
  ];
};

/** Index to head for when a new route replaces the old one mid-flight. */
const resumeIndex = (s: Snapshot, preferred: number): number =>
  s.mission.phase === 'returning' || s.mission.phase === 'landing' ? 0 : preferred;

/** Plans the sortie route for `pathSeed`; the same seed on the same map always gives the same route. */
export const setPath = (s: Snapshot, terrain: Terrain, pathSeed: number): Snapshot => {
  const [waypoints] = routeFor(s.config, terrain, pathSeed, s.mission.home);
  return {
    ...s,
    waypoints,
    path: s.config.mode === 'sortie' ? pathSeed : undefined,
    drone: { ...s.drone, wp: resumeIndex(s, 1) },
    mission: { ...s.mission, attempt: 0 },
  };
};

export const randomisePath = (s: Snapshot, terrain: Terrain): Snapshot => {
  const [pathSeed, rng] = drawSeed(s.rng);
  return setPath({ ...s, rng }, terrain, pathSeed);
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
    path: 'river',
    drone: { ...s.drone, wp: resumeIndex(s, Math.max(1, nearestWaypoint(waypoints, s.drone.pos))) },
    mission: { ...s.mission, attempt: 0 },
  };
};
