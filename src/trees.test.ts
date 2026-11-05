import { describe, expect, it } from 'vitest';
import { distanceTo } from './routes';
import { defaultConfig } from './sim';
import { createTerrain, ROAD_HALF_WIDTH } from './terrain';
import { placeTrees, TREE_HEIGHT } from './trees';
import { MIN_CLEARANCE } from './altitude';

const SEEDS = [1, 7, 42, 101, 2024, 54595, 91750, 133859];

describe('placeTrees', () => {
  it('is deterministic for a map', () => {
    const terrain = createTerrain({ ...defaultConfig, seed: 7 });
    expect(placeTrees(terrain, null)).toEqual(placeTrees(terrain, null));
  });

  it('grows a forest on every sampled map', () => {
    SEEDS.forEach((seed) => {
      const trees = placeTrees(createTerrain({ ...defaultConfig, seed }), null);
      expect(trees.length).toBeGreaterThan(50);
    });
  });

  it('keeps trees dry, off roads and river, and clear of the pad', () => {
    SEEDS.forEach((seed) => {
      const terrain = createTerrain({ ...defaultConfig, seed });
      const pad: readonly [number, number, number] = [20, terrain.heightAt(20, 20), 20];
      placeTrees(terrain, pad).forEach((t) => {
        expect(t.y).toBeGreaterThan(terrain.waterLevel);
        expect(Math.hypot(t.x - pad[0], t.z - pad[2])).toBeGreaterThan(10);
        terrain.routes.roads.forEach((r) =>
          expect(distanceTo(r, t.x, t.z)).toBeGreaterThan(ROAD_HALF_WIDTH),
        );
        if (terrain.routes.river)
          expect(distanceTo(terrain.routes.river, t.x, t.z)).toBeGreaterThan(20);
      });
    });
  });

  it('stays below the drone minimum clearance', () => {
    expect(TREE_HEIGHT * 1.25).toBeLessThan(MIN_CLEARANCE);
  });
});
