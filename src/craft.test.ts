import { describe, expect, it } from 'vitest';
import { defaultConfig } from './sim';
import { COLLISION_RADIUS, CRAFT_COUNT, CRAFT_KINDS, craftAt, fleetAt, hitsCraft } from './craft';
import { surfaceAt } from './crash';
import { createTerrain } from './terrain';

const terrain = createTerrain(defaultConfig);
const times = Array.from({ length: 200 }, (_, i) => i * 3);

describe('other craft', () => {
  it('mixes quadcopters, octocopters and planes, deterministically', () => {
    expect(new Set(CRAFT_KINDS)).toEqual(new Set(['quad', 'octo', 'plane']));
    expect(fleetAt(4, 12.5, terrain)).toEqual(fleetAt(4, 12.5, terrain));
    expect(fleetAt(4, 12.5, terrain)).toHaveLength(CRAFT_COUNT);
  });

  it('stays clear of the land and water, and keeps moving', () => {
    Array.from({ length: CRAFT_COUNT }, (_, i) => i).forEach((i) => {
      const track = times.map((t) => craftAt(4, i, t, terrain));
      track.forEach((c) =>
        expect(c.pos[1]).toBeGreaterThan(surfaceAt(terrain, c.pos[0], c.pos[2]) + 20),
      );
      expect(track[1].pos).not.toEqual(track[0].pos);
    });
  });

  it('reports a hit only when the drone is on top of a craft', () => {
    const c = craftAt(4, 0, 50, terrain);
    expect(hitsCraft(c.pos, 4, 50, terrain)).toBe(true);
    expect(hitsCraft([c.pos[0] + COLLISION_RADIUS + 1, c.pos[1], c.pos[2]], 4, 50, terrain)).toBe(
      fleetAt(4, 50, terrain).some(
        (o) =>
          Math.hypot(
            o.pos[0] - c.pos[0] - COLLISION_RADIUS - 1,
            o.pos[1] - c.pos[1],
            o.pos[2] - c.pos[2],
          ) < COLLISION_RADIUS,
      ),
    );
  });
});
