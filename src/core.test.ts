import { describe, expect, it } from 'vitest';
import { CLEARANCE as CRUISE, MIN_CLEARANCE, flightLine, nextAltitude } from './altitude';
import { initEkf, MEASUREMENT_MATRIX, predict, update, windBiasOf } from './ekf';
import { identity, inverse, mul, symmetrise, trace, transpose } from './matrix';
import { gaussians, next, nextGaussian, ranges, toRandomFn } from './rng';
import {
  applyConfig,
  createSnapshot,
  defaultConfig,
  drawSeed,
  followRiver,
  MAX_SEED,
  newMap,
  AIR_SPEED,
  parseSeed,
  pressureAt,
  randomisePath,
  step,
  triggerStorm,
  turnTowards,
} from './sim';
import { characterOf } from './character';
import { craftAt } from './craft';
import { hasImpacted, surfaceAt } from './crash';
import {
  drainRate,
  ENERGY_BUDGET,
  failureReason,
  findPad,
  fitToRange,
  GROUND_TIME,
  isLost,
  MAX_ATTEMPTS,
  planRoute,
  RESERVE,
  returnEnergy,
  routeEnergy,
  routeLength,
  routeLimit,
  shouldReturn,
} from './mission';
import { crossTrack, statusOf } from './status';
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
  gustAt,
  isStormCloud,
  rainDrops,
  rainStreak,
  startStorm,
  stepWeather,
} from './weather';
import { bankFor, MAX_PITCH, MAX_ROLL, nextAttitude, pitchFor } from './attitude';
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

  it('lays roads clear of the ground and the water, bridging whatever is below', () => {
    [1337, 7, 42, 2024, 9001, 31337].forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      t.routes.roads.forEach((road) =>
        terrainCoords(t)
          .filter((s) => Math.abs(s) <= t.cfg.worldSize / 2)
          .forEach((s) => {
            const [x, z] = pointAt(road, s);
            expect(t.deckAt(road, s)).toBeGreaterThan(t.waterLevel + 2);
            expect(t.deckAt(road, s) - t.heightAt(x, z)).toBeGreaterThan(0.1);
          }),
      );
    });
  });

  it('carries one road over the other where two roads cross', () => {
    let crossings = 0;
    [1337, 7, 42, 2024, 9001, 31337].forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      const [first, ...rest] = t.routes.roads;
      rest
        .filter((road) => road.along !== first.along)
        .forEach((road) => {
          const best = Array.from({ length: 200 }, (_, i) => -500 + i * 5)
            .map((s) => ({ s, d: distanceTo(first, ...pointAt(road, s)) }))
            .reduce((a, b) => (b.d < a.d ? b : a));
          if (best.d > 3) return;
          const [x, z] = pointAt(road, best.s);
          crossings += 1;
          expect(
            t.deckAt(road, best.s) - t.deckAt(first, first.along === 'x' ? x : z),
          ).toBeGreaterThan(4);
        });
    });
    expect(crossings).toBeGreaterThan(0);
  });

  it('keeps road grades gentle and free of kinks', () => {
    [1337, 7, 42, 9001].forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      t.routes.roads.forEach((road) => {
        const decks = Array.from({ length: 160 }, (_, i) => t.deckAt(road, -500 + i * 6.25));
        decks.slice(1).forEach((y, i) => expect(Math.abs(y - decks[i]) / 6.25).toBeLessThan(0.25));
        decks
          .slice(2)
          .forEach((y, i) => expect(Math.abs(y - 2 * decks[i + 1] + decks[i])).toBeLessThan(1.5));
      });
    });
  });

  it('levels the ground under the launch pad', () => {
    [1, 7, 42, 1234, 5555, 31337].forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      const [px, py, pz] = t.pad ?? [0, 0, 0];
      [
        [0, 0],
        [8, 0],
        [-8, 0],
        [0, 8],
        [0, -8],
        [6, 6],
        [-6, -6],
      ].forEach(([dx, dz]) =>
        expect(Math.abs(t.heightAt(px + dx, pz + dz) - py)).toBeLessThan(0.5),
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
    expect(a.roads).toHaveLength(characterOf(defaultConfig.seed).roadCount);
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
  const flat = (): number => 0;

  it('stays inside a box around the viewer and moves downwind', () => {
    const [a] = streakSegment([0.3, 0.5, 0.7], 8, 0, 0, centre, flat);
    const [b] = streakSegment([0.3, 0.5, 0.7], 8, 0, 5, centre, flat);
    expect(b[0]).not.toBeCloseTo(a[0]);
    [a, b].forEach((p) => {
      expect(Math.abs(p[0] - centre[0])).toBeLessThanOrEqual(WIND_BOX / 2);
      expect(Math.abs(p[2] - centre[2])).toBeLessThanOrEqual(WIND_BOX / 2);
    });
  });

  it('rides the terrain: height above ground is constant and the tail follows the slope', () => {
    const slope = (x: number): number => x * 0.5;
    const [head, tail] = streakSegment([0.1, 0.5, 0.3], 10, 0, 3, centre, slope);
    expect(head[1] - slope(head[0])).toBeCloseTo(tail[1] - slope(tail[0]));
    expect(head[1]).not.toBeCloseTo(tail[1]);
  });

  it('trails behind the head, along the wind', () => {
    const [head, tail] = streakSegment([0.1, 0.2, 0.3], 0, -10, 2, centre, flat);
    expect(tail[2]).toBeGreaterThan(head[2]);
    expect(tail[0]).toBeCloseTo(head[0]);
  });

  it('collapses to a point in still air', () => {
    const [head, tail] = streakSegment([0.1, 0.2, 0.3], 0, 0, 2, centre, flat);
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

/** The same snapshot but already up at cruise height over the pad, as if just taken off. */
const cruising = (s: Snapshot): Snapshot => ({
  ...s,
  drone: { ...s.drone, pos: s.waypoints[0], wp: 1 },
  mission: { ...s.mission, phase: 'cruise' },
});
const inFlight = (s: Snapshot): boolean =>
  s.mission.phase === 'cruise' || s.mission.phase === 'returning';

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
      fly(cfg, 6000)
        .filter(inFlight)
        .forEach(({ drone: { pos } }) =>
          expect(pos[1] - t.heightAt(pos[0], pos[2])).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6),
        );
    });
  });

  it('climbs and descends gently on ordinary terrain', () => {
    [1337, 7, 42].forEach((seed) => {
      const states = fly({ ...defaultConfig, seed }, 6000);
      // A lost drone is collected and set back on the pad, which is a jump rather than a flight.
      const rates = states
        .slice(1)
        .map((s, i) => [states[i], s] as const)
        .filter(([before]) => before.mission.phase !== 'lost')
        .map(([before, after]) => Math.abs(after.drone.pos[1] - before.drone.pos[1]) / 0.05);
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
    line.forEach(([x, y, z]) =>
      expect(y).toBeGreaterThanOrEqual(terrain.heightAt(x, z) + CRUISE - 1e-6),
    );
  });

  it('keeps the estimate close to the truth', () => {
    const later = run(start, 60);
    const [x, , z] = later.drone.pos;
    expect(Math.hypot(later.ekf.x[0] - x, later.ekf.x[1] - z)).toBeLessThan(8);
    expect(Math.abs(later.ekf.x[2] - defaultConfig.windX)).toBeLessThan(4);
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
    expect(onRiver.waypoints.slice(1)).toEqual(riverWaypoints(terrain));
    expect(onRiver.waypoints[0]).toEqual(start.waypoints[0]);
    expect(onRiver.waypoints.length).toBe(2 * 14 - 2 + 1);
    const { river } = terrain.routes;
    onRiver.waypoints
      .slice(1)
      .forEach(([x, , z]) => expect(distanceTo(river!, x, z)).toBeLessThan(1));
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
    expect(fresh.drone.wp).toBe(1);
    expect(fresh.waypoints[0]).toEqual(start.waypoints[0]);
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

describe('attitude', () => {
  it('banks into a turn, right-wing-down for a right turn, and limits the bank', () => {
    expect(bankFor(25, 0.2)).toBeGreaterThan(0);
    expect(bankFor(25, -0.2)).toBeLessThan(0);
    expect(bankFor(25, 0)).toBe(0);
    expect(bankFor(25, 5)).toBe(MAX_ROLL);
  });

  it('pitches nose up to climb and down to descend, within limits', () => {
    expect(pitchFor(8)).toBeGreaterThan(pitchFor(0));
    expect(pitchFor(-6)).toBeLessThan(pitchFor(0));
    expect(pitchFor(1000)).toBe(MAX_PITCH);
    expect(pitchFor(-1000)).toBe(-MAX_PITCH);
  });

  it('eases towards the target rather than jumping', () => {
    const start = { pitch: 0, roll: 0 };
    const once = nextAttitude(start, 25, 0.5, 0, 0.05);
    const target = bankFor(25, 0.5);
    expect(once.roll).toBeGreaterThan(0);
    expect(once.roll).toBeLessThan(target);
  });

  it('banks the simulated drone when it is turning towards a waypoint', () => {
    const terrain = createTerrain(defaultConfig);
    const s0 = cruising(createSnapshot(defaultConfig, terrain));
    const behind = { ...s0, drone: { ...s0.drone, heading: s0.drone.heading + 2 } };
    const after = Array.from({ length: 20 }).reduce<Snapshot>(
      (s) => step(s, terrain, 0.05),
      behind,
    );
    expect(Math.abs(after.drone.roll)).toBeGreaterThan(0.2);
  });
});

describe('new maps', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => 101 + i * 2477);
  const base = createSnapshot(defaultConfig, createTerrain(defaultConfig));

  it('draws in-range seeds deterministically and threads the RNG', () => {
    const [a, r] = drawSeed(7);
    expect(drawSeed(7)).toEqual([a, r]);
    expect(Number.isInteger(a) && a >= 0 && a <= MAX_SEED).toBe(true);
    expect(drawSeed(r)[0]).not.toBe(a);
  });

  it('parses only whole seeds in range', () => {
    expect(parseSeed(' 42 ')).toBe(42);
    expect(parseSeed('')).toBeNull();
    expect(parseSeed('4.5')).toBeNull();
    expect(parseSeed('-1')).toBeNull();
    expect(parseSeed(String(MAX_SEED + 1))).toBeNull();
    expect(parseSeed('abc')).toBeNull();
  });

  it('is reproducible per seed and differs between seeds', () => {
    const [s1, t1] = newMap(base, 500);
    const [s2, t2] = newMap(base, 500);
    const [, t3] = newMap(base, 501);
    expect(s1).toEqual(s2);
    expect(t1.heightAt(120, -80)).toBe(t2.heightAt(120, -80));
    expect(t3.heightAt(120, -80)).not.toBe(t1.heightAt(120, -80));
  });

  it('puts the drone and estimator on the new first waypoint and keeps settings', () => {
    const tweaked = { ...base, config: { ...base.config, windX: 11, terrainScale: 90 } };
    const [s, t] = newMap(tweaked, 777);
    expect(s.config).toMatchObject({ seed: 777, windX: 11, terrainScale: 90 });
    expect(s.drone.pos).toEqual(s.mission.home);
    expect(s.mission.phase).toBe('grounded');
    expect(s.drone.pos[1]).toBeGreaterThanOrEqual(t.heightAt(s.drone.pos[0], s.drone.pos[2]));
    expect(s.drone.wp).toBe(1);
    expect(s.ekf.x[0]).toBe(s.drone.pos[0]);
  });

  it.each(seeds)('seed %i gives a sound map', (seed) => {
    const [s, t] = newMap(base, seed);
    const river = t.routes.river;
    if (!river) throw new Error('expected a river');
    const half = s.config.worldSize / 2;
    s.waypoints.forEach(([x, y, z]) => {
      expect(Math.abs(x)).toBeLessThanOrEqual(half);
      expect(Math.abs(z)).toBeLessThanOrEqual(half);
      expect(y - t.heightAt(x, z)).toBeGreaterThanOrEqual(CLEARANCE - 1e-6);
    });
    // Roads never dip into the water or the ground: wet or low stretches are bridges.
    t.routes.roads.forEach((road) => {
      Array.from({ length: 30 }, (_, i) => -450 + i * 30).forEach((s) => {
        const [x, z] = pointAt(road, s);
        expect(t.deckAt(road, s)).toBeGreaterThan(t.waterLevel + 2);
        expect(t.deckAt(road, s) - t.heightAt(x, z)).toBeGreaterThan(0.1);
      });
    });
    const [rx, rz] = pointAt(river, 0);
    expect(Math.max(Math.abs(rx), Math.abs(rz))).toBeLessThan(s.config.worldSize);
    expect(t.heightAt(rx, rz)).toBeLessThan(t.waterLevel + 1);
    // The river stays inside the playable world along its whole length and always holds water.
    Array.from({ length: 21 }, (_, i) =>
      pointAt(river, -half + (i * s.config.worldSize) / 20),
    ).forEach(([x, z]) => {
      expect(Math.abs(z)).toBeLessThan(half);
      expect(t.heightAt(x, z)).toBeLessThan(t.waterLevel);
    });
    expect(t.routes.roads).toHaveLength(characterOf(seed).roadCount);
  });
});

describe('map character', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i * 7919);

  it('is deterministic per seed', () => {
    expect(characterOf(31)).toEqual(characterOf(31));
    expect(characterOf(31)).not.toEqual(characterOf(32));
  });

  it('stays within bounds and actually varies across seeds', () => {
    const all = seeds.map(characterOf);
    all.forEach((c) => {
      expect(c.roadCount).toBeGreaterThanOrEqual(1);
      expect(c.roadCount).toBeLessThanOrEqual(3);
      expect(c.relief).toBeGreaterThanOrEqual(0.7);
      expect(c.relief).toBeLessThanOrEqual(1.4);
      expect(c.waterFraction).toBeLessThan(0.4);
    });
    expect(new Set(all.map((c) => c.roadCount)).size).toBe(3);
    expect(
      Math.max(...all.map((c) => c.relief)) - Math.min(...all.map((c) => c.relief)),
    ).toBeGreaterThan(0.5);
  });

  it('flies the steepest and busiest seeds without clipping', () => {
    const steep = [...seeds]
      .sort(
        (a, b) =>
          characterOf(b).relief * characterOf(b).hillFrequency -
          characterOf(a).relief * characterOf(a).hillFrequency,
      )
      .slice(0, 4);
    steep.forEach((seed) => {
      const cfg = { ...defaultConfig, seed, terrainScale: 120 };
      const t = createTerrain(cfg);
      const states = Array.from({ length: 4000 }).reduce<Snapshot[]>(
        (acc) => [...acc, step(acc[acc.length - 1], t, 0.05)],
        [createSnapshot(cfg, t)],
      );
      states
        .filter(inFlight)
        .forEach(({ drone: { pos } }) =>
          expect(pos[1] - t.heightAt(pos[0], pos[2])).toBeGreaterThanOrEqual(MIN_CLEARANCE - 1e-6),
        );
    });
  });
});

describe('mission', () => {
  const calm = { ...defaultConfig, windX: 0, windZ: 0 };
  const terrain = createTerrain(calm);
  const start = createSnapshot(calm, terrain);
  const tick = (s: Snapshot): Snapshot => step(s, terrain, 0.05);
  const until = (s: Snapshot, done: (s: Snapshot) => boolean, limit = 40000): Snapshot =>
    Array.from({ length: limit }).reduce<Snapshot>((acc) => (done(acc) ? acc : tick(acc)), s);

  it('finds a dry, flat, in-bounds pad for every seed', () => {
    Array.from({ length: 60 }, (_, i) => 101 + i * 2477).forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      const [x, y, z] = findPad(t, seed);
      expect(findPad(t, seed)).toEqual([x, y, z]);
      expect(y).toBeGreaterThan(t.waterLevel);
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThanOrEqual(0.4 * t.cfg.worldSize);
    });
  }, 30000);

  it('plans routes that start over the pad and fit the battery', () => {
    Array.from({ length: 30 }, (_, i) => i * 911).forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      const home = findPad(t, seed);
      const [route] = planRoute(t.cfg, t, seed, home, AIR_SPEED);
      expect(route[0][0]).toBe(home[0]);
      expect(route[0][2]).toBe(home[2]);
      expect(routeLength(route)).toBeLessThanOrEqual(routeLimit(AIR_SPEED));
    });
  });

  it('plans routes that use nearly the whole energy budget, leaving about the reserve', () => {
    [1, 7, 42, 99].forEach((seed) => {
      const t = createTerrain({ ...defaultConfig, seed });
      const [route] = planRoute(t.cfg, t, seed, findPad(t, seed), AIR_SPEED);
      const energy = routeEnergy(route, t, AIR_SPEED);
      expect(energy).toBeLessThanOrEqual(ENERGY_BUDGET);
      expect(energy).toBeGreaterThan(ENERGY_BUDGET - 0.08);
      expect(route.length).toBeGreaterThan(6);
    });
  });

  it('trims a route to the limit but keeps the pad and one more point', () => {
    const route = [
      [0, 0, 0],
      [100, 0, 0],
      [100, 0, 100],
      [0, 0, 100],
    ] as const;
    expect(fitToRange(route, 1000)).toEqual(route);
    expect(fitToRange(route, 350)).toHaveLength(3);
    expect(fitToRange(route, 1)).toHaveLength(2);
  });

  it('waits on the pad, with a steady battery, then takes off', () => {
    expect(start.mission.phase).toBe('grounded');
    const waiting = until(start, (s) => s.time >= GROUND_TIME - 0.5);
    expect(waiting.mission.phase).toBe('grounded');
    expect(waiting.mission.battery).toBe(1);
    expect(waiting.drone.pos).toEqual(start.drone.pos);
    expect(until(start, (s) => s.mission.phase !== 'grounded').time).toBeCloseTo(GROUND_TIME, 0);
  });

  it('flies a whole sortie, lands, scores it and plans a new route', () => {
    const flown = until(start, (s) => s.mission.successes > 0);
    expect(flown.mission).toMatchObject({
      phase: 'grounded',
      successes: 1,
      battery: 1,
      attempt: 0,
      aborted: false,
    });
    // Routes now use nearly the whole battery, so rain can cut an attempt short before one succeeds.
    expect(flown.mission.failures).toBeLessThanOrEqual(MAX_ATTEMPTS);
    expect(flown.drone.pos).toEqual(flown.mission.home);
    expect(flown.waypoints).not.toEqual(start.waypoints);
    expect(flown.mission.totalTrip).toBeGreaterThan(0.9 * routeLength(start.waypoints));
  });

  it('keeps the reserve on an ordinary sortie and meters the trip', () => {
    const trips: number[] = [];
    const lowest = Array.from({ length: 12000 }).reduce<{ s: Snapshot; min: number }>(
      ({ s, min }) => {
        const next = s.mission.successes > 0 ? s : tick(s);
        if (next.mission.phase !== 'grounded' && next.mission.failures === 0)
          trips.push(next.mission.trip);
        return {
          s: next,
          min: Math.min(min, next.mission.successes > 0 ? 1 : next.mission.battery),
        };
      },
      { s: start, min: 1 },
    );
    expect(lowest.min).toBeGreaterThanOrEqual(RESERVE - 0.05);
    expect(trips.every((t, i) => i === 0 || t >= trips[i - 1])).toBe(true);
  });

  it('turns back for the pad when the charge will only just get it home', () => {
    const up = cruising(start);
    const low = { ...up, mission: { ...up.mission, battery: 0.12 } };
    const next = tick(low);
    expect(next.mission).toMatchObject({ phase: 'returning', aborted: true });
    expect(next.mission.lastFailure).toBe('battery');
    expect(next.drone.wp).toBe(0);
    const home = until(next, (s) => s.mission.phase === 'grounded');
    expect(home.mission).toMatchObject({ failures: 1, successes: 0, attempt: 1, battery: 1 });
    expect(home.waypoints).toEqual(start.waypoints);
  });

  it('retries a route, then plans a new one after the allowed failures', () => {
    const sabotage = (s: Snapshot): Snapshot =>
      s.mission.phase === 'cruise' && s.mission.battery > 0.5
        ? { ...s, mission: { ...s.mission, battery: 0.12 } }
        : s;
    const result = Array.from({ length: 60000 }).reduce<Snapshot>(
      (s) => (s.mission.failures >= MAX_ATTEMPTS ? s : tick(sabotage(s))),
      start,
    );
    expect(result.mission).toMatchObject({ failures: MAX_ATTEMPTS, successes: 0, attempt: 0 });
    expect(result.waypoints).not.toEqual(start.waypoints);
  });

  it('blows gusts only in rain, stronger the harder it rains', () => {
    expect(gustAt(12, 0)).toEqual([0, 0]);
    const mild = Math.hypot(...gustAt(12, 0.3));
    expect(Math.hypot(...gustAt(12, 1))).toBeGreaterThan(mild);
    expect(gustAt(12, 1)).toEqual(gustAt(12, 1));
  });

  it('counts a drone as lost only when neither pad nor target is within reach', () => {
    const pos = [300, 40, 0] as const;
    const home = [0, 0, 0] as const;
    const far = [3000, 40, 0] as const;
    const need = returnEnergy(pos, home, [0, 0], 0, AIR_SPEED);
    expect(isLost(need + 0.01, pos, home, far, [0, 0], 0, AIR_SPEED)).toBe(false);
    expect(isLost(need - 0.01, pos, home, far, [0, 0], 0, AIR_SPEED)).toBe(true);
    // Still able to reach a target that is closer than the pad.
    const near = [320, 40, 0] as const;
    expect(isLost(need - 0.01, pos, home, near, [0, 0], 0, AIR_SPEED)).toBe(false);
  });

  it('records a lost drone, then collects it and replans from the pad', () => {
    const up = cruising(start);
    const stranded = {
      ...up,
      drone: { ...up.drone, pos: [900, 60, 900] as const },
      mission: { ...up.mission, battery: 0.01 },
    };
    const down = tick(stranded);
    expect(down.mission.phase).toBe('lost');
    expect(down.mission.downBy).toBe('power');
    expect(statusOf(down)).toBe('lost');
    const back = until(down, (s) => s.mission.phase === 'grounded');
    expect(back.mission).toMatchObject({
      lost: 1,
      failures: 0,
      successes: 0,
      outcome: 'lost',
      battery: 1,
    });
    expect(back.drone.pos).toEqual(back.mission.home);
    expect(back.waypoints).not.toEqual(start.waypoints);
    expect(statusOf(back)).toBe('lost');
    expect(until(back, (s) => s.mission.phase === 'takeoff').mission.outcome).toBeNull();
  });

  it('crashes a drone that runs out of power: it falls, tumbles, hits the terrain and lies still', () => {
    const up = cruising(start);
    const stranded = {
      ...up,
      drone: { ...up.drone, pos: [900, 60, 900] as const },
      mission: { ...up.mission, battery: 0.01 },
    };
    const down = tick(stranded);
    expect(down.drone.crash).toMatchObject({ since: null });
    expect(down.drone.crash?.vel[0]).toBeGreaterThan(0 - 1e-9 - 100);
    const falling = Array.from({ length: 10 }).reduce<Snapshot>((s) => tick(s), down);
    expect(falling.drone.pos[1]).toBeLessThan(down.drone.pos[1]);
    expect(falling.drone.roll).not.toBe(down.drone.roll);
    // Momentum carries it on rather than dropping it straight down.
    expect(
      falling.drone.pos[0] !== down.drone.pos[0] || falling.drone.pos[2] !== down.drone.pos[2],
    ).toBe(true);
    const wrecked = until(down, (s) => hasImpacted(s.drone.crash));
    expect(wrecked.drone.pos[1]).toBeCloseTo(
      surfaceAt(terrain, wrecked.drone.pos[0], wrecked.drone.pos[2]),
      6,
    );
    expect(wrecked.mission.phase).toBe('lost');
    const later = Array.from({ length: 20 }).reduce<Snapshot>((s) => tick(s), wrecked);
    expect(later.drone.pos).toEqual(wrecked.drone.pos);
    expect(later.drone.crash?.since).toBeGreaterThan(0.9);
    // The wreck is only collected a fixed time after the impact, not after the power loss.
    const collected = until(wrecked, (s) => s.mission.phase === 'grounded');
    expect(collected.time - wrecked.time).toBeGreaterThanOrEqual(5 - 0.1);
    expect(collected.drone.crash).toBeUndefined();
  });

  it('crashes a flying drone that finds itself in the terrain', () => {
    const up = cruising(start);
    const [x, , z] = up.drone.pos;
    const buried = {
      ...up,
      drone: { ...up.drone, pos: [x, terrain.heightAt(x, z) - 1, z] as const },
    };
    const after = tick(buried);
    expect(after.mission.phase).toBe('lost');
    expect(after.mission.downBy).toBe('impact');
    expect(statusOf(after)).toBe('crashed');
    expect(after.drone.crash).toBeDefined();
    // A crash is its own metric, waits 10 s on the ground, then resets to the pad.
    const wrecked = until(after, (s) => hasImpacted(s.drone.crash));
    const back = until(wrecked, (s) => s.mission.phase === 'grounded');
    expect(back.time - wrecked.time).toBeGreaterThanOrEqual(10 - 0.1);
    expect(back.mission).toMatchObject({ crashed: 1, lost: 0, outcome: 'crashed', downBy: null });
    expect(back.drone.pos).toEqual(back.mission.home);
    expect(statusOf(back)).toBe('crashed');
  });

  it('crashes a flying drone that touches the water, and it comes down on the surface', () => {
    const up = cruising(start);
    const [x, , z] = up.drone.pos;
    const splash = {
      ...up,
      drone: { ...up.drone, pos: [x, terrain.waterLevel + 0.2, z] as const },
    };
    const after = tick(splash);
    expect(after.mission.phase).toBe('lost');
    expect(after.mission.downBy).toBe('impact');
    const wrecked = until(after, (s) => hasImpacted(s.drone.crash));
    expect(wrecked.drone.pos[1]).toBeGreaterThanOrEqual(terrain.waterLevel - 1e-6);
  });

  it('crashes a flying drone that flies into another craft', () => {
    const up = cruising(start);
    const other = craftAt(up.config.seed, 0, up.time, terrain);
    const collided = { ...up, drone: { ...up.drone, pos: other.pos } };
    const after = tick(collided);
    expect(after.mission.phase).toBe('lost');
    expect(after.mission.downBy).toBe('impact');
    expect(statusOf(after)).toBe('crashed');
  });

  it('reports the state of the flight for colour and badge', () => {
    expect(statusOf(start)).toBe('ready');
    const up = cruising(start);
    expect(statusOf(up)).toBe('onCourse');
    const astray = {
      ...up,
      drone: {
        ...up.drone,
        pos: [up.drone.pos[0], up.drone.pos[1], up.drone.pos[2] + 500] as const,
      },
    };
    expect(statusOf(astray)).toBe('offCourse');
    expect(statusOf({ ...up, mission: { ...up.mission, phase: 'returning' } })).toBe('returning');
    expect(statusOf({ ...start, mission: { ...start.mission, outcome: 'success' } })).toBe(
      'success',
    );
    expect(statusOf({ ...start, mission: { ...start.mission, outcome: 'failed' } })).toBe('failed');
  });

  it('measures how far the drone is from its leg', () => {
    expect(crossTrack([5, 0, 3], [0, 0, 0], [10, 0, 0])).toBeCloseTo(3);
    expect(crossTrack([-4, 0, 3], [0, 0, 0], [10, 0, 0])).toBeCloseTo(5);
    expect(crossTrack([4, 0, 3], [0, 0, 0], [0, 0, 0])).toBeCloseTo(5);
  });

  it('prices the way home higher in rain and into the wind', () => {
    const pos = [300, 40, 0] as const;
    const home = [0, 0, 0] as const;
    const base = returnEnergy(pos, home, [0, 0], 0, AIR_SPEED);
    expect(returnEnergy(pos, home, [0, 0], 1, AIR_SPEED)).toBeGreaterThan(base);
    expect(returnEnergy(pos, home, [10, 0], 0, AIR_SPEED)).toBeGreaterThan(base);
    expect(returnEnergy(pos, home, [-10, 0], 0, AIR_SPEED)).toBeLessThan(base);
    expect(shouldReturn(base + RESERVE + 0.01, pos, home, [0, 0], 0, AIR_SPEED)).toBe(false);
    expect(shouldReturn(base + RESERVE - 0.01, pos, home, [0, 0], 0, AIR_SPEED)).toBe(true);
  });

  it('drains nothing on the ground and more when working harder', () => {
    expect(drainRate('grounded', 0, 0)).toBe(0);
    expect(drainRate('landing', 0, 0)).toBeGreaterThan(drainRate('cruise', 0, 0));
    expect(drainRate('cruise', 8, 0)).toBeGreaterThan(drainRate('cruise', 0, 0));
    expect(drainRate('cruise', 0, 1)).toBeGreaterThan(drainRate('cruise', 0, 0));
  });

  it('names the likeliest reason for turning back', () => {
    expect(failureReason([0, 0], 0.8)).toBe('rain');
    expect(failureReason([12, 0], 0)).toBe('wind');
    expect(failureReason([2, 1], 0)).toBe('battery');
  });
});
