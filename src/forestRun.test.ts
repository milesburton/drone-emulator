import { describe, expect, it } from 'vitest';
import { animalAt, animalsFor, hitsAnimal } from './animals';
import {
  GOAL_CLEARING,
  GOAL_DISTANCE,
  goalIndex,
  hitsLimb,
  hitsTrunk,
  PAD_CLEARING,
  runFor,
  runRoute,
  strikes,
  type Branch,
  type RunTree,
} from './forestRun';
import { buildAnimals, buildRun } from './runModel';
import { applyConfig, createSnapshot, defaultConfig, step } from './sim';
import { createTerrain } from './terrain';
import type { Config, Snapshot } from './types';

const cfgFor = (seed: number): Config => ({
  ...defaultConfig,
  mode: 'run',
  biome: 'forest',
  seed,
});
const SEEDS = [123, 19, 7, 42, 1337];

describe('the run', () => {
  it.each(SEEDS)(
    'is deterministic and puts the goal on dry ground, well away from the pad (seed %i)',
    (seed) => {
      const t = createTerrain(cfgFor(seed));
      const run = runFor(t, seed);
      expect(runFor(t, seed)).toBe(run);
      expect(run.start).toEqual(t.pad);
      expect(t.heightAt(run.goal[0], run.goal[2])).toBeGreaterThan(t.waterLevel + 3);
      const distance = Math.hypot(run.goal[0] - run.start[0], run.goal[2] - run.start[2]);
      expect(distance).toBeGreaterThan(GOAL_DISTANCE * 0.5);
      expect(distance).toBeLessThanOrEqual(GOAL_DISTANCE);
    },
  );

  it.each(SEEDS)(
    'grows trunks the airframe fits between, and clearings round the pad and goal (seed %i)',
    (seed) => {
      const t = createTerrain(cfgFor(seed));
      const { trees, start, goal } = runFor(t, seed);
      expect(trees.length).toBeGreaterThan(40);
      trees.forEach((a, i) => {
        expect(Math.hypot(a.pos[0] - start[0], a.pos[2] - start[2])).toBeGreaterThan(PAD_CLEARING);
        expect(Math.hypot(a.pos[0] - goal[0], a.pos[2] - goal[2])).toBeGreaterThan(GOAL_CLEARING);
        expect(a.pos[1]).toBeCloseTo(t.heightAt(a.pos[0], a.pos[2]), 6);
        trees.slice(i + 1).forEach((b) => {
          // Edge to edge, a 3 m airframe fits with room to spare.
          const gap = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) - a.radius - b.radius;
          expect(gap).toBeGreaterThan(6);
        });
      });
    },
  );

  it('hangs limbs from trunks, within the band the drone flies in', () => {
    const t = createTerrain(cfgFor(7));
    const { trees, branches } = runFor(t, 7);
    expect(branches.length).toBeGreaterThan(20);
    branches.forEach((b) => {
      const trunk = trees.find((tr) => tr.pos[0] === b.from[0] && tr.pos[2] === b.from[2]);
      expect(trunk).toBeDefined();
      const above = b.from[1] - trunk!.pos[1];
      expect(above).toBeGreaterThanOrEqual(1.5);
      expect(above).toBeLessThanOrEqual(5.6);
    });
  });
});

describe('striking the forest', () => {
  const tree: RunTree = {
    kind: 'tree',
    species: 'conifer',
    pos: [0, 0, 0],
    radius: 0.5,
    height: 14,
  };
  const limb: Branch = { from: [0, 3, 0], to: [4, 3, 0], radius: 0.3 };

  it('hits a trunk within its radius plus the airframe footprint, at any height in the band', () => {
    expect(hitsTrunk(tree, [1.8, 3, 0])).toBe(true);
    expect(hitsTrunk(tree, [0, 6, 1.8])).toBe(true);
    expect(hitsTrunk(tree, [2.1, 3, 0])).toBe(false);
  });

  it('hits a limb within its radius plus the footprint of any point along it', () => {
    expect(hitsLimb(limb, [2, 3, 1.6])).toBe(true);
    expect(hitsLimb(limb, [2, 3, 1.9])).toBe(false);
    expect(hitsLimb(limb, [2, 6, 0])).toBe(false);
    expect(hitsLimb(limb, [5.5, 3, 0])).toBe(true);
  });

  it('finds a trunk or limb from the real forest and nothing in open air', () => {
    const t = createTerrain(cfgFor(7));
    const run = runFor(t, 7);
    const tr = run.trees[0];
    expect(strikes(run, [tr.pos[0], tr.pos[1] + 3.5, tr.pos[2]])).toBe(true);
    expect(strikes(run, [run.start[0], run.start[1] + 10, run.start[2]])).toBe(false);
  });
});

describe('animals', () => {
  it('are deterministic, patrol a fixed path and return to where they began', () => {
    const t = createTerrain(cfgFor(7));
    const animals = animalsFor(t, 7);
    expect(animalsFor(t, 7)).toBe(animals);
    expect(animals.some((a) => a.kind === 'deer')).toBe(true);
    expect(animals.some((a) => a.kind === 'bird')).toBe(true);
    animals.forEach((a) => {
      const length = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]);
      const lap = (2 * length) / a.speed;
      const a0 = animalAt(t, a, 5).pos;
      const a1 = animalAt(t, a, 5 + lap).pos;
      expect(a1[0]).toBeCloseTo(a0[0], 3);
      expect(a1[2]).toBeCloseTo(a0[2], 3);
      // Never beyond the ends of its path.
      const x = a0[0];
      expect(x).toBeGreaterThanOrEqual(Math.min(a.from[0], a.to[0]) - 1e-6);
      expect(x).toBeLessThanOrEqual(Math.max(a.from[0], a.to[0]) + 1e-6);
    });
  });

  it('are struck within their radius plus the footprint, and not outside it', () => {
    const t = createTerrain(cfgFor(7));
    const a = animalsFor(t, 7).find((x) => x.kind === 'bird')!;
    const state = animalAt(t, a, 3);
    expect(hitsAnimal(state, [state.pos[0] + a.radius + 1, state.pos[1], state.pos[2]])).toBe(true);
    expect(hitsAnimal(state, [state.pos[0] + a.radius + 2, state.pos[1], state.pos[2]])).toBe(
      false,
    );
  });
});

describe('drawing the run', () => {
  it('builds a mesh for every tree and limb, the goal and every animal', () => {
    const t = createTerrain(cfgFor(7));
    const run = runFor(t, 7);
    expect(buildRun(run).children.length).toBe(
      run.trees.length + run.branches.length + run.tunnels.length + 1,
    );
    const view = buildAnimals(animalsFor(t, 7));
    expect(view.group.children.length).toBe(animalsFor(t, 7).length);
    expect(() => view.update(t, 12)).not.toThrow();
  });
});

describe('flying the run', () => {
  const fly = (s: Snapshot, t: ReturnType<typeof createTerrain>, seconds: number): Snapshot =>
    Array.from({ length: seconds * 20 }).reduce<Snapshot>((acc) => step(acc, t, 0.05), s);

  it.each([123, 7, 42])(
    'reaches the goal run after run without a crash, and times each (seed %i)',
    (seed) => {
      const cfg = cfgFor(seed);
      const t = createTerrain(cfg);
      const start = createSnapshot(cfg, t);
      const done = fly(
        { ...start, weather: { ...start.weather, phase: 'clear', phaseLeft: 1e9 } },
        t,
        120,
      );
      expect(done.mission.crashed).toBe(0);
      expect(done.mission.laps).toBeGreaterThanOrEqual(2);
      expect(done.mission.bestLap!).toBeGreaterThan(5);
      expect(done.mission.bestLap!).toBeLessThan(20);
    },
    60_000,
  );

  it('switching to the run mode from a sortie re-homes the drone with a route to the goal', () => {
    const cfg = { ...defaultConfig, biome: 'forest' as const };
    const t = createTerrain(cfg);
    const [s, nt] = applyConfig(createSnapshot(cfg, t), t, { mode: 'run' });
    const run = runFor(nt, cfg.seed);
    expect(s.waypoints).toEqual(runRoute(run));
    expect(s.waypoints[0]).toEqual(run.start);
    expect(s.waypoints[goalIndex(run)]).toEqual(run.goal);
    expect(s.mission.home).toEqual(run.start);
  });
});
