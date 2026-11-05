import { describe, expect, it } from 'vitest';
import { BIOMES, characterFor, profileOf } from './biome';
import { characterOf } from './character';
import { pointAt } from './routes';
import { defaultConfig, newMap, createSnapshot } from './sim';
import { colourAt, createTerrain, terrainKey } from './terrain';
import { placeTrees } from './trees';
import type { Config } from './types';

const SEEDS = [1, 7, 42, 101, 2024, 54595, 91750, 133859];
const at = (seed: number, biome: Config['biome']): Config => ({ ...defaultConfig, seed, biome });

const reliefOf = (cfg: Config): number => {
  const t = createTerrain(cfg);
  const heights = Array.from({ length: 41 }, (_, i) => -450 + i * 22.5).flatMap((x) =>
    Array.from({ length: 41 }, (_, j) => t.heightAt(x, -450 + j * 22.5)),
  );
  return Math.max(...heights) - Math.min(...heights);
};

describe('biomes', () => {
  it('leaves the valley character as the seed made it', () => {
    SEEDS.forEach((seed) => expect(characterFor(at(seed, 'valley'))).toEqual(characterOf(seed)));
  });

  it('keeps the terrain key distinct per biome so terrain rebuilds', () => {
    const keys = BIOMES.map((b) => terrainKey(at(7, b)));
    expect(new Set(keys).size).toBe(BIOMES.length);
  });

  it('makes deserts flatter and mountains higher than valleys', () => {
    SEEDS.forEach((seed) => {
      const [valley, desert, mountain] = (['valley', 'desert', 'mountain'] as const).map((b) =>
        reliefOf(at(seed, b)),
      );
      expect(desert).toBeLessThan(valley);
      expect(mountain).toBeGreaterThan(valley);
    });
  });

  it('grows fewer trees in the desert and no more in the mountains than in the valley', () => {
    SEEDS.forEach((seed) => {
      const count = (b: Config['biome']): number =>
        placeTrees(createTerrain(at(seed, b)), null).length;
      expect(count('desert')).toBeLessThan(count('valley') / 2);
      expect(count('mountain')).toBeLessThanOrEqual(count('valley'));
    });
  }, 30_000);

  it('colours each biome differently at the same height', () => {
    const colours = BIOMES.map((b) => {
      const terrain = createTerrain(at(7, b));
      return colourAt(terrain.waterLevel + 0.3 * terrain.cfg.terrainScale, terrain).join(',');
    });
    expect(new Set(colours).size).toBe(BIOMES.length);
  });

  it('keeps the river in the world, holding water, and roads dry in every biome', () => {
    BIOMES.forEach((biome) =>
      SEEDS.forEach((seed) => {
        const t = createTerrain(at(seed, biome));
        const half = t.cfg.worldSize / 2;
        const river = t.routes.river;
        if (!river) throw new Error('river expected');
        Array.from({ length: 21 }, (_, i) =>
          pointAt(river, -half + (i * t.cfg.worldSize) / 20),
        ).forEach(([x, z]) => {
          expect(Math.abs(z)).toBeLessThan(half);
          expect(t.heightAt(x, z)).toBeLessThan(t.waterLevel);
        });
        t.routes.roads.forEach((road) =>
          Array.from({ length: 21 }, (_, i) => -half + (i * t.cfg.worldSize) / 20).forEach((d) =>
            expect(t.deckAt(road, d)).toBeGreaterThan(t.waterLevel),
          ),
        );
      }),
    );
  });

  it('keeps the chosen biome when a new map is drawn', () => {
    const cfg = { ...defaultConfig, biome: 'desert' as const };
    const snap = createSnapshot(cfg, createTerrain(cfg));
    const [next] = newMap(snap, 99);
    expect(next.config.biome).toBe('desert');
    expect(profileOf(next.config.biome).label).toBe('Desert');
  });
});
