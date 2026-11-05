import { flightLine, seatWaypoint } from './altitude';
import { searchPad } from './pad';
import type { Terrain } from './terrain';
import type { Config, FailureReason, Mission, Phase, Vec2, Vec3 } from './types';
import { generateWaypoints } from './waypoints';

/** The pad the terrain was levelled for; falls back to a search for terrain built without one. */
export const findPad = (terrain: Terrain, seed: number): Vec3 =>
  terrain.pad ?? searchPad(terrain, seed);

/** Seconds of cruise one full battery gives. */
export const ENDURANCE = 360;
/** Charge always kept back for the trip home. */
export const RESERVE = 0.1;
/**
 * Share of the nominal range a route may use. Planning to the full range less the 10% reserve
 * would leave nothing for takeoff, landing, climbs and headwinds, so those get their own 20%.
 */
export const ROUTE_FRACTION = 0.7;
/** Seconds on the pad between landing and the next takeoff. */
export const GROUND_TIME = 3;
/** Seconds a crashed drone lies where it hit before it is set back on the pad to try again. */
export const CRASH_TIME = 10;
/** Failed attempts on one route before a new one is planned. */
export const MAX_ATTEMPTS = 3;
export const TAKEOFF_CLIMB = 8;
export const LAND_DESCENT = 5;
export const LAND_SPEED = 12;
const MIN_GROUNDSPEED = 5;
const LAND_APPROACH_TIME = 3;
const HIGH_WIND = 8;
const HEAVY_RAIN = 0.2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Battery fraction used per second. Hovering takeoffs and landings, climbs and rain all cost extra. */
export const drainRate = (phase: Phase, climbRate: number, rain: number): number => {
  if (phase === 'grounded' || phase === 'lost') return 0;
  const hover = phase === 'takeoff' || phase === 'landing' ? 1.3 : 1;
  const climb = 1 + 0.5 * clamp01(climbRate / 10);
  return (hover * climb * (1 + 0.5 * rain)) / ENDURANCE;
};

/** Longest round trip, in metres, a route may be planned to. */
export const routeLimit = (airSpeed: number): number => airSpeed * ENDURANCE * ROUTE_FRACTION;

const legLength = ([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): number =>
  Math.hypot(bx - ax, by - ay, bz - az);

/** Length of the closed route, including the leg back to the first waypoint (the pad). */
export const routeLength = (waypoints: readonly Vec3[]): number =>
  waypoints.reduce((sum, w, i) => sum + legLength(w, waypoints[(i + 1) % waypoints.length]), 0);

/** Drops waypoints from the end until the round trip fits `limit`, always keeping the pad and one more. */
export const fitToRange = (waypoints: readonly Vec3[], limit: number): readonly Vec3[] =>
  waypoints.length > 2 && routeLength(waypoints) > limit
    ? fitToRange(waypoints.slice(0, -1), limit)
    : waypoints;

/** Candidate waypoints planned per route; only as many as fit the battery are flown. */
const CANDIDATES = 40;
const BISECTIONS = 12;
/** Charge a planned route may use: the rest is the reserve, so a sortie lands at about 10% or less. */
export const ENERGY_BUDGET = 0.7;
/** Rain the plan allows for: the weather is wet about half the time, so a plan for dry air would often run short. */
export const PLANNED_RAIN = 0.6;
/** Charge spent on takeoff and landing hovers, which the cruise legs do not count. */
const HOVER_OVERHEAD = 0.04;

/** Charge a closed route costs in light rain, using the same drain model as the flight, climbs included. */
export const routeEnergy = (
  waypoints: readonly Vec3[],
  terrain: Terrain,
  airSpeed: number,
): number => {
  const line = flightLine(waypoints, terrain);
  return (
    HOVER_OVERHEAD +
    line.reduce((sum, p, i) => {
      const q = line[(i + 1) % line.length];
      const time = legLength(p, q) / airSpeed;
      return sum + (time > 0 ? drainRate('cruise', (q[1] - p[1]) / time, PLANNED_RAIN) * time : 0);
    }, 0)
  );
};

/**
 * Builds the round trip from `home` by taking candidates in order while the loop still costs no more
 * than `budget`. The first candidate that would not fit is pulled back along its leg until the loop
 * just fits, so the route uses nearly all of the allowance instead of stopping short of it.
 */
export const fillToBudget = (
  home: Vec3,
  candidates: readonly Vec3[],
  budget: number,
  cost: (route: readonly Vec3[]) => number,
  seat: (x: number, z: number) => Vec3,
): readonly Vec3[] =>
  candidates.reduce<{ route: readonly Vec3[]; done: boolean }>(
    (acc, cand) => {
      if (acc.done) return acc;
      const prev = acc.route[acc.route.length - 1];
      if (cost([...acc.route, cand]) <= budget) return { route: [...acc.route, cand], done: false };
      const point = (t: number): Vec3 =>
        seat(prev[0] + (cand[0] - prev[0]) * t, prev[2] + (cand[2] - prev[2]) * t);
      const t = Array.from({ length: BISECTIONS }).reduce<readonly [number, number]>(
        ([lo, hi]) => {
          const mid = (lo + hi) / 2;
          return cost([...acc.route, point(mid)]) <= budget ? [mid, hi] : [lo, mid];
        },
        [0, 1],
      )[0];
      return { route: t > 0.05 ? [...acc.route, point(t)] : acc.route, done: true };
    },
    { route: [home], done: false },
  ).route;

/** A fresh route that starts and ends over the pad and uses nearly all of the battery allowance. */
export const planRoute = (
  cfg: Config,
  terrain: Terrain,
  rng: number,
  home: Vec3,
  airSpeed: number,
): readonly [readonly Vec3[], number] => {
  const [generated, r] = generateWaypoints(cfg, terrain, rng, CANDIDATES);
  const start = seatWaypoint(terrain, home[0], home[2]);
  const route = fillToBudget(
    start,
    generated.slice(1),
    ENERGY_BUDGET,
    (w) => routeEnergy(w, terrain, airSpeed),
    (x, z) => seatWaypoint(terrain, x, z),
  );
  // Always keep the pad and at least one more point.
  return [route.length > 1 ? route : [start, generated[1]], r];
};

/**
 * Charge needed to get from `pos` to the pad and land: the leg flown at the speed the wind allows,
 * then the descent. Rain makes both dearer.
 */
export const returnEnergy = (
  pos: Vec3,
  home: Vec3,
  wind: Vec2,
  rain: number,
  airSpeed: number,
): number => {
  const dx = home[0] - pos[0];
  const dz = home[2] - pos[2];
  const distance = Math.hypot(dx, dz);
  const along = distance < 1e-6 ? 0 : (wind[0] * dx + wind[1] * dz) / distance;
  const groundSpeed = Math.max(MIN_GROUNDSPEED, airSpeed + along);
  const descent = Math.max(0, pos[1] - home[1]) / LAND_DESCENT + LAND_APPROACH_TIME;
  return (
    (distance / groundSpeed) * drainRate('cruise', 0, rain) +
    descent * drainRate('landing', 0, rain)
  );
};

/** True once the charge left is no more than the trip home plus the reserve. */
export const shouldReturn = (
  battery: number,
  pos: Vec3,
  home: Vec3,
  wind: Vec2,
  rain: number,
  airSpeed: number,
): boolean => battery <= returnEnergy(pos, home, wind, rain, airSpeed) + RESERVE;

/**
 * True once the drone could reach neither the pad nor its current target on the charge left, however
 * it flew: past the point of no return with the reserve spent as well.
 */
export const isLost = (
  battery: number,
  pos: Vec3,
  home: Vec3,
  target: Vec3,
  wind: Vec2,
  rain: number,
  airSpeed: number,
): boolean =>
  battery < returnEnergy(pos, home, wind, rain, airSpeed) &&
  battery < returnEnergy(pos, target, wind, rain, airSpeed);

/** Cheap first guess at what forced the flight home; refine later. */
export const failureReason = (wind: Vec2, rain: number): FailureReason =>
  rain > HEAVY_RAIN ? 'rain' : Math.hypot(wind[0], wind[1]) >= HIGH_WIND ? 'wind' : 'battery';

export const startMission = (home: Vec3): Mission => ({
  phase: 'grounded',
  home,
  battery: 1,
  groundLeft: GROUND_TIME,
  aborted: false,
  attempt: 0,
  trip: 0,
  totalTrip: 0,
  successes: 0,
  failures: 0,
  lost: 0,
  crashed: 0,
  downBy: null,
  outcome: null,
  lastFailure: null,
});
