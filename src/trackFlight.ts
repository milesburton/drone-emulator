import { groundBeneath, MAX_CLIMB, MAX_DESCENT, CLIMB_RESPONSE } from './altitude';
import { routeEnergy } from './mission';
import type { Terrain } from './terrain';
import { RUN_SPEED, RUN_TURN_RATE, type Branch } from './forestRun';
import { trackFor, type Gate, type Obstacle, type Track } from './track';
import type { Config, Vec3 } from './types';

/** Speed through the air on the track, m/s (about 160 km/h): FPV racers are fast, and a quick course is the point. */
export const TRACK_SPEED = 45;
/** Fastest the drone turns on the track, radians per second: a racer corners harder than a survey drone, about a 19 m radius at speed. */
export const TRACK_TURN_RATE = 2.4;
/** Closest the airframe's footprint may come to the ground on the track, metres. */
export const TRACK_FLOOR = 5;
/** Height above the pad that a track takeoff climbs to before heading for the first gate. */
export const TRACK_TAKEOFF = 10;
/** Most laps one sortie plans, however little a lap costs. */
export const MAX_LAPS = 10;
/** Charge a track sortie may plan to use, as for sorties. */
const TRACK_BUDGET = 0.7;

/** Speed through the air for this mode. */
export const speedFor = (cfg: Config): number =>
  cfg.mode === 'track' ? TRACK_SPEED : cfg.mode === 'run' ? RUN_SPEED : 36;

/** Fastest turn for this mode, radians per second. */
export const turnRateFor = (cfg: Config, sortieRate: number): number =>
  cfg.mode === 'track' ? TRACK_TURN_RATE : cfg.mode === 'run' ? RUN_TURN_RATE : sortieRate;

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
  look = LOOK,
): number => {
  const ux = Math.cos(course);
  const uz = Math.sin(course);
  const swerve = obstacles.reduce((sum, o) => {
    const rx = o.pos[0] - from[0];
    const rz = o.pos[2] - from[2];
    const ahead = rx * ux + rz * uz;
    const side = -rx * uz + rz * ux;
    const need = o.radius + reach + ROOM;
    if (ahead <= 0 || ahead > look || Math.abs(side) >= need) return sum;
    const weight = (1 - Math.abs(side) / need) * (1 - 0.5 * (ahead / look));
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

/** Something floating or reaching into the air to go round, over or under: a sphere at `pos`. */
export interface Hazard {
  readonly pos: Vec3;
  readonly radius: number;
  /** Metres per second, for things that move; their position is predicted to when the drone arrives. */
  readonly vel?: Vec3;
  /** Clearance wanted beyond the airframe's reach; defaults to ROOM. */
  readonly room?: number;
}

const BRANCH_STEP = 3;
/** Clearance wanted over a limb, beyond the airframe's reach, metres. */
const LIMB_ROOM = 4;

/** A limb as a row of spheres along it, so the drone can dodge it like any other hazard. */
export const limbHazards = (branches: readonly Branch[]): readonly Hazard[] =>
  branches.flatMap((b) => {
    const length = Math.hypot(b.to[0] - b.from[0], b.to[1] - b.from[1], b.to[2] - b.from[2]);
    const n = Math.max(1, Math.ceil(length / BRANCH_STEP));
    return Array.from({ length: n + 1 }, (_, i): Hazard => {
      const t = i / n;
      return {
        pos: [
          b.from[0] + (b.to[0] - b.from[0]) * t,
          b.from[1] + (b.to[1] - b.from[1]) * t,
          b.from[2] + (b.to[2] - b.from[2]) * t,
        ],
        radius: b.radius,
        room: LIMB_ROOM,
      };
    });
  });

/** How far ahead the drone looks for hazards in the air, seconds of flight. */
const HAZARD_LOOK = 2.4;
/** Most the drone shifts its height to clear a hazard, metres. */
const MAX_DODGE_CLIMB = 28;

/**
 * Bends `course` sideways, and returns a height change, to clear hazards ahead and no further off than `limit` (the target). Each hazard in the
 * way (close to the line sideways and in height, within a couple of seconds' flight) pushes the
 * drone away from it both ways; the nearer and the more squarely ahead, the harder.
 */
export const dodge = (
  course: number,
  from: Vec3,
  speed: number,
  hazards: readonly Hazard[],
  reach: number,
  limit = Infinity,
): { readonly course: number; readonly climb: number } => {
  const ux = Math.cos(course);
  const uz = Math.sin(course);
  const look = speed * HAZARD_LOOK;
  const net = hazards.reduce(
    (sum, h) => {
      const rx0 = h.pos[0] - from[0];
      const rz0 = h.pos[2] - from[2];
      const ahead0 = rx0 * ux + rz0 * uz;
      const eta = Math.max(0, ahead0) / speed;
      const rx = rx0 + (h.vel ? h.vel[0] * eta : 0);
      const rz = rz0 + (h.vel ? h.vel[2] * eta : 0);
      const dy = h.pos[1] + (h.vel ? h.vel[1] * eta : 0) - from[1];
      const ahead = rx * ux + rz * uz;
      const side = -rx * uz + rz * ux;
      const need = h.radius + reach + (h.room ?? ROOM);
      if (
        ahead <= 0 ||
        ahead > look ||
        ahead > limit ||
        Math.abs(side) >= need ||
        Math.abs(dy) >= need
      )
        return sum;
      const weight = (1 - Math.abs(side) / need) * (1 - 0.5 * (ahead / look));
      return {
        turn: sum.turn - Math.sign(side || 1) * weight * 1.4,
        // Going over or under is the cheaper dodge: shift by what clears the hazard, away from its side.
        climb: sum.climb - Math.sign(dy || 1) * (need - Math.abs(dy) + 2) * weight,
      };
    },
    { turn: 0, climb: 0 },
  );
  return {
    course: course + Math.max(-MAX_SWERVE, Math.min(MAX_SWERVE, net.turn)),
    climb: Math.max(-MAX_DODGE_CLIMB, Math.min(MAX_DODGE_CLIMB, net.climb)),
  };
};

const LIMB_SAMPLES = 8;

/**
 * Bends `course` round limbs ahead. A limb is one obstacle, not a row of points: the drone works out
 * which tip it can pass soonest and heads for that side, so a limb lying across the line never
 * pushes both ways at once. Limbs well above or below the drone's height are ignored.
 */
export const steerAroundLimbs = (
  course: number,
  from: Vec3,
  speed: number,
  branches: readonly Branch[],
  reach: number,
  limit = Infinity,
): number => {
  const ux = Math.cos(course);
  const uz = Math.sin(course);
  const look = Math.min(limit, speed * HAZARD_LOOK);
  const turn = branches.reduce((sum, b) => {
    const need = b.radius + reach + LIMB_ROOM;
    const points = Array.from({ length: LIMB_SAMPLES + 1 }, (_, i) => {
      const t = i / LIMB_SAMPLES;
      const rx = b.from[0] + (b.to[0] - b.from[0]) * t - from[0];
      const rz = b.from[2] + (b.to[2] - b.from[2]) * t - from[2];
      const y = b.from[1] + (b.to[1] - b.from[1]) * t;
      return { ahead: rx * ux + rz * uz, side: -rx * uz + rz * ux, dy: y - from[1] };
    }).filter((p) => p.ahead > 0 && p.ahead < look && Math.abs(p.dy) < need);
    if (points.length === 0) return sum;
    const sides = points.map((p) => p.side);
    const low = Math.min(...sides);
    const high = Math.max(...sides);
    // The limb is in the way only if it covers the line (or comes within `need` of it).
    if (low >= need || high <= -need) return sum;
    // Shift to pass beyond one tip, whichever is nearer.
    const toLow = low - need;
    const toHigh = high + need;
    const shift = Math.abs(toLow) < Math.abs(toHigh) ? toLow : toHigh;
    const nearest = Math.min(...points.map((p) => p.ahead));
    const weight = 1 - 0.5 * (nearest / look);
    return sum + Math.sign(shift) * Math.min(1, 0.6 + Math.abs(shift) / (2 * need)) * weight * 1.6;
  }, 0);
  return course + Math.max(-MAX_SWERVE, Math.min(MAX_SWERVE, turn));
};

/** Clear metres the drone wants past a trunk's skin beyond the airframe's reach before easing off. */
const TRUNK_HARD = 5;
/** Metres over which the push away from a trunk fades out. */
const TRUNK_FADE = 4;

/**
 * Bends `course` away from trunks ahead. The push is at full strength while the drone is within
 * the airframe's reach plus `TRUNK_HARD` of a trunk and fades out over the next `TRUNK_FADE`
 * metres, so it cannot settle into a skim along the trunk.
 */
export const steerTrunks = (
  course: number,
  from: Vec3,
  trunks: readonly Obstacle[],
  reach: number,
  look: number,
): number => {
  const ux = Math.cos(course);
  const uz = Math.sin(course);
  const swerve = trunks.reduce((sum, o) => {
    const rx = o.pos[0] - from[0];
    const rz = o.pos[2] - from[2];
    const ahead = rx * ux + rz * uz;
    const side = -rx * uz + rz * ux;
    const full = o.radius + reach + TRUNK_HARD;
    const need = full + TRUNK_FADE;
    if (ahead <= 0 || ahead > look || Math.abs(side) >= need) return sum;
    const weight = Math.min(1, (need - Math.abs(side)) / TRUNK_FADE) * (1 - 0.3 * (ahead / look));
    return sum - Math.sign(side || 1) * weight * 1.6;
  }, 0);
  return course + Math.max(-MAX_SWERVE, Math.min(MAX_SWERVE, swerve));
};
