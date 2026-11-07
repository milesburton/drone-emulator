/** Acceleration-limited motion: rates ramp up and down instead of changing instantly. */

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Yaw acceleration as a multiple of the maximum yaw rate per second (reaches full rate in ~0.45 s). */
export const YAW_ACCEL_PER_RATE = 2.2;
/** Same for a small, agile FPV drone on a track or forest run: full rate in about one tick. */
export const AGILE_YAW_ACCEL_PER_RATE = 60;
/** Vertical acceleration, m/s squared. */
export const CLIMB_ACCEL = 24;
/** Small FPV drones accelerate vertically this many times harder. */
export const AGILE_CLIMB_FACTOR = 4;
/** Forward acceleration, m/s squared. */
export const SPEED_ACCEL = 16;

/** Moves `value` towards `target` by at most `step`. */
export const approach = (value: number, target: number, step: number): number =>
  value + Math.max(-step, Math.min(step, target - value));

export interface Turn {
  readonly heading: number;
  readonly rate: number;
}

/**
 * Turns towards `desired` with a bounded yaw rate and yaw acceleration. The target rate follows a braking profile
 * (sqrt of twice the acceleration times the remaining angle), so the turn eases out and does not overshoot.
 */
export const turnSmoothly = (
  heading: number,
  rate: number,
  desired: number,
  maxRate: number,
  dt: number,
  accelPerRate = YAW_ACCEL_PER_RATE,
): Turn => {
  const accel = maxRate * accelPerRate;
  const delta = wrap(desired - heading);
  const wanted = Math.sign(delta) * Math.min(maxRate, Math.sqrt(2 * accel * Math.abs(delta)));
  const next = approach(rate, wanted, accel * dt);
  return { heading: wrap(heading + next * dt), rate: next };
};

/** Vertical speed that ramps towards what the altitude controller asked for. */
export const smoothClimb = (
  prevClimb: number,
  wantedClimb: number,
  dt: number,
  factor = 1,
): number => approach(prevClimb, wantedClimb, CLIMB_ACCEL * factor * dt);
