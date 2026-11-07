import { describe, expect, it } from 'vitest';
import { applyConfig, createSnapshot, defaultConfig, step } from './sim';
import { createTerrain } from './terrain';
import { trackFor } from './track';
import { gateAt, trackRoute, TRACK_SPEED } from './trackFlight';
import type { Config, Snapshot } from './types';

const DT = 0.05;
const cfgFor = (seed: number): Config => ({ ...defaultConfig, mode: 'track', seed, rivals: 0 });
const run = (s: Snapshot, terrain: ReturnType<typeof createTerrain>, seconds: number): Snapshot =>
  Array.from({ length: Math.round(seconds / DT) }).reduce<Snapshot>(
    (acc) => step(acc, terrain, DT),
    s,
  );

describe('track route', () => {
  it('starts at the pad, ends on gate 0 and then an exit point, and visits the gates in order', () => {
    const t = createTerrain(cfgFor(7));
    const track = trackFor(t, 7);
    const route = trackRoute(t, 7);
    expect(route[0]).toEqual(track.start);
    expect(route[route.length - 2]).toEqual(track.gates[0].pos);
    route
      .slice(1, -1)
      .forEach((p, i) => expect(p).toEqual(track.gates[i % track.gates.length].pos));
    expect(gateAt(0, 9)).toBeNull();
    expect(gateAt(10, 9)).toEqual({ gate: 0, lap: 1 });
  });
});

describe('flying the track', () => {
  it.each([11, 2024, 6])(
    'laps seed %i, flying far more gates than it crashes at, and times each lap',
    (seed) => {
      const cfg = { ...cfgFor(seed), windX: 0, windZ: 0 };
      const t = createTerrain(cfg);
      const start = createSnapshot(cfg, t);
      // Clear, still air for the whole run: gusts as strong as the drone's airspeed are a different test.
      const done = run(
        { ...start, weather: { ...start.weather, phase: 'clear', phaseLeft: 1e9 } },
        t,
        300,
      );
      // The autopilot is a simple pursuer: it flies most gates cleanly but not every one (see FPV-TRACK-PLAN.md).
      expect(done.mission.passed).toBeGreaterThan(done.mission.crashed * 3);
      expect(done.mission.laps).toBeGreaterThanOrEqual(2);
      expect(done.mission.bestLap).not.toBeNull();
      expect(done.mission.lastLap!).toBeLessThan(done.mission.bestLap! * 1.3);
      // Lap time is close to lap length over the track speed.
      const track = trackFor(t, seed);
      const length = track.gates.reduce((sum, g, i) => {
        const n = track.gates[(i + 1) % track.gates.length].pos;
        return sum + Math.hypot(n[0] - g.pos[0], n[2] - g.pos[2]);
      }, 0);
      // Corners are cut inside the 20 m arrival radius, so a lap runs a little short of the polygon.
      expect(done.mission.bestLap!).toBeGreaterThan((length / TRACK_SPEED) * 0.8);
      expect(done.mission.bestLap!).toBeLessThan((length / TRACK_SPEED) * 1.5);
    },
    60_000,
  );

  it('switching mode re-homes onto the track pad with a track route', () => {
    const t = createTerrain({ ...defaultConfig, seed: 7 });
    const [s, nt] = applyConfig(createSnapshot({ ...defaultConfig, seed: 7 }, t), t, {
      mode: 'track',
    });
    expect(s.mission.home).toEqual(trackFor(nt, 7).start);
    expect(s.waypoints).toEqual(trackRoute(nt, 7));
    expect(s.drone.pos).toEqual(s.mission.home);
  });
});

describe('legs outside the loop', () => {
  // Seeds that once clipped a tree, a pylon or a neighbouring gate on the way out, the exit or the way home.
  it.each([123, 19, 7, 99])(
    'seed %i flies a whole sortie, takeoff to landing, without a crash',
    (seed) => {
      const cfg = cfgFor(seed);
      const t = createTerrain(cfg);
      const start = createSnapshot(cfg, t);
      const done = run(
        { ...start, weather: { ...start.weather, phase: 'clear', phaseLeft: 1e9 } },
        t,
        240,
      );
      expect(done.mission.crashed).toBe(0);
      expect(done.mission.passed).toBeGreaterThan(20);
    },
    60_000,
  );
});
