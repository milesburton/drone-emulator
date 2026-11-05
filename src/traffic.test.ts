import { describe, expect, it } from 'vitest';
import { distanceTo } from './routes';
import { defaultConfig } from './sim';
import { createTerrain, ROAD_HALF_WIDTH } from './terrain';
import {
  advanceTo,
  carsAt,
  createDrivers,
  createFleet,
  VEHICLES,
  VEHICLES_PER_ROAD,
  VEHICLE_KINDS,
  type Driver,
  type Fleet,
} from './traffic';

const SEEDS = [1, 7, 42, 101, 2024, 54595];
const setup = (seed: number) => {
  const terrain = createTerrain({ ...defaultConfig, seed });
  const drivers = createDrivers(terrain);
  return { terrain, drivers, fleet: createFleet(terrain, drivers) };
};

/** Every second for `seconds`, hand the fleet to `visit`. */
const run = (
  seed: number,
  seconds: number,
  visit: (f: Fleet, drivers: readonly Driver[]) => void,
) => {
  const { terrain, drivers, fleet } = setup(seed);
  Array.from({ length: seconds }).reduce<Fleet>((f, _, n) => {
    const advanced = advanceTo(terrain, drivers, f, n + 1);
    visit(advanced, drivers);
    return advanced;
  }, fleet);
};

describe('traffic', () => {
  it('is deterministic for a map and time', () => {
    const a = setup(7);
    const b = setup(7);
    expect(a.drivers).toEqual(b.drivers);
    expect(advanceTo(a.terrain, a.drivers, a.fleet, 20)).toEqual(
      advanceTo(b.terrain, b.drivers, b.fleet, 20),
    );
  });

  it('puts a fixed number of vehicles on every road', () => {
    SEEDS.forEach((seed) => {
      const { terrain, drivers } = setup(seed);
      expect(drivers).toHaveLength(terrain.routes.roads.length * VEHICLES_PER_ROAD);
    });
  });

  it('keeps vehicles on the tarmac at any time', () => {
    SEEDS.forEach((seed) => {
      const { terrain, drivers, fleet } = setup(seed);
      [0, 30, 120].reduce<Fleet>((f, t) => {
        const advanced = advanceTo(terrain, drivers, f, t);
        carsAt(terrain, drivers, advanced, t).forEach((car) => {
          expect(
            Math.min(...terrain.routes.roads.map((r) => distanceTo(r, car.x, car.z))),
          ).toBeLessThan(ROAD_HALF_WIDTH);
        });
        return advanced;
      }, fleet);
    });
  });

  it('moves vehicles along the road as time passes', () => {
    const { terrain, drivers, fleet } = setup(7);
    const [a] = carsAt(terrain, drivers, fleet, 0);
    const [b] = carsAt(terrain, drivers, advanceTo(terrain, drivers, fleet, 1), 1);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(3);
  });

  it('drives opposite lanes in opposite directions', () => {
    const { terrain, drivers, fleet } = setup(7);
    const cars = carsAt(terrain, drivers, fleet, 0);
    const road = drivers[0].road;
    const forward = cars.find((_, i) => drivers[i].road === road && drivers[i].lane === 1)!;
    const back = cars.find((_, i) => drivers[i].road === road && drivers[i].lane === -1)!;
    expect(Math.cos(forward.yaw - back.yaw)).toBeLessThan(0);
  });

  it('mixes several kinds of vehicle and keeps each within its speed range', () => {
    const drivers = SEEDS.flatMap((seed) => setup(seed).drivers);
    expect(new Set(drivers.map((d) => d.kind)).size).toBeGreaterThanOrEqual(6);
    drivers.forEach((d) => {
      expect(d.speed).toBeGreaterThanOrEqual(VEHICLES[d.kind].min);
      expect(d.speed).toBeLessThanOrEqual(VEHICLES[d.kind].max);
    });
    expect(VEHICLE_KINDS.length).toBe(Object.keys(VEHICLES).length);
  });
});

describe('traffic interaction', () => {
  it('never drives faster than the driver wants or backwards', () => {
    SEEDS.slice(0, 3).forEach((seed) =>
      run(seed, 90, (f, drivers) =>
        f.vehicles.forEach((v, i) => {
          expect(v.v).toBeGreaterThanOrEqual(0);
          expect(v.v).toBeLessThanOrEqual(drivers[i].speed + 0.5);
        }),
      ),
    );
  });

  it('keeps vehicles from driving through each other', () => {
    SEEDS.forEach((seed) => {
      const { terrain } = setup(seed);
      const length = terrain.cfg.worldSize * 2;
      run(seed, 150, (f, drivers) =>
        f.vehicles.forEach((a, i) =>
          f.vehicles.forEach((b, j) => {
            if (j <= i || drivers[i].road !== drivers[j].road) return;
            if (Math.abs(a.off - b.off) > 1.5) return;
            const same = drivers[i].lane === drivers[j].lane;
            const raw = same ? b.p - a.p : length - a.p - b.p;
            const gap = Math.abs(((((raw + length / 2) % length) + length) % length) - length / 2);
            const reach = (VEHICLES[drivers[i].kind].length + VEHICLES[drivers[j].kind].length) / 2;
            expect(gap).toBeGreaterThan(reach * 0.5);
          }),
        ),
      );
    });
  });

  it('queues behind a slower vehicle instead of driving through it', () => {
    const { terrain, drivers, fleet } = setup(7);
    const after = advanceTo(terrain, drivers, fleet, 60);
    const following = after.vehicles.filter((v, i) => v.v < drivers[i].speed - 1);
    expect(following.length).toBeGreaterThan(0);
  });

  it('lets a faster vehicle pull into the other lane to pass a slower one', () => {
    const passes = SEEDS.map((seed) => {
      let count = 0;
      run(seed, 240, (f, drivers) =>
        f.vehicles.forEach((v, i) => {
          if (v.passing >= 0 && Math.abs(v.off - drivers[i].lane * 2) > 3.9) count += 1;
        }),
      );
      return count;
    });
    expect(passes.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('completes passes: a passer ends up ahead of the vehicle it passed, back in its own lane', () => {
    const seen = new Set<string>();
    const returned = new Set<string>();
    SEEDS.forEach((seed) =>
      run(seed, 240, (f, drivers) =>
        f.vehicles.forEach((v, i) => {
          const key = `${seed}:${i}`;
          if (v.passing >= 0) seen.add(key);
          else if (seen.has(key) && Math.abs(v.off - drivers[i].lane * 2) < 0.1) returned.add(key);
        }),
      ),
    );
    expect(seen.size).toBeGreaterThan(0);
    expect(returned.size).toBeGreaterThan(0);
  });
});
