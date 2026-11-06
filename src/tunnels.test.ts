import { describe, expect, it } from 'vitest';
import { goalIndex, runFor, runRoute } from './forestRun';
import { createTerrain } from './terrain';
import { defaultConfig } from './sim';
import {
  hitsTunnel,
  localTo,
  reversed,
  tunnelCarrot,
  tunnelClearance,
  tunnelHold,
  type Tunnel,
} from './tunnels';
import type { Config, Vec3 } from './types';

/** A tunnel along +x from the origin at height 4. */
const tube: Tunnel = {
  entrance: [0, 4, 0],
  exit: [26, 4, 0],
  yaw: 0,
  length: 26,
  inner: 5.4,
  outer: 6.1,
};
const at = (along: number, lat: number, dy: number): Vec3 => [along, 4 + dy, lat];

describe('a tunnel', () => {
  it('lets the airframe through the middle and not through the walls', () => {
    expect(hitsTunnel(tube, at(13, 0, 0))).toBe(false);
    expect(hitsTunnel(tube, at(13, 3, 0))).toBe(false);
    expect(hitsTunnel(tube, at(13, 4.5, 0))).toBe(true);
    expect(hitsTunnel(tube, at(13, 0, -5))).toBe(true);
    expect(hitsTunnel(tube, at(13, 0, 5))).toBe(true);
  });

  it('is clear outside the walls and beyond its ends', () => {
    expect(hitsTunnel(tube, at(13, 12, 0))).toBe(false);
    expect(hitsTunnel(tube, at(-10, 4.5, 0))).toBe(false);
    expect(hitsTunnel(tube, at(40, 4.5, 0))).toBe(false);
  });

  it('measures room inside the bore, outside the tube, and none beyond the ends', () => {
    expect(tunnelClearance(tube, at(13, 0, 0), 5)).toBeCloseTo(5.4 - 1.4, 6);
    expect(tunnelClearance(tube, at(13, 0, 9), 5)).toBeCloseTo(9 - 6.1 - 1.4, 6);
    expect(tunnelClearance(tube, at(-20, 0, 0), 5)).toBe(5);
  });

  it('reads the same either way round', () => {
    const back = reversed(tube);
    expect(localTo(back, tube.exit).along).toBeCloseTo(0, 6);
    expect(localTo(back, tube.entrance).along).toBeCloseTo(26, 6);
    expect(hitsTunnel(back, at(13, 4.5, 0))).toBe(true);
  });

  it('draws the drone onto the axis and holds its height only when heading the right way', () => {
    const tunnels = [tube];
    const carrot = tunnelCarrot(tunnels, at(-20, 3, 0), 0);
    expect(carrot).not.toBeNull();
    expect(carrot![1]).toBe(4);
    expect(carrot![0]).toBeGreaterThan(-20);
    expect(tunnelHold(tunnels, at(-20, 3, -2), 0)).toBe(4);
    // Heading away from the mouth (and not into the far one), there is nothing to line up for.
    expect(tunnelCarrot(tunnels, at(-20, 3, 0), Math.PI)).toBeNull();
    expect(tunnelHold(tunnels, at(-20, 3, -2), Math.PI)).toBeNull();
    // From the far end, heading back, the reversed tunnel applies.
    expect(tunnelHold(tunnels, at(40, 0, 0), Math.PI)).toBe(4);
  });
});

describe('tunnels on the run', () => {
  const cfg = (seed: number): Config => ({ ...defaultConfig, mode: 'run', biome: 'forest', seed });

  it.each([123, 7, 42])(
    'sit on the line to the goal, clear of trees, and are routed through both ways (seed %i)',
    (seed) => {
      const t = createTerrain(cfg(seed));
      const run = runFor(t, seed);
      expect(run.tunnels.length).toBeGreaterThan(0);
      run.tunnels.forEach((u) => {
        // Level, with the axis above the highest ground along it.
        expect(u.exit[1]).toBe(u.entrance[1]);
        expect(u.entrance[1]).toBeGreaterThan(t.heightAt(u.entrance[0], u.entrance[2]));
        run.trees.forEach((tr) => {
          const { along, lat } = localTo(u, [tr.pos[0], u.entrance[1], tr.pos[2]]);
          const clamped = Math.max(-40, Math.min(u.length + 32, along));
          expect(Math.hypot(along - clamped, lat)).toBeGreaterThan(u.outer + 10);
        });
      });
      const route = runRoute(run);
      expect(route[0]).toEqual(run.start);
      expect(route[goalIndex(run)]).toEqual(run.goal);
      // Out through each tunnel in turn, back through them the other way: two waypoints per pass.
      expect(route.length).toBe(1 + 2 * run.tunnels.length + 1 + 2 * run.tunnels.length);
    },
  );
});
