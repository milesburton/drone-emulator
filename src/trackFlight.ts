import { groundBeneath, MAX_CLIMB, MAX_DESCENT, CLIMB_RESPONSE } from './altitude';
import { routeEnergy } from './mission';
import type { Terrain } from './terrain';
import { trackFor, type Gate, type Obstacle, type Track } from './track';
import type { Config, Vec3 } from './types';

/** Speed through the air on the track, m/s; slower than a sortie so a 24 m gate and tight corners are flyable. */
export const TRACK_SPEED = 20;
/** Closest the airframe's footprint may come to the ground on the track, metres. */
export const TRACK_FLOOR = 5;
/** Height above the pad that a track takeoff climbs to before heading for the first gate. */
export const TRACK_TAKEOFF = 10;
/** Most laps one sortie plans, however little a lap costs. */
export const MAX_LAPS = 10;
/** Charge a track sortie may plan to use, as for sorties. */
const TRACK_BUDGET = 0.7;

/** Speed through the air for this mode. */
export const speedFor = (cfg: Config): number => (cfg.mode === 'track' ? TRACK_SPEED : 36);

/** The pad on a track: the start spot ahead of the first gate. */
export const trackPad = (terrain: Terrain, seed: number): Vec3 => trackFor(terrain, seed).start;

const loop = (track: Track): readonly Vec3[] => track.gates.map((g) => g.pos);

/** How many laps fit the planned battery budget, at least one. */
export const lapsFor = (track: Track, terrain: Terrain): number => {
  const cost = routeEnergy(loop(track), terrain, TRACK_SPEED);
  return Math.max(1, Math.min(MAX_LAPS, Math.floor(TRACK_BUDGET / cost)));
};

/**
 * The route for a track sortie: the pad, then every gate in order for as many laps as the battery
 * allows. Heights are the gates' own, not terrain-following.
 */
export const trackRoute = (terrain: Terrain, seed: number): readonly Vec3[] => {
  const track = trackFor(terrain, seed);
  const gates = loop(track);
  const laps = Array.from({ length: lapsFor(track, terrain) }, () => gates).flat();
  // The first gate again at the end, so the last lap is timed like the others, then the exit point,
  // well clear of that gate so the turn back to the pad does not clip its frame.
  return [track.start, ...laps, gates[0], track.exit];
};

/** Which gate and lap a route waypoint (index into `trackRoute`) is; null for the pad. Gate 0 is the start/finish. */
export const gateAt = (
  wp: number,
  gates: number,
  total = Infinity,
): { gate: number; lap: number } | null =>
  wp <= 0 || wp >= total - 1 ? null : { gate: (wp - 1) % gates, lap: Math.floor((wp - 1) / gates) };

/** Eases altitude towards the gate's own height, never closer to the ground than the track floor. */
export const nextTrackAltitude = (
  terrain: Terrain,
  y: number,
  x: number,
  z: number,
  targetY: number,
  dt: number,
): number => {
  const wanted = (targetY - y) * Math.min(1, dt * CLIMB_RESPONSE);
  const eased = y + Math.max(-MAX_DESCENT * dt, Math.min(MAX_CLIMB * dt, wanted));
  return Math.max(eased, Math.max(groundBeneath(terrain, x, z), terrain.waterLevel) + TRACK_FLOOR);
};

/** The line-up point sits this far before a gate on its axis, metres. */
export const APPROACH = 55;
/** Closer than this to the axis, and the drone can pursue the gate's centre straight; further out it lines up first. */
const ALIGNED = 12;
/** From this far out (along the axis), the drone has time to line up first. */
const LINE_UP_FROM = APPROACH - 8;

/**
 * Where to steer for `gate` from `from`. A drone well off the gate's axis and still far out heads
 * for a line-up point on the axis; once it is close to the axis (or near the gate) it pursues the
 * centre of the opening, which brings it through square and centred. Past the gate's plane (a
 * miss) it heads back for the line-up point to come round again.
 */
export const aimAt = (gate: Gate, from: Vec3): Vec3 => {
  const fx = Math.cos(gate.yaw);
  const fz = Math.sin(gate.yaw);
  const dx = from[0] - gate.pos[0];
  const dz = from[2] - gate.pos[2];
  const along = dx * fx + dz * fz;
  const lat = -dx * fz + dz * fx;
  const lineUp: Vec3 = [gate.pos[0] - fx * APPROACH, gate.pos[1], gate.pos[2] - fz * APPROACH];
  return along > 0 || (along < -LINE_UP_FROM && Math.abs(lat) > ALIGNED) ? lineUp : gate.pos;
};

/** How far ahead the autopilot looks for obstacles, metres, and how much room it wants beside one. */
const LOOK = 90;
const ROOM = 10;
const MAX_SWERVE = 1;

/**
 * Bends `course` away from any obstacle ahead that it would pass too close to: the nearer and
 * more squarely ahead, the harder the swerve, always away from the side the obstacle is on.
 */
export const steerClear = (
  course: number,
  from: Vec3,
  obstacles: readonly Obstacle[],
  reach: number,
): number => {
  const ux = Math.cos(course);
  const uz = Math.sin(course);
  const swerve = obstacles.reduce((sum, o) => {
    const rx = o.pos[0] - from[0];
    const rz = o.pos[2] - from[2];
    const ahead = rx * ux + rz * uz;
    const side = -rx * uz + rz * ux;
    const need = o.radius + reach + ROOM;
    if (ahead <= 0 || ahead > LOOK || Math.abs(side) >= need) return sum;
    const weight = (1 - Math.abs(side) / need) * (1 - 0.5 * (ahead / LOOK));
    return sum - Math.sign(side || 1) * weight * 1.4;
  }, 0);
  return course + Math.max(-MAX_SWERVE, Math.min(MAX_SWERVE, swerve));
};

/**
 * Everything to steer round, as columns: the obstacles and the posts of every gate except the one
 * being flown through (`through`, a gate index, or null when heading for the pad).
 */
export const avoidables = (track: Track, through: number | null): readonly Obstacle[] => [
  ...track.obstacles,
  ...track.gates.flatMap((g, i): readonly Obstacle[] =>
    i === through
      ? []
      : [-1, 1].map((side): Obstacle => ({
          kind: 'pole',
          pos: [
            g.pos[0] - Math.sin(g.yaw) * side * (g.width / 2 + 1),
            g.pos[1],
            g.pos[2] + Math.cos(g.yaw) * side * (g.width / 2 + 1),
          ],
          radius: 1.5,
          height: 0,
        })),
  ),
];
