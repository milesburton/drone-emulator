import { ranges } from './rng';
import type { Vec3 } from './types';

export const AIRLINER_COUNT = 3;
/** Cruise height, metres: well above the cloud tops (about 260 m). */
const ALTITUDE_MIN = 420;
const ALTITUDE_MAX = 560;
const SPEED_MIN = 55;
const SPEED_MAX = 80;
/** Longest stretch of contrail left behind a plane, metres. */
export const TRAIL_LENGTH = 700;
/** Share of passes that leave a contrail at all. */
const TRAIL_CHANCE = 0.65;
const SALT = 0x6a09e667;

export interface Airliner {
  readonly pos: Vec3;
  /** Direction of travel in the (x, z) plane, radians. */
  readonly heading: number;
  /** Where the contrail starts and ends behind the plane, as (x, y, z) points, or null when it leaves none. */
  readonly trail: readonly [Vec3, Vec3] | null;
}

interface Pass {
  readonly angle: number;
  readonly offset: number;
  readonly altitude: number;
  readonly speed: number;
  /** Period of the whole cycle, seconds: the crossing plus a gap before the next plane comes. */
  readonly gap: number;
  /** Along-track range, as fractions of the crossing, over which the plane is leaving a trail; null for none. */
  readonly trail: readonly [number, number] | null;
}

/** Everything about one crossing, fixed by the seed, the plane and the pass number alone. */
const passOf = (seed: number, plane: number, n: number, extent: number): Pass => {
  const [[angle, offset, altitude, speed, gap, chance, from, span]] = ranges(
    (seed ^ SALT) + plane * 7919 + n * 104729,
    8,
    0,
    1,
  );
  const start = from * 0.7;
  return {
    angle: angle * Math.PI * 2,
    offset: (offset - 0.5) * extent * 1.2,
    altitude: ALTITUDE_MIN + altitude * (ALTITUDE_MAX - ALTITUDE_MIN),
    speed: SPEED_MIN + speed * (SPEED_MAX - SPEED_MIN),
    gap: 15 + gap * 60,
    trail: chance < TRAIL_CHANCE ? [start, Math.min(1, start + 0.25 + span * 0.75)] : null,
  };
};

/**
 * Where airliner `plane` is at `time`, or null while it is out of the area. Each plane crosses the
 * map along a line that changes every pass, and some passes leave a contrail over part of the
 * crossing. Everything follows from the time, so there is no state to carry.
 */
export const airlinerAt = (
  seed: number,
  plane: number,
  time: number,
  extent: number,
): Airliner | null => {
  const cycle = (n: number): { pass: Pass; length: number; period: number } => {
    const pass = passOf(seed, plane, n, extent);
    const length = extent * 2.6;
    return { pass, length, period: length / pass.speed + pass.gap };
  };
  // Passes have different periods, so walk forward from a plane-specific head start.
  const walk = (n: number, left: number): { n: number; into: number } => {
    const { period } = cycle(n);
    return left < period ? { n, into: left } : walk(n + 1, left - period);
  };
  const { n, into } = walk(0, time + plane * 37);
  const { pass, length } = cycle(n);
  const along = into * pass.speed;
  if (along > length) return null;
  const dir: readonly [number, number] = [Math.cos(pass.angle), Math.sin(pass.angle)];
  const side: readonly [number, number] = [-dir[1], dir[0]];
  const at = (s: number): Vec3 => [
    dir[0] * (s - length / 2) + side[0] * pass.offset,
    pass.altitude,
    dir[1] * (s - length / 2) + side[1] * pass.offset,
  ];
  const trail =
    pass.trail === null
      ? null
      : (() => {
          const head = Math.min(along, pass.trail[1] * length);
          const tail = Math.max(along - TRAIL_LENGTH, pass.trail[0] * length, 0);
          return head > tail ? ([at(tail), at(head)] as const) : null;
        })();
  return { pos: at(along), heading: pass.angle, trail };
};
