import { describe, expect, it } from 'vitest';
import { placeGrass } from './grass';
import { distanceTo } from './routes';
import { defaultConfig } from './sim';
import { createTerrain, ROAD_HALF_WIDTH } from './terrain';

const SEEDS = [1, 7, 42];

describe('placeGrass', () => {
  it('is deterministic for a map', () => {
    const terrain = createTerrain({ ...defaultConfig, seed: 7 });
    expect(placeGrass(terrain, null)).toEqual(placeGrass(terrain, null));
  });

  it('covers a valley, but barely a desert', () => {
    const valley = placeGrass(createTerrain({ ...defaultConfig, seed: 7, biome: 'valley' }), null);
    const desert = placeGrass(createTerrain({ ...defaultConfig, seed: 7, biome: 'desert' }), null);
    expect(valley.length).toBeGreaterThan(2000);
    expect(desert.length).toBeLessThan(valley.length / 5);
  });

  it('keeps grass dry, off roads and clear of the pad', () => {
    SEEDS.forEach((seed) => {
      const terrain = createTerrain({ ...defaultConfig, seed });
      const pad: readonly [number, number, number] = [20, terrain.heightAt(20, 20), 20];
      placeGrass(terrain, pad).forEach((t) => {
        expect(t.y).toBeGreaterThan(terrain.waterLevel);
        expect(Math.hypot(t.x - pad[0], t.z - pad[2])).toBeGreaterThan(9);
        terrain.routes.roads.forEach((r) =>
          expect(distanceTo(r, t.x, t.z)).toBeGreaterThan(ROAD_HALF_WIDTH),
        );
      });
    });
  });
});
