import { describe, expect, it } from 'vitest';
import { crossing, hitsGate, hitsObstacle, hitsSky } from './gates';
import { createSnapshot, defaultConfig, step } from './sim';
import { createTerrain } from './terrain';
import { trackFor, type Gate, type GateKind, type Obstacle } from './track';
import { trackLine } from './hud';
import type { Snapshot, Vec3 } from './types';

/** A gate at the origin facing +x (yaw 0): "along" is x, "lat" is z, "dy" is y. */
const gateOf = (kind: GateKind, width = 9): Gate => ({ kind, pos: [0, 4, 0], yaw: 0, width });
const at = (along: number, lat: number, dy: number): Vec3 => [along, 4 + dy, lat];

describe('crossing', () => {
  const g = gateOf('gate');
  it('passes through the middle of the opening', () => {
    expect(crossing(g, at(-5, 0, 0), at(5, 0, 0))).toBe('pass');
  });
  it('misses outside the posts or over the top, but only when it crosses the plane', () => {
    expect(crossing(g, at(-5, 7, 0), at(5, 7, 0))).toBe('miss');
    expect(crossing(g, at(-5, 0, 7), at(5, 0, 7))).toBe('miss');
    expect(crossing(g, at(-5, 0, 0), at(-1, 0, 0))).toBeNull();
    expect(crossing(g, at(-5, 60, 0), at(5, 60, 0))).toBeNull();
  });
  it('ignores a crossing from the wrong side', () => {
    expect(crossing(g, at(5, 0, 0), at(-5, 0, 0))).toBeNull();
  });
  it('treats a hoop as a round opening and a dive gate as bounded below', () => {
    expect(crossing(gateOf('hoop', 8.5), at(-1, 0, 0), at(1, 0, 0))).toBe('pass');
    expect(crossing(gateOf('hoop', 8.5), at(-1, 3.5, 3.5), at(1, 3.5, 3.5))).toBe('miss');
    expect(crossing(gateOf('dive'), at(-1, 0, -8), at(1, 0, -8))).toBe('miss');
  });
});

describe('hitsGate', () => {
  it.each(['gate', 'hoop', 'arch', 'dive'] as const)('clears the middle of a %s', (kind) => {
    expect(hitsGate(gateOf(kind), at(0, 0, 0))).toBe(false);
  });
  it('hits the posts when the airframe reaches them, and not while well clear', () => {
    const g = gateOf('gate');
    expect(hitsGate(g, at(0, 4.5, 0))).toBe(true);
    expect(hitsGate(g, at(0, 1, 0))).toBe(false);
    expect(hitsGate(g, at(10, 4.5, 0))).toBe(false);
  });
  it('hits the top bar but flies freely well below it', () => {
    const g = gateOf('gate');
    expect(hitsGate(g, at(0, 0, 4.5))).toBe(true);
    expect(hitsGate(g, at(0, 0, 1))).toBe(false);
  });
  it('hits the rim of a hoop', () => {
    expect(hitsGate(gateOf('hoop', 8.5), at(0, 4.25, 0))).toBe(true);
  });
});

describe('hitsObstacle', () => {
  const o: Obstacle = { kind: 'pylon', pos: [0, 0, 0], radius: 0.8, height: 14 };
  it('hits within the footprint and below the top, not beside or above it', () => {
    expect(hitsObstacle(o, [2, 5, 0])).toBe(true);
    expect(hitsObstacle(o, [3, 5, 0])).toBe(false);
    expect(hitsObstacle(o, [0, 30, 0])).toBe(false);
  });
});

describe('on the track', () => {
  const seed = 7;
  const cfg = { ...defaultConfig, mode: 'track' as const, seed };
  const t = createTerrain(cfg);
  const track = trackFor(t, seed);

  it('crashes with the cause when a gate frame is struck', () => {
    const g = track.gates[0];
    const base = createSnapshot(cfg, t);
    const post: Vec3 = [
      g.pos[0] - Math.sin(g.yaw) * (g.width / 2 + 1),
      g.pos[1],
      g.pos[2] + Math.cos(g.yaw) * (g.width / 2 + 1),
    ];
    const s = step(
      {
        ...base,
        mission: { ...base.mission, phase: 'cruise' },
        drone: { ...base.drone, pos: post, wp: 1 },
      },
      t,
      0.05,
    );
    expect(s.mission.phase).toBe('lost');
    expect(s.mission.crashCause).toBe('gate');
  });

  it('crashes with the cause when an obstacle is struck', () => {
    const o = track.obstacles[0];
    const base = createSnapshot(cfg, t);
    const s = step(
      {
        ...base,
        mission: { ...base.mission, phase: 'cruise' },
        drone: { ...base.drone, pos: [o.pos[0], o.pos[1] + 5, o.pos[2]], wp: 1 },
      },
      t,
      0.05,
    );
    expect(s.mission.crashCause).toBe('obstacle');
  });

  it('crashes into the fence', () => {
    const arena = t.arena!;
    const base = createSnapshot(cfg, t);
    const out: Vec3 = [arena.centre[0] + arena.radius, arena.centre[1] + 15, arena.centre[2]];
    const s = step(
      {
        ...base,
        mission: { ...base.mission, phase: 'cruise' },
        drone: { ...base.drone, pos: out, wp: 1 },
      },
      t,
      0.05,
    );
    expect(s.mission.crashCause).toBe('fence');
  });

  it('counts gates flown through and reports them on the instrument line', () => {
    const start = createSnapshot(cfg, t);
    const clear: Snapshot = {
      ...start,
      weather: { ...start.weather, phase: 'clear' as const, phaseLeft: 1e9 },
    };
    const done = Array.from({ length: 400 }).reduce<Snapshot>((acc) => step(acc, t, 0.05), clear);
    expect(done.mission.passed).toBeGreaterThan(0);
    expect(trackLine(done, t)).toContain(`${done.mission.passed} through`);
  });
});

describe('hitsSky', () => {
  const o = { kind: 'balloon' as const, pos: [0, 10, 0] as const, radius: 2 };
  it('is a sphere: the airframe touches within radius plus footprint in any direction', () => {
    expect(hitsSky(o, [3, 10, 0])).toBe(true);
    expect(hitsSky(o, [0, 7, 0])).toBe(true);
    expect(hitsSky(o, [4, 10, 0])).toBe(false);
    expect(hitsSky(o, [0, 5, 0])).toBe(false);
  });
});
