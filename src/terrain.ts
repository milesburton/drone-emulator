import { createNoise2D } from 'simplex-noise';
import { toRandomFn } from './rng';
import type { Config } from './types';

export interface Terrain {
  readonly heightAt: (x: number, z: number) => number;
  readonly waterLevel: number;
  readonly cfg: Config;
}

export type Rgb = readonly [number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (edge0: number, edge1: number, v: number): number => {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Terrain-affecting config fields; if this key is unchanged the terrain can be reused. */
export const terrainKey = (cfg: Config): string =>
  [cfg.seed, cfg.terrainScale, cfg.worldSize, cfg.resolution, cfg.river].join(':');

const RIVER_WIDTH = 0.05;
const HILL_FREQUENCY = 1 / 380;

export const createTerrain = (cfg: Config): Terrain => {
  const hills = createNoise2D(toRandomFn(cfg.seed));
  const riverNoise = createNoise2D(toRandomFn(cfg.seed ^ 0x9e3779b9));
  const waterLevel = -0.3 * cfg.terrainScale;
  const riverBed = waterLevel - 0.1 * cfg.terrainScale;

  const heightAt = (x: number, z: number): number => {
    const fx = x * HILL_FREQUENCY;
    const fz = z * HILL_FREQUENCY;
    const raw =
      0.62 * hills(fx, fz) + 0.28 * hills(fx * 3.1, fz * 3.1) + 0.1 * hills(fx * 9, fz * 9);
    const base = raw * cfg.terrainScale;
    if (!cfg.river) return base;
    const distance = Math.abs(riverNoise(x * 0.0028, z * 0.0028));
    return lerp(riverBed, base, smoothstep(0, RIVER_WIDTH, distance));
  };

  return { heightAt, waterLevel, cfg };
};

const SAND: Rgb = [0.78, 0.72, 0.5];
const GRASS_LOW: Rgb = [0.22, 0.48, 0.18];
const GRASS_HIGH: Rgb = [0.42, 0.55, 0.22];
const ROCK: Rgb = [0.45, 0.42, 0.4];
const SNOW: Rgb = [0.95, 0.96, 0.98];

/** Colours a point by height relative to the water level and the terrain scale. */
export const colourAt = (height: number, terrain: Terrain): Rgb => {
  const { waterLevel, cfg } = terrain;
  const above = height - waterLevel;
  const range = Math.max(cfg.terrainScale * 1.3, 1);
  const t = above / range;
  if (t < 0.03) return SAND;
  if (t < 0.12) return mix(SAND, GRASS_LOW, smoothstep(0.03, 0.12, t));
  if (t < 0.5) return mix(GRASS_LOW, GRASS_HIGH, smoothstep(0.12, 0.5, t));
  if (t < 0.7) return mix(GRASS_HIGH, ROCK, smoothstep(0.5, 0.7, t));
  return mix(ROCK, SNOW, smoothstep(0.7, 0.85, t));
};
