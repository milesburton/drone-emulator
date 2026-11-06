import { describe, expect, it } from 'vitest';
import { defaultConfig } from './sim';
import { buildStreamlines, flowAt, windSpeed } from './streamlines';
import { createTerrain, type Terrain } from './terrain';

const terrain = createTerrain({ ...defaultConfig, seed: 7 });
/** A smooth ramp rising towards +x, to test deflection on known ground. */
const ramp = (slope: number): Terrain => ({ ...terrain, heightAt: (x) => x * slope });

describe('the flow over terrain', () => {
  it('leaves wind on flat ground alone', () => {
    const flat: Terrain = { ...terrain, heightAt: () => 5 };
    const [fx, fz] = flowAt(flat, 8, -3, 100, 40);
    expect(fx).toBeCloseTo(8, 6);
    expect(fz).toBeCloseTo(-3, 6);
  });

  it('turns wind aside along the contours when it blows into a slope, more the steeper it is', () => {
    const gentle = flowAt(ramp(0.1), 10, 0, 0, 0);
    const steep = flowAt(ramp(0.8), 10, 0, 0, 0);
    // Blowing straight into the ramp, the speed into the hill falls.
    expect(Math.abs(gentle[0])).toBeLessThan(10);
    expect(Math.abs(steep[0])).toBeLessThan(Math.abs(gentle[0]));
  });

  it('turns a slanting wind to run along the slope rather than into it', () => {
    const [fx, fz] = flowAt(ramp(0.8), 10, 10, 0, 0);
    expect(Math.abs(fz)).toBeGreaterThan(Math.abs(fx));
  });

  it('does not slow wind that blows downhill', () => {
    const [fx] = flowAt(ramp(0.5), -10, 0, 0, 0);
    expect(fx).toBeCloseTo(-10, 6);
  });
});

describe('streamlines', () => {
  it('are none in still air', () => {
    expect(buildStreamlines(terrain, 0, 0)).toEqual([]);
    expect(windSpeed(3, 4)).toBe(5);
  });

  it('run in long continuous lines across the map, downwind, in a fixed order', () => {
    const lines = buildStreamlines(terrain, 8, 0);
    expect(lines.length).toBeGreaterThan(20);
    expect(buildStreamlines(terrain, 8, 0)).toEqual(lines);
    const limit = terrain.cfg.worldSize * 0.6;
    lines.forEach(({ points, speeds }) => {
      expect(points.length).toBe(speeds.length);
      expect(points.length).toBeGreaterThan(40);
      // Wind from -x: each line starts upwind and ends well downwind of where it began.
      expect(points[points.length - 1][0]).toBeGreaterThan(points[0][0] + limit * 0.5);
    });
  });

  it('are smooth: no sharp turn between neighbouring segments, and a rise that is gentle', () => {
    buildStreamlines(terrain, 6, 5).forEach(({ points }) => {
      points.slice(2).forEach((p, i) => {
        const a = points[i];
        const b = points[i + 1];
        const t1 = Math.atan2(b[2] - a[2], b[0] - a[0]);
        const t2 = Math.atan2(p[2] - b[2], p[0] - b[0]);
        const turn = Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1)));
        expect(turn).toBeLessThan(0.5);
        expect(Math.abs(p[1] - b[1])).toBeLessThan(10);
      });
    });
  });

  it('ride above the ground and never dip below the water', () => {
    buildStreamlines(terrain, -7, 4).forEach(({ points }) =>
      points.forEach(([, y]) => expect(y).toBeGreaterThan(terrain.waterLevel + 2)),
    );
  });

  it('bend where the land does: lines over hilly ground are not all straight', () => {
    const lines = buildStreamlines(terrain, 8, 0);
    const bent = lines.filter(({ points }) => {
      const first = points[0];
      const last = points[points.length - 1];
      return Math.abs(last[2] - first[2]) > 20;
    });
    expect(bent.length).toBeGreaterThan(0);
  });
});
