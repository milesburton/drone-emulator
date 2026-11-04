import { createNoise2D } from 'simplex-noise';
import { toRandomFn } from './rng';
import { createRoutes, distanceTo, pointAt, tangentAt, type Route, type Routes } from './routes';
import type { Config, Vec3 } from './types';

export interface Terrain {
  readonly heightAt: (x: number, z: number) => number;
  readonly waterLevel: number;
  readonly cfg: Config;
  readonly routes: Routes;
  /** Half-size of the rendered land; far larger than the playable world so it reaches the fog. */
  readonly extent: number;
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
  [cfg.seed, cfg.terrainScale, cfg.worldSize, cfg.resolution, cfg.lakes, cfg.river, cfg.roads].join(
    ':',
  );

const LAKE_WIDTH = 0.05;
const HILL_FREQUENCY = 1 / 380;
const CHANNEL_HALF_WIDTH = 12;
const BANK_WIDTH = 40;
const FLOODPLAIN_NEAR = 30;
const FLOODPLAIN_FAR = 130;
const ROAD_HALF_WIDTH = 4;
const ROAD_LIFT = 0.8;
const BRIDGE_CLEARANCE = 1.5;

/** How much further than the playable world the land extends, and how many coarse rings it uses. */
export const FAR_FACTOR = 4.5;
const FAR_CELLS = 40;
const FAR_GROWTH = 3;

export const createTerrain = (cfg: Config): Terrain => {
  const hills = createNoise2D(toRandomFn(cfg.seed));
  const lakeNoise = createNoise2D(toRandomFn(cfg.seed ^ 0x9e3779b9));
  const routes = createRoutes(cfg);
  const waterLevel = -0.3 * cfg.terrainScale;
  const lakeBed = waterLevel - 0.1 * cfg.terrainScale;
  const riverBed = waterLevel - 0.08 * cfg.terrainScale;
  const floodplain = waterLevel + 0.06 * cfg.terrainScale;

  const heightAt = (x: number, z: number): number => {
    const fx = x * HILL_FREQUENCY;
    const fz = z * HILL_FREQUENCY;
    const raw =
      0.62 * hills(fx, fz) + 0.28 * hills(fx * 3.1, fz * 3.1) + 0.1 * hills(fx * 9, fz * 9);
    const base = raw * cfg.terrainScale;
    const land = cfg.lakes
      ? lerp(lakeBed, base, smoothstep(0, LAKE_WIDTH, Math.abs(lakeNoise(x * 0.0028, z * 0.0028))))
      : base;
    if (!routes.river) return land;
    const distance = distanceTo(routes.river, x, z);
    const plain = lerp(
      Math.max(land, floodplain),
      land,
      smoothstep(FLOODPLAIN_NEAR, FLOODPLAIN_FAR, distance),
    );
    return lerp(riverBed, plain, smoothstep(CHANNEL_HALF_WIDTH, BANK_WIDTH, distance));
  };

  return { heightAt, waterLevel, cfg, routes, extent: cfg.worldSize * FAR_FACTOR };
};

/**
 * Ascending grid coordinates along one axis: uniform across the playable world, then
 * spacing that grows towards `outer`. One mesh with graded spacing has no seams.
 */
export const gridCoords = (
  inner: number,
  outer: number,
  innerCells: number,
  outerCells: number,
): readonly number[] => {
  const far = Array.from(
    { length: outerCells },
    (_, k) =>
      inner +
      ((outer - inner) * (Math.exp((FAR_GROWTH * (k + 1)) / outerCells) - 1)) /
        (Math.exp(FAR_GROWTH) - 1),
  );
  const centre = Array.from(
    { length: innerCells + 1 },
    (_, i) => -inner + (2 * inner * i) / innerCells,
  );
  return [...far.map((v) => -v).reverse(), ...centre, ...far];
};

export const terrainCoords = (terrain: Terrain): readonly number[] =>
  gridCoords(terrain.cfg.worldSize / 2, terrain.extent, terrain.cfg.resolution - 1, FAR_CELLS);

/** Pairs of left/right edge vertices draping a road over the land; bridges dip-free over water. */
export const roadRibbon = (road: Route, terrain: Terrain): readonly Vec3[] =>
  terrainCoords(terrain).flatMap((s) => {
    const [x, z] = pointAt(road, s);
    const [tx, tz] = tangentAt(road, s);
    const y = Math.max(terrain.heightAt(x, z), terrain.waterLevel + BRIDGE_CLEARANCE) + ROAD_LIFT;
    return [
      [x - tz * ROAD_HALF_WIDTH, y, z + tx * ROAD_HALF_WIDTH],
      [x + tz * ROAD_HALF_WIDTH, y, z - tx * ROAD_HALF_WIDTH],
    ] as const;
  });

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
