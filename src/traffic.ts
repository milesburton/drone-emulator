import { pointAt, tangentAt } from './routes';
import { toRandomFn } from './rng';
import type { Terrain } from './terrain';

export type VehicleKind =
  'car' | 'pickup' | 'van' | 'truck' | 'semi' | 'bus' | 'motorcycle' | 'tractor';

/** Share of traffic, and the speed range in m/s, for each kind of vehicle. */
export const VEHICLES: Readonly<
  Record<VehicleKind, { readonly weight: number; readonly min: number; readonly max: number }>
> = {
  car: { weight: 0.34, min: 9, max: 21 },
  pickup: { weight: 0.14, min: 8, max: 19 },
  van: { weight: 0.14, min: 8, max: 17 },
  truck: { weight: 0.1, min: 7, max: 14 },
  semi: { weight: 0.07, min: 7, max: 13 },
  bus: { weight: 0.06, min: 6, max: 12 },
  motorcycle: { weight: 0.12, min: 12, max: 26 },
  tractor: { weight: 0.03, min: 3, max: 6 },
};
export const VEHICLE_KINDS = Object.keys(VEHICLES) as readonly VehicleKind[];

export interface Car {
  readonly kind: VehicleKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Rotation about +y that points the model's +z at the direction of travel. */
  readonly yaw: number;
  /** Index into CAR_COLOURS. */
  readonly paint: number;
}

/** What a car is before it has a position: fixed by the seed, so it never changes during play. */
export interface Driver {
  readonly kind: VehicleKind;
  readonly road: number;
  readonly lane: 1 | -1;
  readonly speed: number;
  readonly start: number;
  readonly paint: number;
}

export const CAR_COLOURS = [
  0xc0392b, 0x2c5aa0, 0xe8e8e8, 0x1e1e22, 0xd4a017, 0x3a7d44, 0x8a8f96,
] as const;
export const VEHICLES_PER_ROAD = 14;
const LANE_OFFSET = 2;

const pickKind = (roll: number): VehicleKind => {
  const total = VEHICLE_KINDS.reduce((sum, k) => sum + VEHICLES[k].weight, 0);
  let acc = 0;
  return VEHICLE_KINDS.find((k) => (acc += VEHICLES[k].weight / total) >= roll) ?? 'car';
};

/** Drivers for every road; the same map always has the same traffic. */
export const createDrivers = (terrain: Terrain): readonly Driver[] => {
  const random = toRandomFn(terrain.cfg.seed ^ 0x7ac1);
  return terrain.routes.roads.flatMap((_, road) =>
    Array.from({ length: VEHICLES_PER_ROAD }, (__, n) => {
      const kind = pickKind(random());
      const { min, max } = VEHICLES[kind];
      return {
        kind,
        road,
        lane: n % 2 === 0 ? (1 as const) : (-1 as const),
        speed: min + random() * (max - min),
        start: random() * terrain.cfg.worldSize * 2,
        paint: Math.floor(random() * CAR_COLOURS.length),
      };
    }),
  );
};

/** Wraps into [0, length). */
const wrap = (value: number, length: number): number => ((value % length) + length) % length;

/**
 * A pure function of time, so cars need no state: each drives its road end to end at
 * constant speed and reappears at the start. Traffic keeps left (opposite lanes go opposite ways).
 */
export const carsAt = (
  terrain: Terrain,
  drivers: readonly Driver[],
  time: number,
): readonly Car[] => {
  const length = terrain.cfg.worldSize * 2;
  return drivers.map((d) => {
    const road = terrain.routes.roads[d.road];
    const travelled = wrap(d.start + d.speed * time, length);
    const s = d.lane === 1 ? travelled - length / 2 : length / 2 - travelled;
    const [px, pz] = pointAt(road, s);
    const [tx, tz] = tangentAt(road, s);
    const heading = d.lane === 1 ? 1 : -1;
    const x = px - tz * LANE_OFFSET * d.lane;
    const z = pz + tx * LANE_OFFSET * d.lane;
    return {
      kind: d.kind,
      x,
      y: terrain.deckAt(road, s),
      z,
      yaw: Math.atan2(tx * heading, tz * heading),
      paint: d.paint,
    };
  });
};
