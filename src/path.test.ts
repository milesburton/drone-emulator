import { describe, expect, it } from 'vitest';
import { createTerrain } from './terrain';
import { createSnapshot, defaultConfig, followRiver, newMap, randomisePath, setPath } from './sim';

describe('hand-picked routes', () => {
  const terrain = createTerrain(defaultConfig);
  const start = createSnapshot(defaultConfig, terrain);

  it('a Random Path records its seed, and that seed rebuilds the same route', () => {
    const picked = randomisePath(start, terrain);
    expect(typeof picked.path).toBe('number');
    const rebuilt = setPath(createSnapshot(defaultConfig, terrain), terrain, picked.path as number);
    expect(rebuilt.waypoints).toEqual(picked.waypoints);
  });

  it('River Path is recorded, and a new map goes back to its own route', () => {
    expect(followRiver(start, terrain).path).toBe('river');
    const [fresh] = newMap(randomisePath(start, terrain), 123);
    expect(fresh.path).toBeUndefined();
  });
});
