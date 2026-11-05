import { ranges } from './rng';

/** Seed-derived shape of a map; the terrain and route builders read these instead of constants. */
export interface MapCharacter {
  /** Multiplies the hill noise frequency: below 1 broad and rolling, above 1 busy and ridged. */
  readonly hillFrequency: number;
  /** Multiplies the terrain scale: below 1 flat, above 1 mountainous. */
  readonly relief: number;
  /** Noise threshold that carves lakes; larger is wetter. */
  readonly lakeWidth: number;
  /** Water level as a fraction of the terrain scale below zero; larger floods more land. */
  readonly waterFraction: number;
  readonly riverHalfWidth: number;
  /** River wander as a fraction of the world size. */
  readonly riverSinuosity: number;
  readonly riverWavelength: number;
  readonly roadCount: number;
}

const CHARACTER_SALT = 0x6a09e667;
const MIN_ROADS = 1;
const MAX_ROADS = 3;

/** Pure and total: the same seed always gives the same character, in bounds the sweep test checks. */
export const characterOf = (seed: number): MapCharacter => {
  const [[freq, relief, lake, water, width, sinuosity, wavelength, roads]] = ranges(
    seed ^ CHARACTER_SALT,
    8,
    0,
    1,
  );
  const span = (v: number, min: number, max: number): number => min + v * (max - min);
  return {
    hillFrequency: span(freq, 0.7, 1.5),
    relief: span(relief, 0.7, 1.4),
    lakeWidth: span(lake, 0.02, 0.09),
    waterFraction: span(water, 0.22, 0.36),
    riverHalfWidth: span(width, 8, 18),
    riverSinuosity: span(sinuosity, 0.06, 0.2),
    riverWavelength: span(wavelength, 380, 760),
    roadCount: Math.min(MAX_ROADS, MIN_ROADS + Math.floor(roads * (MAX_ROADS - MIN_ROADS + 1))),
  };
};
