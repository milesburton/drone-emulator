import { profileOf } from './biome';
import { distanceTo } from './routes';
import { toRandomFn } from './rng';
import { ROAD_HALF_WIDTH, type Terrain } from './terrain';
import type { Vec3 } from './types';

export interface Tuft {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Uniform scale; a tuft of scale 1 is GRASS_HEIGHT metres tall. */
  readonly scale: number;
  readonly yaw: number;
  /** Brightness multiplier, so the lawn is not one flat green. */
  readonly tone: number;
}

export const GRASS_HEIGHT = 0.9;
const CELL = 3.2;
/** Grass is only grown this far from the origin: beyond it the tufts are too small to see anyway. */
export const GRASS_REACH = 320;
const MAX_SLOPE = 0.7;
const SLOPE_STEP = 3;
const ABOVE_WATER = 0.6;
const ROAD_MARGIN = 0.8;
const PAD_CLEAR = 9;
const LINE_ABOVE_GRASS = 0.5;

const hashCell = (seed: number, i: number, j: number): number =>
  (Math.imul(i, 83492791) ^ Math.imul(j, 2654435761) ^ seed) >>> 0;

const slopeAt = (terrain: Terrain, x: number, z: number): number =>
  Math.hypot(
    terrain.heightAt(x + SLOPE_STEP, z) - terrain.heightAt(x - SLOPE_STEP, z),
    terrain.heightAt(x, z + SLOPE_STEP) - terrain.heightAt(x, z - SLOPE_STEP),
  ) /
  (2 * SLOPE_STEP);

/**
 * Grass tufts on dry, gentle ground: a jittered grid thinned by a patchy field, kept off roads,
 * the pad, the water's edge, steep slopes and high ground. Pure in the terrain and pad, so a
 * map always grows the same lawn.
 */
export const placeGrass = (terrain: Terrain, pad: Vec3 | null): readonly Tuft[] => {
  const { cfg, waterLevel } = terrain;
  const density = profileOf(cfg.biome).grassDensity;
  if (density <= 0) return [];
  const reach = Math.min(cfg.worldSize * 0.7, GRASS_REACH);
  const cells = Math.ceil(reach / CELL);
  const line = waterLevel + cfg.terrainScale * 1.3 * LINE_ABOVE_GRASS;
  return Array.from({ length: 2 * cells }, (_, a) => a - cells).flatMap((i) =>
    Array.from({ length: 2 * cells }, (_, b) => b - cells).flatMap((j): readonly Tuft[] => {
      const rand = toRandomFn(hashCell(cfg.seed, i, j));
      const x = (i + rand()) * CELL;
      const z = (j + rand()) * CELL;
      const patch = Math.sin(x * 0.07 + cfg.seed) * Math.sin(z * 0.06 - cfg.seed * 0.7);
      if (rand() > Math.min(1, density) * (0.7 + 0.3 * patch)) return [];
      const y = terrain.heightAt(x, z);
      const clear =
        y > waterLevel + ABOVE_WATER &&
        y < line &&
        slopeAt(terrain, x, z) < MAX_SLOPE &&
        terrain.routes.roads.every((r) => distanceTo(r, x, z) > ROAD_HALF_WIDTH + ROAD_MARGIN) &&
        (!pad || Math.hypot(x - pad[0], z - pad[2]) > PAD_CLEAR) &&
        (!terrain.arena ||
          Math.hypot(x - terrain.arena.centre[0], z - terrain.arena.centre[2]) >
            terrain.arena.radius + 4);
      if (!clear) return [];
      return [
        {
          x,
          y,
          z,
          scale: 0.7 + 0.8 * rand(),
          yaw: rand() * Math.PI * 2,
          tone: 0.82 + 0.36 * rand() + 0.1 * patch,
        },
      ];
    }),
  );
};
