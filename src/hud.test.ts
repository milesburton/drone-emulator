import { describe as suite, expect, it } from 'vitest';
import { describe } from './hud';
import { createSnapshot, defaultConfig } from './sim';
import { createTerrain } from './terrain';

suite('hud', () => {
  it('summarises a snapshot', () => {
    const text = describe(createSnapshot(defaultConfig, createTerrain(defaultConfig)));
    expect(text).toContain('waypoint 2/6');
    expect(text).toContain('wind     true 6.0, -3.0');
    expect(text).toContain('weather  clear');
  });
});
