import { describe, expect, it } from 'vitest';
import { distanceTo } from './routes';
import { defaultConfig } from './sim';
import { createTerrain, ROAD_HALF_WIDTH } from './terrain';
import { VEHICLES, VEHICLES_PER_ROAD, VEHICLE_KINDS, carsAt, createDrivers } from './traffic';

const SEEDS = [1, 7, 42, 101, 2024, 54595];

describe('traffic', () => {
  it('is deterministic for a map and time', () => {
    const terrain = createTerrain({ ...defaultConfig, seed: 7 });
    const drivers = createDrivers(terrain);
    expect(createDrivers(terrain)).toEqual(drivers);
    expect(carsAt(terrain, drivers, 12.5)).toEqual(carsAt(terrain, drivers, 12.5));
  });

  it('puts a fixed number of cars on every road', () => {
    SEEDS.forEach((seed) => {
      const terrain = createTerrain({ ...defaultConfig, seed });
      expect(createDrivers(terrain)).toHaveLength(terrain.routes.roads.length * VEHICLES_PER_ROAD);
    });
  });

  it('keeps cars on the tarmac at any time', () => {
    SEEDS.forEach((seed) => {
      const terrain = createTerrain({ ...defaultConfig, seed });
      const drivers = createDrivers(terrain);
      [0, 30, 600, 5000].forEach((t) =>
        carsAt(terrain, drivers, t).forEach((car) => {
          expect(
            Math.min(...terrain.routes.roads.map((r) => distanceTo(r, car.x, car.z))),
          ).toBeLessThan(ROAD_HALF_WIDTH);
        }),
      );
    });
  });

  it('moves cars along the road as time passes', () => {
    const terrain = createTerrain({ ...defaultConfig, seed: 7 });
    const drivers = createDrivers(terrain);
    const [a] = carsAt(terrain, drivers, 0);
    const [b] = carsAt(terrain, drivers, 1);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(5);
  });

  it('drives opposite lanes in opposite directions', () => {
    const terrain = createTerrain({ ...defaultConfig, seed: 7 });
    const drivers = createDrivers(terrain);
    const cars = carsAt(terrain, drivers, 3);
    const forward = cars.find((_, i) => drivers[i].lane === 1)!;
    const back = cars.find((_, i) => drivers[i].lane === -1)!;
    expect(Math.cos(forward.yaw - back.yaw)).toBeLessThan(0);
  });

  it('mixes several kinds of vehicle and keeps each within its speed range', () => {
    const drivers = SEEDS.flatMap((seed) =>
      createDrivers(createTerrain({ ...defaultConfig, seed })),
    );
    expect(new Set(drivers.map((d) => d.kind)).size).toBeGreaterThanOrEqual(6);
    drivers.forEach((d) => {
      expect(d.speed).toBeGreaterThanOrEqual(VEHICLES[d.kind].min);
      expect(d.speed).toBeLessThanOrEqual(VEHICLES[d.kind].max);
    });
    expect(VEHICLE_KINDS.length).toBe(Object.keys(VEHICLES).length);
  });
});
