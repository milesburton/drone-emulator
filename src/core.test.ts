import { describe, expect, it } from 'vitest';
import { initEkf, MEASUREMENT_MATRIX, predict, update, windBiasOf } from './ekf';
import { identity, inverse, mul, symmetrise, trace, transpose } from './matrix';
import { gaussians, next, nextGaussian, ranges, toRandomFn } from './rng';
import {
  applyConfig,
  createSnapshot,
  defaultConfig,
  pressureAt,
  randomisePath,
  step,
  triggerStorm,
} from './sim';
import { colourAt, createTerrain, terrainKey } from './terrain';
import { CLEARANCE, generateWaypoints, retarget } from './waypoints';
import { boltPoints, rainDrops, startStorm, stepWeather, createWeather } from './weather';
import type { Snapshot } from './types';

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o as object).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};

describe('rng', () => {
  it('is deterministic and stays within [0, 1)', () => {
    const [a, s] = next(42);
    expect(next(42)).toEqual([a, s]);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('threads state so consecutive draws differ', () => {
    const [a, s] = next(1);
    const [b] = next(s);
    expect(a).not.toBe(b);
  });

  it('produces roughly standard-normal gaussians', () => {
    const [values] = gaussians(7, 4000);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.08);
    expect(variance).toBeGreaterThan(0.85);
    expect(variance).toBeLessThan(1.15);
    expect(Number.isFinite(nextGaussian(0)[0])).toBe(true);
  });

  it('draws ranges within bounds', () => {
    const [values] = ranges(3, 200, -5, 5);
    expect(values.every((v) => v >= -5 && v < 5)).toBe(true);
  });

  it('adapts a seed to a repeatable random function', () => {
    const a = toRandomFn(5);
    const b = toRandomFn(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('matrix', () => {
  it('inverts a matrix that needs pivoting', () => {
    const m = [
      [0, 2, 1],
      [1, 1, 0],
      [3, 0, 1],
    ];
    const product = mul(m, inverse(m));
    identity(3).forEach((row, i) =>
      row.forEach((v, j) => expect(product[i][j]).toBeCloseTo(v, 10)),
    );
  });

  it('throws when singular', () => {
    expect(() =>
      inverse([
        [1, 2],
        [2, 4],
      ]),
    ).toThrow(/singular/);
  });

  it('transposes, symmetrises and traces', () => {
    const m = [
      [1, 2],
      [4, 3],
    ];
    expect(transpose(m)).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(symmetrise(m)).toEqual([
      [1, 3],
      [3, 3],
    ]);
    expect(trace(m)).toBe(4);
  });
});

describe('ekf', () => {
  it('estimates a constant wind from noisy GPS and barometer readings', () => {
    const dt = 0.05;
    const air = [20, 0] as const;
    const wind = [5, -3];
    const truthPressure = 1000;
    const initial = initEkf([0, 0, 0, 0, truthPressure + 2], [25, 25, 100, 100, 1]);
    const final = Array.from({ length: 1600 }).reduce<{
      ekf: typeof initial;
      pos: readonly number[];
      rng: number;
    }>(
      ({ ekf, pos, rng }) => {
        const nextPos = [pos[0] + (air[0] + wind[0]) * dt, pos[1] + (air[1] + wind[1]) * dt];
        const [n, r] = gaussians(rng, 3);
        const z = [nextPos[0] + n[0] * 3, nextPos[1] + n[1] * 3, truthPressure + n[2] * 0.3];
        return {
          ekf: update(
            predict(ekf, air, dt, [0.05, 0.05, 0.02, 0.02, 1.5]),
            z,
            MEASUREMENT_MATRIX,
            [9, 9, 0.09],
          ),
          pos: nextPos,
          rng: r,
        };
      },
      { ekf: initial, pos: [0, 0], rng: 11 },
    );
    const [wx, wz] = windBiasOf(final.ekf);
    expect(Math.abs(wx - wind[0])).toBeLessThan(1);
    expect(Math.abs(wz - wind[1])).toBeLessThan(1);
    expect(Math.abs(final.ekf.x[4] - truthPressure)).toBeLessThan(0.5);
  });

  it('reduces uncertainty on update and grows it on predict', () => {
    const e = initEkf([0, 0, 0, 0, 1000], [25, 25, 100, 100, 1]);
    const predicted = predict(e, [10, 0], 0.5, [0.05, 0.05, 0.02, 0.02, 1.5]);
    expect(trace(predicted.P)).toBeGreaterThan(trace(e.P));
    const updated = update(predicted, [5, 0, 1000], MEASUREMENT_MATRIX, [9, 9, 0.09]);
    expect(trace(updated.P)).toBeLessThan(trace(predicted.P));
  });

  it('does not mutate its input', () => {
    const e = deepFreeze(initEkf([0, 0, 0, 0, 1000], [1, 1, 1, 1, 1]));
    expect(() =>
      update(predict(e, [1, 1], 0.1, [1, 1, 1, 1, 1]), [0, 0, 1000], MEASUREMENT_MATRIX, [1, 1, 1]),
    ).not.toThrow();
  });
});

describe('terrain', () => {
  const cfg = defaultConfig;

  it('is deterministic for a given config', () => {
    const a = createTerrain(cfg);
    const b = createTerrain(cfg);
    expect(a.heightAt(120, -80)).toBe(b.heightAt(120, -80));
  });

  it('changes with the seed', () => {
    const a = createTerrain(cfg);
    const b = createTerrain({ ...cfg, seed: 99 });
    expect(a.heightAt(120, -80)).not.toBe(b.heightAt(120, -80));
  });

  it('scales height with terrainScale', () => {
    const lo = createTerrain({ ...cfg, river: false, terrainScale: 20 });
    const hi = createTerrain({ ...cfg, river: false, terrainScale: 100 });
    expect(Math.abs(hi.heightAt(50, 50))).toBeGreaterThan(Math.abs(lo.heightAt(50, 50)));
  });

  it('carves the river below the water level', () => {
    const withRiver = createTerrain(cfg);
    const samples = Array.from({ length: 80 }, (_, i) => -400 + i * 10).flatMap((x) =>
      Array.from({ length: 80 }, (_, j) => withRiver.heightAt(x, -400 + j * 10)),
    );
    expect(Math.min(...samples)).toBeLessThan(withRiver.waterLevel);
    const dry = createTerrain({ ...cfg, river: false });
    expect(terrainKey(cfg)).not.toBe(terrainKey({ ...cfg, river: false }));
    expect(dry.heightAt(0, 0)).toBeTypeOf('number');
  });

  it('colours by elevation band', () => {
    const t = createTerrain({ ...defaultConfig, river: false });
    const [sr, , sb] = colourAt(t.waterLevel, t);
    const [hr, hg, hb] = colourAt(t.waterLevel + t.cfg.terrainScale * 1.3 * 0.3, t);
    const [wr, wg, wb] = colourAt(t.waterLevel + t.cfg.terrainScale * 1.3, t);
    expect(sr).toBeGreaterThan(sb);
    expect(hg).toBeGreaterThan(hr);
    expect(hg).toBeGreaterThan(hb);
    expect(wr).toBeGreaterThan(0.9);
    expect(wg).toBeGreaterThan(0.9);
    expect(wb).toBeGreaterThan(0.9);
  });
});

describe('waypoints', () => {
  const terrain = createTerrain(defaultConfig);

  it('generates deterministic points inside the world, above the ground', () => {
    const [a] = generateWaypoints(defaultConfig, terrain, 1);
    const [b] = generateWaypoints(defaultConfig, terrain, 1);
    expect(a).toEqual(b);
    a.forEach(([x, y, z]) => {
      expect(Math.abs(x)).toBeLessThanOrEqual(defaultConfig.worldSize / 2);
      expect(y).toBeCloseTo(terrain.heightAt(x, z) + CLEARANCE);
    });
  });

  it('retargets heights to new terrain, keeping x/z', () => {
    const [points] = generateWaypoints(defaultConfig, terrain, 1);
    const taller = createTerrain({ ...defaultConfig, terrainScale: 120 });
    const moved = retarget(points, taller);
    expect(moved.map((p) => [p[0], p[2]])).toEqual(points.map((p) => [p[0], p[2]]));
    expect(moved[0][1]).toBeCloseTo(taller.heightAt(points[0][0], points[0][2]) + CLEARANCE);
  });
});

describe('weather', () => {
  const [initial] = createWeather(defaultConfig, 5);

  it('drifts clouds with the wind', () => {
    const [after] = stepWeather(initial, { ...defaultConfig, windX: 10, windZ: 0 }, 1, 5);
    expect(after.clouds[0].x).toBeGreaterThan(initial.clouds[0].x - 1e-9);
    expect(after.clouds[0].z).toBeCloseTo(initial.clouds[0].z);
  });

  it('wraps clouds that leave the world', () => {
    const edge = { ...initial, clouds: [{ x: 719, y: 200, z: 0, radius: 80 }] };
    const [after] = stepWeather(edge, { ...defaultConfig, windX: 20, windZ: 0 }, 1, 5);
    expect(after.clouds[0].x).toBeLessThan(0);
  });

  it('builds up rain and fires lightning in a storm, then clears', () => {
    const storm = startStorm(initial);
    const [struck] = stepWeather({ ...storm, nextStrikeIn: 0.01 }, defaultConfig, 0.1, 9);
    expect(struck.flash).toBe(1);
    expect(struck.strike).not.toBeNull();
    const [fading] = stepWeather(struck, defaultConfig, 0.2, 9);
    expect(fading.flash).toBeLessThan(1);
    const [raining] = stepWeather(storm, defaultConfig, 1, 9);
    expect(raining.rain).toBeGreaterThan(0);
    const [flipped] = stepWeather({ ...storm, phaseLeft: 0.01 }, defaultConfig, 0.1, 9);
    expect(flipped.phase).toBe('clear');
  });

  it('only lightning during storms', () => {
    const [after] = stepWeather(initial, defaultConfig, 0.1, 5);
    expect(after.flash).toBe(0);
    expect(after.strike).toBeNull();
  });

  it('draws a bolt from cloud to ground and fixed rain offsets', () => {
    const bolt = boltPoints([100, -50], 200, 10);
    expect(bolt[0][1]).toBe(200);
    expect(bolt[bolt.length - 1][1]).toBe(10);
    expect(boltPoints([100, -50], 200, 10)).toEqual(bolt);
    const drops = rainDrops(50, 3);
    expect(drops).toHaveLength(50);
    expect(drops.every((d) => d.every((v) => v >= 0 && v < 1))).toBe(true);
  });
});

describe('sim', () => {
  const terrain = createTerrain(defaultConfig);
  const start = createSnapshot(defaultConfig, terrain);

  it('does not mutate the previous snapshot', () => {
    const frozen = deepFreeze(createSnapshot(defaultConfig, terrain));
    expect(() => step(frozen, terrain, 0.05)).not.toThrow();
    expect(frozen.time).toBe(0);
  });

  it('is deterministic', () => {
    expect(step(start, terrain, 0.05)).toEqual(step(start, terrain, 0.05));
  });

  const run = (s: Snapshot, seconds: number): Snapshot =>
    Array.from({ length: Math.round(seconds / 0.05) }).reduce<Snapshot>(
      (acc) => step(acc, terrain, 0.05),
      s,
    );

  it('flies the waypoint list and advances to the next point', () => {
    const later = run(start, 60);
    expect(later.time).toBeCloseTo(60);
    expect(later.drone.wp).not.toBe(start.drone.wp);
  });

  it('keeps the drone above terrain', () => {
    const later = run(start, 30);
    const [x, y, z] = later.drone.pos;
    expect(y).toBeGreaterThan(terrain.heightAt(x, z));
  });

  it('keeps the estimate close to the truth', () => {
    const later = run(start, 60);
    const [x, , z] = later.drone.pos;
    expect(Math.hypot(later.ekf.x[0] - x, later.ekf.x[1] - z)).toBeLessThan(6);
    expect(Math.abs(later.ekf.x[2] - defaultConfig.windX)).toBeLessThan(2.5);
  });

  it('models pressure falling with altitude', () => {
    expect(pressureAt(100)).toBeLessThan(pressureAt(0));
  });

  it('rebuilds terrain only when needed', () => {
    const [windOnly, sameTerrain] = applyConfig(start, terrain, { windX: 12 });
    expect(sameTerrain).toBe(terrain);
    expect(windOnly.config.windX).toBe(12);
    const [scaled, newTerrain] = applyConfig(start, terrain, { terrainScale: 100 });
    expect(newTerrain).not.toBe(terrain);
    expect(scaled.waypoints[0][1]).toBeCloseTo(
      newTerrain.heightAt(scaled.waypoints[0][0], scaled.waypoints[0][2]) + CLEARANCE,
    );
  });

  it('randomises the path and can trigger a storm', () => {
    const fresh = randomisePath(start, terrain);
    expect(fresh.waypoints).not.toEqual(start.waypoints);
    expect(fresh.drone.wp).toBe(0);
    expect(triggerStorm(start).weather.phase).toBe('storm');
  });
});
