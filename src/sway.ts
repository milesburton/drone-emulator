import type { Vec2, Vec3 } from './types';

/** Wind speed, metres per second, at which flags stream flat and trees lean as far as they will. */
export const FULL_WIND = 20;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** How hard the air is working, 0 (still) to 1 (gale): steady wind plus the current gust. */
export const windStrength = (windX: number, windZ: number, gust: Vec2): number =>
  clamp01(Math.hypot(windX + gust[0], windZ + gust[1]) / FULL_WIND);

/** Largest roll/pitch the flight controller leaves uncorrected in a gale, radians (about 7 degrees). */
const MAX_WOBBLE = 0.12;
/** Largest yaw error left in a gale, radians. */
const MAX_YAW_WOBBLE = 0.08;
/** Largest position excursion left in a gale, metres. */
const MAX_DRIFT = 0.7;
/** Even in still air a hovering quad is never perfectly steady. */
const IDLE = 0.15;

export interface Disturbance {
  readonly roll: number;
  readonly pitch: number;
  readonly yaw: number;
  /** World-space offset from the commanded position, metres. */
  readonly offset: Vec3;
}

/**
 * Small three-axis motion of a drone being buffeted while its flight controller fights back:
 * a slow component for the push and a quicker one for the correction, summed from incommensurate
 * sines so it never visibly repeats. A pure function of time and wind strength, and presentation
 * only: the true flight path is untouched, so determinism and the no-clip tests are unaffected.
 */
export const disturbance = (time: number, strength: number): Disturbance => {
  const k = IDLE + (1 - IDLE) * clamp01(strength);
  const wave = (f1: number, p1: number, f2: number, p2: number): number =>
    0.65 * Math.sin(time * f1 + p1) + 0.35 * Math.sin(time * f2 + p2);
  return {
    roll: MAX_WOBBLE * k * wave(1.3, 0, 4.1, 1.7),
    pitch: MAX_WOBBLE * k * wave(1.1, 2.1, 3.7, 0.4),
    yaw: MAX_YAW_WOBBLE * k * wave(0.7, 4.2, 2.9, 2.2),
    offset: [
      MAX_DRIFT * k * wave(0.9, 1.1, 3.3, 5.0),
      0.6 * MAX_DRIFT * k * wave(1.5, 3.0, 4.7, 0.9),
      MAX_DRIFT * k * wave(0.8, 5.2, 3.1, 2.6),
    ],
  };
};
