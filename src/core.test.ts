import { describe, expect, it } from 'vitest';
import { CLEARANCE as CRUISE, MIN_CLEARANCE, flightLine, nextAltitude } from './altitude';
import { initEkf, MEASUREMENT_MATRIX, predict, update, windBiasOf } from './ekf';
import { identity, inverse, mul, symmetrise, trace, transpose } from './matrix';
import { gaussians, next, nextGaussian, ranges, toRandomFn } from './rng';
import {
  applyConfig,
  createSnapshot,
  defaultConfig,
  followRiver,
  pressureAt,
  randomisePath,
  step,
  triggerStorm,
  turnTowards,
} from './sim';
import { createRoutes, distanceTo, pointAt, tangentAt } from './routes';
import {
  colourAt,
  createTerrain,
  gridCoords,
  roadRibbon,
  terrainCoords,
  terrainKey,
} from './terrain';
import { CLEARANCE, generateWaypoints, retarget, riverWaypoints } from './waypoints';
import {
  boltPoints,
  cloudBase,
  createWeather,
  isStormCloud,
  rainDrops,
  rainStreak,
  startStorm,
  stepWeather,
} from './weather';
import { streakSegment, WIND_BOX } from './wind';
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
    const lo = createTerrain({ ...cfg, lakes: false, river: false, terrainScale: 20 });
    const hi = createTerrain({ ...cfg, lakes: false, river: false, terrainScale: 100 });
    expect(Math.abs(hi.heightAt(50, 50))).toBeGreaterThan(Math.abs(lo.heightAt(50, 50)));
  });

  it('carves lakes below the water level', () => {
    const wet = createTerrain({ ...cfg, river: false, roads: false });
    const samples = Array.from({ length: 80 }, (_, i) => -400 + i * 10).flatMap((x) =>
      Array.from({ length: 80 }, (_, j) => wet.heightAt(x, -400 + j * 10)),
    );
    expect(Math.min(...samples)).toBeLessThan(wet.waterLevel);
    expect(terrainKey(cfg)).not.toBe(terrainKey({ ...cfg, lakes: false }));
  });

  it('keys the terrain on every feature toggle', () => {
    const keys = [cfg, { ...cfg, river: false }, { ...cfg, roads: false }].map(terrainKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('runs a river channel below the water level along its whole length', () => {
    const t = createTerrain({ ...cfg, lakes: false });
    const { river } = t.routes;
    expect(river).not.toBeNull();
    for (let s = -450; s <= 450; s += 30) {
      const [x, z] = pointAt(river!, s);
      expect(t.heightAt(x, z)).toBeLessThan(t.waterLevel);
    }
  });

  it('extends the land far beyond the playable world', () => {
    const t = createTerrain(cfg);
    const coords = terrainCoords(t);
    expect(coords[0]).toBeCloseTo(-t.extent);
    expect(coords.at(-1)).toBeCloseTo(t.extent);
    expect(t.extent).toBeGreaterThan(cfg.worldSize * 2);
  });

  it('drapes roads above the ground and the water', () => {
    const t = createTerrain(cfg);
    const ribbon = roadRibbon(t.routes.roads[0], t);
    expect(ribbon.length).toBe(terrainCoords(t).length * 2);
    ribbon.forEach(([, y]) => expect(y).toBeGreaterThan(t.waterLevel));
  });

  it('keeps roads on dry land except where they bridge the river', () => {
    [1337, 7, 42, 2024].forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      const river = t.routes.river;
      t.routes.roads.forEach((road) =>
        terrainCoords(t)
          .filter((s) => Math.abs(s) <= t.cfg.worldSize / 2)
          .forEach((s) => {
            const [x, z] = pointAt(road, s);
            const nearRiver = river !== null && distanceTo(river, x, z) < 45;
            if (!nearRiver) expect(t.heightAt(x, z)).toBeGreaterThan(t.waterLevel);
          }),
      );
    });
  });

  it('colours by elevation band', () => {
    const t = createTerrain({ ...defaultConfig, lakes: false, river: false });
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

describe('routes', () => {
  it('is deterministic and respects the feature toggles', () => {
    const a = createRoutes(defaultConfig);
    const b = createRoutes(defaultConfig);
    expect(a.river!.offsetAt(123)).toBe(b.river!.offsetAt(123));
    expect(a.roads).toHaveLength(2);
    const none = createRoutes({ ...defaultConfig, river: false, roads: false });
    expect(none.river).toBeNull();
    expect(none.roads).toHaveLength(0);
  });

  it('measures zero distance on the route and grows away from it', () => {
    const { river } = createRoutes(defaultConfig);
    const [x, z] = pointAt(river!, 100);
    expect(distanceTo(river!, x, z)).toBeCloseTo(0);
    expect(distanceTo(river!, x, z + 50)).toBeGreaterThan(20);
  });

  it('has unit tangents for both axes', () => {
    const { river, roads } = createRoutes(defaultConfig);
    [river!, ...roads].forEach((route) => {
      const [tx, tz] = tangentAt(route, 40);
      expect(Math.hypot(tx, tz)).toBeCloseTo(1);
    });
  });

  it('grades grid spacing outwards without gaps', () => {
    const coords = gridCoords(500, 4500, 159, 40);
    expect(coords).toHaveLength(159 + 1 + 80);
    expect(coords.every((v, i) => i === 0 || v > coords[i - 1])).toBe(true);
    expect(coords[0]).toBeCloseTo(-4500);
    const centreStep = coords[120] - coords[119];
    const edgeStep = coords.at(-1)! - coords.at(-2)!;
    expect(edgeStep).toBeGreaterThan(centreStep * 5);
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

describe('wind streaks', () => {
  const centre = [10, 50, -20] as const;

  it('stays inside a box around the viewer and moves downwind', () => {
    const [a] = streakSegment([0.3, 0.5, 0.7], 8, 0, 0, centre);
    const [b] = streakSegment([0.3, 0.5, 0.7], 8, 0, 5, centre);
    expect(b[0]).not.toBeCloseTo(a[0]);
    [a, b].forEach((p) => {
      expect(Math.abs(p[0] - centre[0])).toBeLessThanOrEqual(WIND_BOX / 2);
      expect(Math.abs(p[2] - centre[2])).toBeLessThanOrEqual(WIND_BOX / 2);
    });
  });

  it('trails behind the head, along the wind', () => {
    const [head, tail] = streakSegment([0.1, 0.2, 0.3], 0, -10, 2, centre);
    expect(tail[2]).toBeGreaterThan(head[2]);
    expect(tail[0]).toBeCloseTo(head[0]);
  });

  it('collapses to a point in still air', () => {
    const [head, tail] = streakSegment([0.1, 0.2, 0.3], 0, 0, 2, centre);
    expect(tail).toEqual(head);
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

  it('rains from the base of storm clouds down to the ground', () => {
    const cloud = initial.clouds[0];
    expect(isStormCloud(0)).toBe(true);
    expect(isStormCloud(1)).toBe(false);
    [0, 1.3, 4.7].forEach((time) => {
      const [bottom, top] = rainStreak([0.2, 0.6, 0.9], cloud, 0, time);
      expect(bottom[1]).toBeGreaterThanOrEqual(0);
      expect(top[1]).toBeGreaterThan(bottom[1]);
      expect(bottom[1]).toBeLessThanOrEqual(cloudBase(cloud));
      expect(Math.abs(bottom[0] - cloud.x)).toBeLessThanOrEqual(cloud.radius);
    });
  });

  it('strikes from underneath a storm cloud', () => {
    const storm = startStorm(initial);
    const cfg = { ...defaultConfig, windX: 0, windZ: 0 };
    const [struck] = stepWeather({ ...storm, nextStrikeIn: 0 }, cfg, 0.1, 9);
    const [sx, sz] = struck.strike!;
    const beneath = struck.clouds.some(
      (c, i) => isStormCloud(i) && Math.hypot(c.x - sx, c.z - sz) <= c.radius,
    );
    expect(beneath).toBe(true);
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

  const fly = (cfg: typeof defaultConfig, steps: number): readonly Snapshot[] => {
    const t = createTerrain(cfg);
    return Array.from({ length: steps }).reduce<Snapshot[]>(
      (acc) => [...acc, step(acc[acc.length - 1], t, 0.05)],
      [createSnapshot(cfg, t)],
    );
  };

  it('never clips the terrain, even on steep ground', () => {
    [1337, 7, 42].forEach((seed) => {
      const cfg = { ...defaultConfig, seed, terrainScale: 120 };
      const t = createTerrain(cfg);
      fly(cfg, 6000).forEach(({ drone: { pos } }) =>
        expect(pos[1] - t.heightAt(pos[0], pos[2])).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6),
      );
    });
  });

  it('climbs and descends gently on ordinary terrain', () => {
    [1337, 7, 42].forEach((seed) => {
      const states = fly({ ...defaultConfig, seed }, 6000);
      const rates = states
        .slice(1)
        .map((s, i) => Math.abs(s.drone.pos[1] - states[i].drone.pos[1]) / 0.05);
      expect(Math.max(...rates)).toBeLessThan(25);
    });
  });

  it('starts climbing before a hill and eases altitude towards the target', () => {
    const y = nextAltitude(terrain, 100, 0, 0, 0, 0.05);
    expect(y).toBeGreaterThanOrEqual(terrain.heightAt(0, 0) + MIN_CLEARANCE);
    expect(Math.abs(y - 100)).toBeLessThan(10);
  });

  it('draws a flight line that stays above the ground', () => {
    const line = flightLine(start.waypoints, terrain);
    expect(line.length).toBeGreaterThan(start.waypoints.length);
    line.forEach(([x, y, z]) => expect(y).toBeGreaterThanOrEqual(terrain.heightAt(x, z) + CRUISE));
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

  it('follows the river out and back', () => {
    const onRiver = followRiver(start, terrain);
    expect(onRiver.waypoints).toEqual(riverWaypoints(terrain));
    expect(onRiver.waypoints.length).toBe(2 * 14 - 2);
    const { river } = terrain.routes;
    onRiver.waypoints.forEach(([x, , z]) => expect(distanceTo(river!, x, z)).toBeLessThan(1));
    expect(onRiver.drone.wp).toBeLessThan(onRiver.waypoints.length);
    expect(start.waypoints).not.toEqual(onRiver.waypoints);
  });

  it('leaves the path alone when there is no river', () => {
    const dry = createTerrain({ ...defaultConfig, river: false });
    expect(followRiver(start, dry)).toBe(start);
  });

  it('randomises the path and can trigger a storm', () => {
    const fresh = randomisePath(start, terrain);
    expect(fresh.waypoints).not.toEqual(start.waypoints);
    expect(fresh.drone.wp).toBe(0);
    expect(triggerStorm(start).weather.phase).toBe('storm');
  });
});

describe('smooth turning', () => {
  it('turns by at most the step and takes the short way round', () => {
    expect(turnTowards(0, 1, 0.1)).toBeCloseTo(0.1);
    expect(turnTowards(0, -1, 0.1)).toBeCloseTo(-0.1);
    expect(turnTowards(3, -3, 0.1)).toBeCloseTo(3.1);
    expect(turnTowards(0, 0.05, 0.1)).toBeCloseTo(0.05);
  });
});
