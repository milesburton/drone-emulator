import { profileOf } from './biome';
import { distanceTo } from './routes';
import { ROAD_HALF_WIDTH, type Terrain } from './terrain';
import { toRandomFn } from './rng';
import type { Vec3 } from './types';

export type TreeKind = 'conifer' | 'broadleaf';

export interface Tree {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly kind: TreeKind;
  /** Uniform scale; a tree of scale 1 is TREE_HEIGHT metres tall. */
  readonly scale: number;
  readonly yaw: number;
}

/** Nominal height of a scale-1 tree; below the drone's minimum clearance even when fully grown. */
export const TREE_HEIGHT = 11;
const MAX_SCALE = 1.25;
const CELL = 22;
const REACH = 0.7;
const ROAD_MARGIN = 6;
const RIVER_MARGIN = 30;
const PAD_CLEAR = 14;
const MAX_SLOPE = 0.55;
const SLOPE_STEP = 4;
const ABOVE_WATER = 2;
const LINE_ABOVE_GRASS = 0.5;

const hashCell = (seed: number, i: number, j: number): number =>
  (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ seed) >>> 0;

const slopeAt = (terrain: Terrain, x: number, z: number): number =>
  Math.hypot(
    terrain.heightAt(x + SLOPE_STEP, z) - terrain.heightAt(x - SLOPE_STEP, z),
    terrain.heightAt(x, z + SLOPE_STEP) - terrain.heightAt(x, z - SLOPE_STEP),
  ) /
  (2 * SLOPE_STEP);

/**
 * Trees on dry grass: a jittered grid across the playable world, thinned by a patchy
 * density field, kept off roads, river banks, steep ground, high ground and the pad.
 * Pure in the terrain and pad, so a map always grows the same forest.
 */
export const placeTrees = (terrain: Terrain, pad: Vec3 | null): readonly Tree[] => {
  const { cfg, waterLevel } = terrain;
  const reach = cfg.worldSize * REACH;
  const cells = Math.ceil(reach / CELL);
  const density = profileOf(cfg.biome).treeDensity;
  const treeline = waterLevel + cfg.terrainScale * 1.3 * LINE_ABOVE_GRASS;
  return Array.from({ length: 2 * cells }, (_, a) => a - cells).flatMap((i) =>
    Array.from({ length: 2 * cells }, (_, b) => b - cells).flatMap((j): readonly Tree[] => {
      const rand = toRandomFn(hashCell(cfg.seed, i, j));
      const x = (i + rand()) * CELL;
      const z = (j + rand()) * CELL;
      const patch = Math.sin(x * 0.011 + cfg.seed) * Math.sin(z * 0.013 - cfg.seed * 0.5);
      if (rand() > density * (0.55 + 0.6 * patch)) return [];
      const y = terrain.heightAt(x, z);
      const clear =
        y > waterLevel + ABOVE_WATER &&
        y < treeline &&
        slopeAt(terrain, x, z) < MAX_SLOPE &&
        terrain.routes.roads.every((r) => distanceTo(r, x, z) > ROAD_HALF_WIDTH + ROAD_MARGIN) &&
        (!terrain.routes.river || distanceTo(terrain.routes.river, x, z) > RIVER_MARGIN) &&
        (!pad || Math.hypot(x - pad[0], z - pad[2]) > PAD_CLEAR);
      if (!clear) return [];
      const kind: TreeKind = rand() < 0.5 + 0.4 * patch ? 'conifer' : 'broadleaf';
      return [
        { x, y, z, kind, scale: 0.6 + (MAX_SCALE - 0.6) * rand(), yaw: rand() * Math.PI * 2 },
      ];
    }),
  );
};
