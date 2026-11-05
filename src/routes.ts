import { createNoise2D } from 'simplex-noise';
import { characterFor } from './biome';
import { ranges, toRandomFn } from './rng';
import type { Config, Vec2 } from './types';

/**
 * A winding line described as a function of one axis: for a route running `along`
 * x, `offsetAt(x)` is its z. Being analytic it extends to the horizon and its
 * distance from any point is O(1).
 */
export interface Route {
  readonly along: 'x' | 'z';
  readonly offsetAt: (s: number) => number;
}

export interface Routes {
  readonly river: Route | null;
  readonly roads: readonly Route[];
}

const SLOPE_STEP = 2;

export const pointAt = (route: Route, s: number): Vec2 =>
  route.along === 'x' ? [s, route.offsetAt(s)] : [route.offsetAt(s), s];

const slopeAt = (route: Route, s: number): number =>
  (route.offsetAt(s + SLOPE_STEP) - route.offsetAt(s - SLOPE_STEP)) / (2 * SLOPE_STEP);

/** Unit direction of travel in (x, z) as `s` increases. */
export const tangentAt = (route: Route, s: number): Vec2 => {
  const slope = slopeAt(route, s);
  const length = Math.hypot(1, slope);
  return route.along === 'x' ? [1 / length, slope / length] : [slope / length, 1 / length];
};

/** Approximate perpendicular distance from (x, z) to the route. */
export const distanceTo = (route: Route, x: number, z: number): number => {
  const [s, across] = route.along === 'x' ? [x, z] : [z, x];
  return Math.abs(across - route.offsetAt(s)) / Math.hypot(1, slopeAt(route, s));
};

const wander =
  (
    noise: (x: number, y: number) => number,
    baseline: number,
    amplitude: number,
    wavelength: number,
    salt: number,
  ) =>
  (s: number): number =>
    baseline +
    amplitude * (0.7 * noise(s / wavelength, salt) + 0.3 * noise((s * 2.3) / wavelength, salt + 5));

/** Builds the river and the crossing roads from the seed; nothing here is random at call time. */
export const createRoutes = (cfg: Config): Routes => {
  const size = cfg.worldSize;
  const character = characterFor(cfg);
  const noise = createNoise2D(toRandomFn(cfg.seed ^ 0x51ed270b));
  const [baselines] = ranges(cfg.seed ^ 0x2545f491, 4, -0.2 * size, 0.2 * size);
  return {
    river: cfg.river
      ? {
          along: 'x',
          offsetAt: wander(
            noise,
            baselines[0],
            character.riverSinuosity * size,
            character.riverWavelength,
            1.7,
          ),
        }
      : null,
    // Roads alternate direction so any count still crosses the map.
    roads: cfg.roads
      ? Array.from({ length: character.roadCount }, (_, i): Route => ({
          along: i % 2 === 0 ? 'z' : 'x',
          offsetAt: wander(noise, baselines[i + 1], 0.08 * size, 700 - 30 * i, 9.1 + 8.2 * i),
        }))
      : [],
  };
};
