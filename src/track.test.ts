import { groundBeneath } from './altitude';
import { describe, expect, it } from 'vitest';
import { FOOTPRINT } from './altitude';
import { defaultConfig } from './sim';
import { createTerrain } from './terrain';
import {
  ARENA_RADIUS,
  GATE_HEIGHT,
  GATE_WIDTH,
  MAX_GATES,
  MAX_TURN,
  MIN_GATES,
  MIN_SPACING,
  OBSTACLE_MARGIN,
  findArena,
  generateTrack,
} from './track';

const terrain = createTerrain(defaultConfig);
const centre = findArena(terrain, 1337);
const seeds = Array.from({ length: 200 }, (_, i) => 1 + i * 487);
const tracks = seeds.map((seed) => generateTrack(terrain, centre, seed));
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const legDistance = (a: readonly number[], b: readonly number[], x: number, z: number): number => {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (a[0] + dx * t), z - (a[2] + dz * t));
};

describe('track generator', () => {
  it('is deterministic and differs between seeds', () => {
    expect(generateTrack(terrain, centre, 7)).toEqual(generateTrack(terrain, centre, 7));
    expect(generateTrack(terrain, centre, 7)).not.toEqual(generateTrack(terrain, centre, 8));
  });

  it('lays out a closed loop of 8-12 gates a lap can actually be flown round', () => {
    tracks.forEach(({ gates }) => {
      expect(gates.length).toBeGreaterThanOrEqual(MIN_GATES);
      expect(gates.length).toBeLessThanOrEqual(MAX_GATES);
      gates.forEach((g, i) => {
        const prev = gates[(i + gates.length - 1) % gates.length];
        const next = gates[(i + 1) % gates.length];
        expect(Math.hypot(next.pos[0] - g.pos[0], next.pos[2] - g.pos[2])).toBeGreaterThanOrEqual(
          MIN_SPACING - 1e-6,
        );
        const into = Math.atan2(g.pos[2] - prev.pos[2], g.pos[0] - prev.pos[0]);
        const out = Math.atan2(next.pos[2] - g.pos[2], next.pos[0] - g.pos[0]);
        expect(Math.abs(wrap(out - into))).toBeLessThanOrEqual(MAX_TURN + 1e-6);
      });
    });
  });

  it('keeps every gate to its kind: width, height above ground, inside the arena', () => {
    tracks.forEach(({ gates }) =>
      gates.forEach((g) => {
        expect(g.width).toBe(GATE_WIDTH[g.kind]);
        // Seated above the highest ground under the airframe's reach, and above any water.
        const above =
          g.pos[1] - Math.max(groundBeneath(terrain, g.pos[0], g.pos[2]), terrain.waterLevel);
        expect(above).toBeGreaterThanOrEqual(GATE_HEIGHT[g.kind][0] - 1e-6);
        expect(above).toBeLessThanOrEqual(GATE_HEIGHT[g.kind][1] + 1e-6);
        expect(Math.hypot(g.pos[0] - centre[0], g.pos[2] - centre[2])).toBeLessThanOrEqual(
          ARENA_RADIUS,
        );
      }),
    );
  });

  it('puts obstacles near the line but never on it, never in a gate, never in the water', () => {
    expect(tracks.some((t) => t.obstacles.length > 0)).toBe(true);
    tracks.forEach(({ gates, obstacles }) =>
      obstacles.forEach((o) => {
        gates.forEach((g, i) => {
          const next = gates[(i + 1) % gates.length];
          expect(legDistance(g.pos, next.pos, o.pos[0], o.pos[2])).toBeGreaterThan(
            o.radius + FOOTPRINT + OBSTACLE_MARGIN,
          );
          expect(Math.hypot(g.pos[0] - o.pos[0], g.pos[2] - o.pos[2])).toBeGreaterThan(g.width);
        });
        expect(o.pos[1]).toBeGreaterThan(terrain.waterLevel);
        expect(o.pos[1]).toBeCloseTo(terrain.heightAt(o.pos[0], o.pos[2]), 6);
      }),
    );
  });

  it('starts the drone on the ground, short of and facing the first gate', () => {
    tracks.slice(0, 40).forEach(({ start, gates }) => {
      expect(start[1]).toBeCloseTo(terrain.heightAt(start[0], start[2]), 6);
      const [g] = gates;
      const toGate = Math.atan2(g.pos[2] - start[2], g.pos[0] - start[0]);
      expect(Math.abs(wrap(toGate - g.yaw))).toBeLessThan(0.01);
    });
  });
});

describe('arena search', () => {
  it('finds dry, in-bounds ground in every biome', () => {
    (['valley', 'desert', 'mountain'] as const).forEach((biome) =>
      [1337, 22, 4041].forEach((seed) => {
        const t = createTerrain({ ...defaultConfig, biome, seed });
        const [x, y, z] = findArena(t, seed);
        expect(y).toBeGreaterThan(t.waterLevel);
        expect(Math.abs(x)).toBeLessThanOrEqual(0.4 * t.cfg.worldSize);
        expect(Math.abs(z)).toBeLessThanOrEqual(0.4 * t.cfg.worldSize);
      }),
    );
  });

  it('is deterministic', () => {
    expect(findArena(terrain, 5)).toEqual(findArena(terrain, 5));
  });
});
