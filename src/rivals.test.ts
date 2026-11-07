import { describe, expect, it } from 'vitest';
import { applyConfig, createSnapshot, defaultConfig, newMap, step } from './sim';
import { createTerrain } from './terrain';
import { calmStorm } from './sim';
import type { Config, Snapshot } from './types';

const cfgFor = (mode: Config['mode'], seed = 7, rivals = 7): Config => ({
  ...defaultConfig,
  mode,
  seed,
  rivals,
  ...(mode === 'run' ? { biome: 'forest' as const } : {}),
});

const fly = (s: Snapshot, t: ReturnType<typeof createTerrain>, seconds: number): Snapshot =>
  Array.from({ length: seconds * 20 }).reduce<Snapshot>((a) => calmStorm(step(a, t, 0.05)), s);

const pilots = (s: Snapshot) => [s, ...s.rivals];

describe('rivals', () => {
  it.each(['sortie', 'track', 'run'] as const)('start on their own pads in %s mode', (mode) => {
    const cfg = cfgFor(mode);
    const s = createSnapshot(cfg, createTerrain(cfg));
    expect(s.rivals).toHaveLength(7);
    const pads = pilots(s).map((p) => p.mission.home);
    pads.forEach((a, i) =>
      pads.slice(i + 1).forEach((b) => {
        expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThanOrEqual(
          mode === 'sortie' ? 20 : 3.5,
        );
      }),
    );
    s.rivals.forEach((r) => {
      expect(r.drone.pos).toEqual(r.mission.home);
      expect([r.waypoints[0][0], r.waypoints[0][2]]).toEqual([
        r.mission.home[0],
        r.mission.home[2],
      ]);
      expect(r.control).toBe('auto');
    });
  });

  it('has none when asked for none, and the count follows the setting', () => {
    const cfg = cfgFor('sortie', 7, 0);
    const t = createTerrain(cfg);
    const s = createSnapshot(cfg, t);
    expect(s.rivals).toEqual([]);
    const [more] = applyConfig(s, t, { rivals: 3 });
    expect(more.rivals.map((r) => r.id)).toEqual([1, 2, 3]);
    const [map] = newMap(more, 99);
    expect(map.rivals).toHaveLength(3);
  });

  it('is deterministic', () => {
    const cfg = cfgFor('sortie');
    const t = createTerrain(cfg);
    const a = fly(createSnapshot(cfg, t), t, 30);
    const b = fly(createSnapshot(cfg, t), t, 30);
    expect(a.rivals.map((r) => r.drone.pos)).toEqual(b.rivals.map((r) => r.drone.pos));
  });

  it('take off one after another and fly their own routes', () => {
    const cfg = cfgFor('sortie');
    const t = createTerrain(cfg);
    const s = fly(createSnapshot(cfg, t), t, 12);
    // Rival 3 leaves at about 3 + 3 * 3 s; by 12 s the first rivals are away and the last still waits.
    expect(s.rivals[0].mission.phase).not.toBe('grounded');
    expect(s.rivals[6].mission.phase).toBe('grounded');
    const routes = s.rivals.map((r) => JSON.stringify(r.waypoints));
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('keep clear of each other in a sortie, with no crashes in calm air', () => {
    const cfg = cfgFor('sortie', 42);
    const t = createTerrain(cfg);
    const s = fly(createSnapshot(cfg, t), t, 150);
    expect(pilots(s).reduce((n, p) => n + p.mission.crashed, 0)).toBe(0);
    pilots(s).forEach((p) => expect(p.mission.battery).toBeGreaterThan(0));
  });

  it('crash both pilots when two airframes touch', () => {
    const cfg = cfgFor('track', 7, 1);
    const t = createTerrain(cfg);
    const s = createSnapshot(cfg, t);
    const here = s.drone.pos;
    const a = {
      ...s,
      mission: { ...s.mission, phase: 'cruise' as const, groundLeft: 0 },
      drone: { ...s.drone, pos: [here[0], here[1] + 30, here[2]] as const },
    };
    const b = {
      ...a.rivals[0],
      mission: { ...a.rivals[0].mission, phase: 'cruise' as const, groundLeft: 0 },
      drone: { ...a.rivals[0].drone, pos: [here[0] + 1, here[1] + 30, here[2]] as const },
    };
    const after = step({ ...a, rivals: [b] }, t, 0.05);
    expect(after.mission.phase).toBe('lost');
    expect(after.mission.crashCause).toBe('craft');
    expect(after.rivals[0].mission.phase).toBe('lost');
    expect(after.rivals[0].mission.crashCause).toBe('craft');
  });

  it('are collected at the goal of a run, so nobody meets head-on in the tunnels', () => {
    const cfg = cfgFor('run');
    const t = createTerrain(cfg);
    const s = fly(createSnapshot(cfg, t), t, 120);
    expect(pilots(s).reduce((n, p) => n + p.mission.successes, 0)).toBeGreaterThan(8);
    expect(pilots(s).reduce((n, p) => n + p.mission.crashed, 0)).toBe(0);
  });
});
