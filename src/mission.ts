import { seatWaypoint } from './altitude';
import { ranges } from './rng';
import { distanceTo } from './routes';
import type { Terrain } from './terrain';
import type { Config, FailureReason, Mission, Phase, Vec2, Vec3 } from './types';
import { generateWaypoints } from './waypoints';

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
/** Failed attempts on one route before a new one is planned. */
export const MAX_ATTEMPTS = 3;
export const TAKEOFF_CLIMB = 4;
export const LAND_DESCENT = 3;
export const LAND_SPEED = 8;
/** Pad needs this much dry margin, and ground this flat, to be usable. */
const PAD_MIN_ABOVE_WATER = 3;
const PAD_PROBE = 12;
const PAD_RING_STEP = 20;
const PAD_RINGS = 30;
const PAD_SALT = 0x3c6ef372;
const MIN_GROUNDSPEED = 5;
const LAND_APPROACH_TIME = 3;
const HIGH_WIND = 8;
const HEAVY_RAIN = 0.2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Battery fraction used per second. Hovering takeoffs and landings, climbs and rain all cost extra. */
export const drainRate = (phase: Phase, climbRate: number, rain: number): number => {
  if (phase === 'grounded') return 0;
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

/** A fresh route that starts and ends over the pad and fits the battery. */
export const planRoute = (
  cfg: Config,
  terrain: Terrain,
  rng: number,
  home: Vec3,
  airSpeed: number,
): readonly [readonly Vec3[], number] => {
  const [generated, r] = generateWaypoints(cfg, terrain, rng);
  const route = [seatWaypoint(terrain, home[0], home[2]), ...generated.slice(1)];
  return [fitToRange(route, routeLimit(airSpeed)), r];
};

interface PadStandard {
  readonly slope: number;
  readonly river: number;
  readonly road: number;
}

/** Strictest first; hilly or wet seeds fall through to the looser ones. */
const PAD_STANDARDS: readonly PadStandard[] = [
  { slope: 1.5, river: 60, road: 15 },
  { slope: 4, river: 20, road: 5 },
  { slope: 12, river: 0, road: 0 },
];

const usablePad = (terrain: Terrain, x: number, z: number, standard: PadStandard): boolean => {
  const h = terrain.heightAt(x, z);
  const { river, roads } = terrain.routes;
  return (
    h > terrain.waterLevel + PAD_MIN_ABOVE_WATER &&
    [
      [PAD_PROBE, 0],
      [-PAD_PROBE, 0],
      [0, PAD_PROBE],
      [0, -PAD_PROBE],
    ].every(([dx, dz]) => Math.abs(terrain.heightAt(x + dx, z + dz) - h) <= standard.slope) &&
    (!river || distanceTo(river, x, z) > standard.river) &&
    roads.every((road) => distanceTo(road, x, z) > standard.road)
  );
};

/**
 * Launch pad: the nearest ground meeting the strictest standard any candidate meets, searched in
 * widening rings round a seed-chosen spot; failing all standards, the highest candidate.
 */
export const findPad = (terrain: Terrain, seed: number): Vec3 => {
  const half = terrain.cfg.worldSize / 2;
  const [[cx, cz]] = ranges(seed ^ PAD_SALT, 2, -0.3 * half, 0.3 * half);
  const limit = 0.4 * terrain.cfg.worldSize;
  const candidates = Array.from({ length: PAD_RINGS + 1 }, (_, ring) => {
    const radius = ring * PAD_RING_STEP;
    const count = Math.max(1, ring * 8);
    return Array.from({ length: count }, (_, k): Vec2 => {
      const angle = (2 * Math.PI * k) / count;
      return [cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius];
    });
  })
    .flat()
    .filter(([px, pz]) => Math.abs(px) <= limit && Math.abs(pz) <= limit);
  const highest = candidates.reduce((best, c) =>
    terrain.heightAt(c[0], c[1]) > terrain.heightAt(best[0], best[1]) ? c : best,
  );
  const [x, z] =
    PAD_STANDARDS.map((standard) =>
      candidates.find(([px, pz]) => usablePad(terrain, px, pz, standard)),
    ).find((c) => c !== undefined) ?? highest;
  return [x, terrain.heightAt(x, z), z];
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
  lastFailure: null,
});
