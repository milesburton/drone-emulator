import { groundBeneath } from './altitude';
import { describe, expect, it } from 'vitest';
import { AIRFRAME_RADIUS as FOOTPRINT } from './airframe';
import { defaultConfig } from './sim';
import type { Vec3 } from './types';
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
  trackFor,
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

  it('floats sky objects above the ground and clear of every flown leg in three dimensions', () => {
    expect(tracks.some((t) => t.sky.length > 0)).toBe(true);
    tracks.forEach(({ gates, sky, start, exit }) =>
      sky.forEach((o) => {
        expect(o.pos[1] - o.radius).toBeGreaterThan(terrain.heightAt(o.pos[0], o.pos[2]) + 2);
        const legs: readonly (readonly [Vec3, Vec3])[] = [
          ...gates.map((g, i) => [g.pos, gates[(i + 1) % gates.length].pos] as const),
          [start, gates[0].pos],
          [gates[0].pos, exit],
          [exit, start],
        ];
        legs.forEach(([a, b]) => {
          const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const t = Math.max(
            0,
            Math.min(
              1,
              ((o.pos[0] - a[0]) * d[0] + (o.pos[1] - a[1]) * d[1] + (o.pos[2] - a[2]) * d[2]) /
                (d[0] ** 2 + d[1] ** 2 + d[2] ** 2),
            ),
          );
          const dist = Math.hypot(
            o.pos[0] - (a[0] + d[0] * t),
            o.pos[1] - (a[1] + d[1] * t),
            o.pos[2] - (a[2] + d[2] * t),
          );
          expect(dist).toBeGreaterThan(o.radius + FOOTPRINT);
        });
      }),
    );
  });

  it('starts the drone on the ground, short of the first gate and off to one side of its line', () => {
    tracks.slice(0, 40).forEach(({ start, gates }) => {
      expect(start[1]).toBeCloseTo(terrain.heightAt(start[0], start[2]), 6);
      const [g] = gates;
      const dx = start[0] - g.pos[0];
      const dz = start[2] - g.pos[2];
      const along = dx * Math.cos(g.yaw) + dz * Math.sin(g.yaw);
      const side = -dx * Math.sin(g.yaw) + dz * Math.cos(g.yaw);
      // One of the pad positions the generator tries: 25 m or 40 m back, 28 m to either side.
      expect([-25, -40].some((d) => Math.abs(along - d) < 1e-3)).toBe(true);
      expect(Math.abs(side)).toBeCloseTo(28, 3);
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

describe('flat arena', () => {
  const cfg = { ...defaultConfig, mode: 'track' as const };
  it.each([1, 7, 1337, 31337])(
    'is level inside the fence and fenced round the track (seed %i)',
    (seed) => {
      const t = createTerrain({ ...cfg, seed });
      const { arena } = t;
      expect(arena).not.toBeNull();
      const [cx, cy, cz] = arena!.centre;
      expect(cy).toBeGreaterThan(t.waterLevel);
      [0, 1, 2, 3, 4, 5, 6, 7].forEach((k) => {
        const a = (k / 8) * Math.PI * 2;
        [0.2, 0.6, 1].forEach((f) =>
          expect(
            t.heightAt(cx + Math.cos(a) * arena!.radius * f, cz + Math.sin(a) * arena!.radius * f),
          ).toBeCloseTo(cy, 6),
        );
      });
      const track = trackFor(t, seed);
      [...track.gates.map((g) => g.pos), ...track.obstacles.map((o) => o.pos), track.start].forEach(
        ([x, , z]) => expect(Math.hypot(x - cx, z - cz)).toBeLessThan(arena!.radius - 20),
      );
    },
  );
  it('has no arena in sortie mode, and no roads or river in track mode', () => {
    expect(createTerrain(defaultConfig).arena).toBeNull();
    const t = createTerrain(cfg);
    expect(t.routes.roads).toHaveLength(0);
    expect(t.routes.river).toBeNull();
  });
});
