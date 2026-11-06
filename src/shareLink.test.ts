import { describe, expect, it } from 'vitest';
import { decodeConfig, decodeStorm, encodeConfig } from './shareLink';
import { defaultConfig } from './sim';
import type { Config } from './types';

describe('share link', () => {
  it('writes only the seed for the default settings, so an old #seed=N link is still the same format', () => {
    expect(encodeConfig(defaultConfig, defaultConfig)).toBe(`seed=${defaultConfig.seed}`);
    expect(decodeConfig('#seed=4242')).toEqual({ seed: 4242 });
  });

  it('round-trips every setting a person can change', () => {
    const cfg: Config = {
      ...defaultConfig,
      mode: 'run',
      biome: 'forest',
      seed: 99,
      windX: -7,
      windZ: 12,
      terrainScale: 90,
      lakes: false,
      river: false,
      roads: false,
    };
    expect(decodeConfig(encodeConfig(cfg, defaultConfig))).toEqual({
      seed: 99,
      mode: 'run',
      biome: 'forest',
      windX: -7,
      windZ: 12,
      terrainScale: 90,
      lakes: false,
      river: false,
      roads: false,
    });
  });

  it('ignores what is missing, malformed or out of range, and clamps values to the sliders', () => {
    expect(decodeConfig('')).toEqual({});
    expect(
      decodeConfig('#seed=banana&mode=hover&biome=moon&wind=x,y&scale=abc&lakes=maybe'),
    ).toEqual({});
    expect(decodeConfig('#seed=100000')).toEqual({});
    expect(decodeConfig('#wind=99,-99&scale=1000')).toEqual({
      windX: 20,
      windZ: -20,
      terrainScale: 150,
    });
  });

  it('carries a storm in progress', () => {
    expect(encodeConfig(defaultConfig, defaultConfig, true)).toBe(
      `seed=${defaultConfig.seed}&storm=1`,
    );
    expect(decodeStorm('#seed=1&storm=1')).toBe(true);
    expect(decodeStorm('#seed=1')).toBe(false);
  });
});
