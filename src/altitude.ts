import type { Terrain } from './terrain';
import type { Vec3 } from './types';

/** Cruise height above the ground the drone aims for. */
export const CLEARANCE = 40;
/** The drone is never allowed closer to the ground than this. */
export const MIN_CLEARANCE = 15;
/** How far ahead, in metres, the terrain is scanned for rises. */
export const LOOKAHEAD = 200;
const LOOKAHEAD_STEP = 10;
/** Altitude response rate, per second; lower is gentler. */
export const CLIMB_RESPONSE = 2;
/** Vertical speed limits in m/s; the drone can sink faster than it can climb. */
export const MAX_CLIMB = 15;
export const MAX_DESCENT = 11;

/** Reach of the airframe from its centre, metres: arms and rotors, so a hillside this close to the side still counts. */
export const FOOTPRINT = 7;
const FOOTPRINT_POINTS = 8;

/** Highest ground under the airframe: the centre and a ring at the reach of the rotors. */
export const groundBeneath = (terrain: Terrain, x: number, z: number): number =>
  Array.from({ length: FOOTPRINT_POINTS }, (_, i) => (i / FOOTPRINT_POINTS) * Math.PI * 2).reduce(
    (best, a) =>
      Math.max(best, terrain.heightAt(x + Math.cos(a) * FOOTPRINT, z + Math.sin(a) * FOOTPRINT)),
    terrain.heightAt(x, z),
  );

/** Highest ground within the look-ahead window along `heading`, so climbs start before the hill. */
export const groundAhead = (terrain: Terrain, x: number, z: number, heading: number): number =>
  Array.from({ length: LOOKAHEAD / LOOKAHEAD_STEP + 1 }, (_, i) => i * LOOKAHEAD_STEP).reduce(
    (best, d) =>
      Math.max(best, terrain.heightAt(x + Math.cos(heading) * d, z + Math.sin(heading) * d)),
    -Infinity,
  );

/** Altitude to aim for at (x, z) flying along `heading`: cruise above the terrain still to come. */
export const targetAltitude = (terrain: Terrain, x: number, z: number, heading: number): number =>
  groundAhead(terrain, x, z, heading) + CLEARANCE;

/**
 * Eases altitude `y` towards the target at a bounded vertical speed, never dipping below the
 * minimum clearance. The easing and speed limit are what make the flight path rise and fall smoothly rather than hug every bump.
 */
export const nextAltitude = (
  terrain: Terrain,
  y: number,
  x: number,
  z: number,
  heading: number,
  dt: number,
): number => {
  const wanted = (targetAltitude(terrain, x, z, heading) - y) * Math.min(1, dt * CLIMB_RESPONSE);
  const eased = y + Math.max(-MAX_DESCENT * dt, Math.min(MAX_CLIMB * dt, wanted));
  return Math.max(eased, groundBeneath(terrain, x, z) + MIN_CLEARANCE);
};

/** Waypoint seated at cruise clearance above the ground. */
export const seatWaypoint = (terrain: Terrain, x: number, z: number): Vec3 => [
  x,
  terrain.heightAt(x, z) + CLEARANCE,
  z,
];

/** Radius of the tightest turn the drone makes: airspeed over maximum turn rate (36 m/s / 1.2 rad/s). */
export const TURN_RADIUS = 30;
/** Samples either side that the drawn altitude is spread over. */
const ALTITUDE_SPREAD = 3;

type Point = readonly [number, number];

const unit = ([x, z]: Point): Point => {
  const length = Math.hypot(x, z) || 1;
  return [x / length, z / length];
};

/** The corner at `b` replaced by the arc the drone flies; reversals and near-straight corners stay sharp. */
const fillet = (a: Point, b: Point, c: Point, radius: number): readonly Point[] => {
  const u1 = unit([a[0] - b[0], a[1] - b[1]]);
  const u2 = unit([c[0] - b[0], c[1] - b[1]]);
  const angle = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (angle < 0.35 || angle > Math.PI - 0.02) return [b];
  const reach = Math.min(
    radius / Math.tan(angle / 2),
    0.5 * Math.hypot(a[0] - b[0], a[1] - b[1]),
    0.5 * Math.hypot(c[0] - b[0], c[1] - b[1]),
  );
  const r = reach * Math.tan(angle / 2);
  const bisector = unit([u1[0] + u2[0], u1[1] + u2[1]]);
  const centre: Point = [
    b[0] + (bisector[0] * r) / Math.sin(angle / 2),
    b[1] + (bisector[1] * r) / Math.sin(angle / 2),
  ];
  const from = Math.atan2(b[1] + u1[1] * reach - centre[1], b[0] + u1[0] * reach - centre[0]);
  const to = Math.atan2(b[1] + u2[1] * reach - centre[1], b[0] + u2[0] * reach - centre[0]);
  const sweep = ((to - from + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) * r) / 6));
  return Array.from({ length: steps + 1 }, (_, k): Point => {
    const theta = from + (sweep * k) / steps;
    return [centre[0] + Math.cos(theta) * r, centre[1] + Math.sin(theta) * r];
  });
};

/** Evenly spaced points round the closed polyline. */
const resample = (loop: readonly Point[], spacing: number): readonly Point[] => {
  const lengths = loop.map(([x, z], i) => {
    const [nx, nz] = loop[(i + 1) % loop.length];
    return Math.hypot(nx - x, nz - z);
  });
  const total = lengths.reduce((sum, l) => sum + l, 0);
  const count = Math.max(2, Math.round(total / spacing));
  return Array.from({ length: count }, (_, k): Point => {
    const target = (total * k) / count;
    const edge = lengths.findIndex(
      (_, i) => lengths.slice(0, i + 1).reduce((sum, l) => sum + l, 0) > target,
    );
    const i = edge < 0 ? lengths.length - 1 : edge;
    const before = lengths.slice(0, i).reduce((sum, l) => sum + l, 0);
    const t = lengths[i] === 0 ? 0 : (target - before) / lengths[i];
    const [x, z] = loop[i];
    const [nx, nz] = loop[(i + 1) % loop.length];
    return [x + (nx - x) * t, z + (nz - z) * t];
  });
};

/** Mean over `spread` neighbours either side, wrapping round the loop. */
const spreadRound = (values: readonly number[], spread: number, pick: 'max' | 'mean'): number[] =>
  values.map((_, i) => {
    const window = Array.from(
      { length: 2 * spread + 1 },
      (__, k) => values[(i + k - spread + values.length * 2) % values.length],
    );
    return pick === 'max'
      ? Math.max(...window)
      : window.reduce((sum, v) => sum + v, 0) / window.length;
  });

/**
 * The route drawn between waypoints: corners rounded to the drone's turning circle, and an
 * altitude that follows the same look-ahead rule the drone uses, spread so it never steps.
 */
export const flightLine = (
  waypoints: readonly Vec3[],
  terrain: Terrain,
  spacing = 20,
): readonly Vec3[] => {
  const corners = waypoints.map(([x, , z]): Point => [x, z]);
  const outline = corners.flatMap((b, i) =>
    fillet(
      corners[(i + corners.length - 1) % corners.length],
      b,
      corners[(i + 1) % corners.length],
      TURN_RADIUS,
    ),
  );
  const points = resample(outline, spacing);
  const wanted = points.map(([x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];
    return targetAltitude(terrain, x, z, Math.atan2(nz - z, nx - x));
  });
  const altitude = spreadRound(
    spreadRound(wanted, ALTITUDE_SPREAD, 'max'),
    ALTITUDE_SPREAD,
    'mean',
  );
  return points.map(([x, z], i): Vec3 => [x, altitude[i], z]);
};
