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
export const CLIMB_RESPONSE = 1.2;
/** Vertical speed limits in m/s; the drone can sink faster than it can climb. */
export const MAX_CLIMB = 10;
export const MAX_DESCENT = 7;

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
  return Math.max(eased, terrain.heightAt(x, z) + MIN_CLEARANCE);
};

/** Waypoint seated at cruise clearance above the ground. */
export const seatWaypoint = (terrain: Terrain, x: number, z: number): Vec3 => [
  x,
  terrain.heightAt(x, z) + CLEARANCE,
  z,
];

/**
 * The route drawn between waypoints: each leg sampled every `spacing` metres with the same
 * look-ahead rule the drone follows, so the line matches where the drone will really fly.
 */
export const flightLine = (
  waypoints: readonly Vec3[],
  terrain: Terrain,
  spacing = 20,
): readonly Vec3[] =>
  waypoints.flatMap(([ax, , az], i) => {
    const [bx, , bz] = waypoints[(i + 1) % waypoints.length];
    const length = Math.hypot(bx - ax, bz - az);
    const heading = Math.atan2(bz - az, bx - ax);
    const count = Math.max(1, Math.ceil(length / spacing));
    return Array.from({ length: count }, (_, k): Vec3 => {
      const t = k / count;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      return [x, targetAltitude(terrain, x, z, heading), z];
    });
  });
