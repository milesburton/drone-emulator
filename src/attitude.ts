/** Steepest bank the flight controller will command, radians (about 35 degrees). */
export const MAX_ROLL = 0.6;
/** Steepest pitch either way, radians (about 20 degrees). */
export const MAX_PITCH = 0.35;
/** Nose-down lean of a quadcopter in forward flight, radians. */
export const CRUISE_LEAN = 0.1;
/** Radians of pitch per m/s of vertical speed. */
const PITCH_PER_CLIMB = 0.03;
/** Time constant of the attitude response, seconds; a quad tilts quickly but not instantly. */
const ATTITUDE_LAG = 0.35;
const GRAVITY = 9.81;

export interface Attitude {
  /** Nose-up positive, radians. */
  readonly pitch: number;
  /** Right-wing-down positive, radians. */
  readonly roll: number;
}

export const level: Attitude = { pitch: -CRUISE_LEAN, roll: 0 };

const clamp = (v: number, limit: number): number => Math.max(-limit, Math.min(limit, v));

/** Coordinated-turn bank angle for a given speed and yaw rate. */
export const bankFor = (speed: number, turnRate: number): number =>
  clamp(Math.atan((speed * turnRate) / GRAVITY), MAX_ROLL);

/** Pitch for a given vertical speed: nose up to climb, nose down to descend, plus the cruise lean. */
export const pitchFor = (climbRate: number): number =>
  clamp(-CRUISE_LEAN + climbRate * PITCH_PER_CLIMB, MAX_PITCH);

/** Eases the attitude towards what the current turn and climb call for. */
export const nextAttitude = (
  prev: Attitude,
  speed: number,
  turnRate: number,
  climbRate: number,
  dt: number,
): Attitude => {
  const k = 1 - Math.exp(-dt / ATTITUDE_LAG);
  return {
    pitch: prev.pitch + (pitchFor(climbRate) - prev.pitch) * k,
    roll: prev.roll + (bankFor(speed, turnRate) - prev.roll) * k,
  };
};
