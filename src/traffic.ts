import { pointAt, tangentAt } from './routes';
import { toRandomFn } from './rng';
import type { Terrain } from './terrain';

export type VehicleKind =
  'car' | 'pickup' | 'van' | 'truck' | 'semi' | 'bus' | 'motorcycle' | 'tractor';

export interface VehicleSpec {
  /** Share of traffic. */
  readonly weight: number;
  /** Desired cruising speed range, m/s. */
  readonly min: number;
  readonly max: number;
  /** Bumper to bumper, metres. */
  readonly length: number;
  /** Comfortable acceleration, m/s^2. */
  readonly accel: number;
  /** Whether this kind will pull out to pass a slower vehicle. */
  readonly overtakes: boolean;
}

export const VEHICLES: Readonly<Record<VehicleKind, VehicleSpec>> = {
  car: { weight: 0.34, min: 9, max: 21, length: 4.3, accel: 2.2, overtakes: true },
  pickup: { weight: 0.14, min: 8, max: 19, length: 5.4, accel: 2.0, overtakes: true },
  van: { weight: 0.14, min: 8, max: 17, length: 5.3, accel: 1.8, overtakes: true },
  truck: { weight: 0.1, min: 7, max: 14, length: 8.2, accel: 1.3, overtakes: false },
  semi: { weight: 0.07, min: 7, max: 13, length: 16, accel: 1.0, overtakes: false },
  bus: { weight: 0.06, min: 6, max: 12, length: 11, accel: 1.2, overtakes: false },
  motorcycle: { weight: 0.12, min: 12, max: 26, length: 1.9, accel: 3.2, overtakes: true },
  tractor: { weight: 0.03, min: 3, max: 6, length: 4, accel: 0.8, overtakes: false },
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
export const VEHICLES_PER_ROAD = 32;
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

/** The road is a loop of this length for traffic; vehicles leave one end and reappear at the other. */
const roadLength = (terrain: Terrain): number => terrain.cfg.worldSize * 2;

/** What changes while driving. Aligned by index with the drivers. */
export interface Vehicle {
  /** Distance travelled along the road in its own direction of travel, wrapped to [0, length). */
  readonly p: number;
  readonly v: number;
  /** Sideways position from the road centre line: the lane centre is `lane * LANE_OFFSET`. */
  readonly off: number;
  readonly vlat: number;
  /** Where the driver is steering to: own lane, or the opposite one while passing. */
  readonly target: number;
  /** Index of the vehicle being passed, or -1. */
  readonly passing: number;
  /** True while dropping back behind the vehicle being passed because traffic is coming. */
  readonly abort: boolean;
}

export interface Fleet {
  readonly time: number;
  readonly vehicles: readonly Vehicle[];
}

export const STEP = 0.05;
const MAX_STEPS_PER_CALL = 200;
const LATERAL_RATE = 2;
const SAME_LANE = 1.9;
const COMFORT_BRAKE = 3;
const MAX_BRAKE = 9;
const MIN_GAP = 2;
const HEADWAY = 1.2;
const LOOK_AHEAD = 250;
const OVERTAKE_TRIGGER_GAP = 30;
const OVERTAKE_MIN_EDGE = 2;
const OVERTAKE_MAX_TIME = 15;

const wrap = (value: number, length: number): number => ((value % length) + length) % length;
const wrapSigned = (value: number, length: number): number =>
  wrap(value + length / 2, length) - length / 2;

/** Drivers start spread evenly along each lane, so nobody starts on top of anybody else. */
export const createFleet = (terrain: Terrain, drivers: readonly Driver[]): Fleet => {
  const length = roadLength(terrain);
  const groups = new Map<string, number[]>();
  drivers.forEach((d, i) => {
    const key = `${d.road}:${d.lane}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const slot = (i: number): number => {
    const members = groups.get(`${drivers[i].road}:${drivers[i].lane}`) ?? [i];
    const n = members.indexOf(i);
    const jitter = (drivers[i].start / length) % 1;
    return ((n + 0.2 + 0.6 * jitter) / members.length) * length;
  };
  return {
    time: 0,
    vehicles: drivers.map((d, i) => ({
      p: slot(i),
      v: d.speed,
      off: d.lane * LANE_OFFSET,
      vlat: 0,
      target: d.lane * LANE_OFFSET,
      passing: -1,
      abort: false,
    })),
  };
};

/** Intelligent Driver Model: acceleration given the gap to, and speed of, whatever is ahead. */
const idm = (
  v: number,
  desired: number,
  accel: number,
  gap: number,
  leaderSpeed: number,
): number => {
  const wanted =
    MIN_GAP +
    Math.max(0, v * HEADWAY + (v * (v - leaderSpeed)) / (2 * Math.sqrt(accel * COMFORT_BRAKE)));
  return accel * (1 - (v / desired) ** 4 - (wanted / Math.max(gap, 0.1)) ** 2);
};

const stepFleet = (drivers: readonly Driver[], length: number, fleet: Fleet): Fleet => {
  const vs = fleet.vehicles;
  const byRoad = new Map<number, number[]>();
  drivers.forEach((d, i) => byRoad.set(d.road, [...(byRoad.get(d.road) ?? []), i]));
  /** Signed distance of j ahead of i along i's direction of travel. */
  const ahead = (i: number, j: number): number =>
    wrapSigned(
      drivers[i].lane === drivers[j].lane ? vs[j].p - vs[i].p : length - vs[i].p - vs[j].p,
      length,
    );
  const speedAlong = (i: number, j: number): number =>
    drivers[i].lane === drivers[j].lane ? vs[j].v : -vs[j].v;
  const half = (i: number, j: number): number =>
    (VEHICLES[drivers[i].kind].length + VEHICLES[drivers[j].kind].length) / 2;

  const next = vs.map((me, i): Vehicle => {
    const d = drivers[i];
    const spec = VEHICLES[d.kind];
    const others = (byRoad.get(d.road) ?? []).filter((j) => j !== i);
    const home = d.lane * LANE_OFFSET;
    const away = -home;

    // Everything that would block me where I am now, as (bumper gap, speed along my direction).
    const blockers = others
      .map((j) => ({ j, r: ahead(i, j) }))
      .filter(
        ({ j, r }) =>
          r > 0 &&
          r < LOOK_AHEAD &&
          // In my lane, or steering into it: I give way to a vehicle that is merging.
          (Math.abs(me.off - vs[j].off) < SAME_LANE || Math.abs(me.off - vs[j].target) < SAME_LANE),
      )
      .map(({ j, r }) => ({ j, gap: r - half(i, j), speed: speedAlong(i, j) }));
    // Dropping back: the vehicle I was passing is still my leader, whatever lane I am in.
    const dropBack =
      me.abort &&
      me.passing >= 0 &&
      ahead(i, me.passing) > -(half(i, me.passing) + 10) &&
      !blockers.some((b) => b.j === me.passing)
        ? [
            {
              j: me.passing,
              gap: ahead(i, me.passing) - half(i, me.passing),
              speed: speedAlong(i, me.passing),
            },
          ]
        : [];
    const acc = Math.max(
      -MAX_BRAKE,
      [...blockers, ...dropBack].reduce(
        (a, b) => Math.min(a, idm(me.v, d.speed, spec.accel, b.gap, b.speed)),
        idm(me.v, d.speed, spec.accel, Number.POSITIVE_INFINITY, me.v),
      ),
    );

    const settled = Math.abs(me.off - home) < 0.05 && me.passing < 0;
    const leader = blockers
      .filter((b) => drivers[b.j].lane === d.lane && b.gap < OVERTAKE_TRIGGER_GAP)
      .sort((a, b) => a.gap - b.gap)[0];
    // Averaged over the pull-out: a queued car does not start the pass at full speed.
    const edge = leader ? (me.v + d.speed) / 2 - leader.speed : 0;
    const time = leader
      ? (leader.gap + VEHICLES[drivers[leader.j].kind].length + spec.length + 24) /
        Math.max(edge, 0.1)
      : 0;
    const clearToPass =
      leader !== undefined &&
      others.every((j) => {
        if (j === leader.j || Math.abs(vs[j].off - away) >= 2.4) return true;
        const r = ahead(i, j);
        return drivers[j].lane === d.lane
          ? r < -35 || r > 80
          : r < -20 || r > (d.speed + vs[j].v) * time * 1.3 + 80;
      });
    const startPass =
      settled &&
      spec.overtakes &&
      leader !== undefined &&
      edge >= OVERTAKE_MIN_EDGE &&
      time <= OVERTAKE_MAX_TIME &&
      clearToPass;

    const passedBy = me.passing >= 0 ? ahead(i, me.passing) : 0;
    const passed = me.passing >= 0 && passedBy < -(half(i, me.passing) + 10);
    const homeFree = (behind: number, front: number): boolean =>
      others.every((j) => {
        if (Math.abs(vs[j].off - home) >= 2.4) return true;
        const r = ahead(i, j);
        return drivers[j].lane === d.lane
          ? r < -(half(i, j) + behind) || r > half(i, j) + front
          : r < -10 || r > 80;
      });
    const ownLaneFree = passed && homeFree(10, 14);
    // Traffic heading for the lane I am passing in, before I am back: give up and drop back.
    const closing = others.some((j) => {
      const r = ahead(i, j);
      return (
        drivers[j].lane !== d.lane &&
        Math.abs(vs[j].off - away) < 2.4 &&
        r > -10 &&
        r < (me.v + vs[j].v) * 7 + 40
      );
    });
    const aborting = !passed && me.passing >= 0 && (me.abort || closing);
    const backInLine =
      aborting && me.passing >= 0 && passedBy - half(i, me.passing) > 6 && homeFree(6, 6);

    // Past one vehicle of a platoon but no gap to pull back into: carry on to the next one.
    const nextAhead =
      passed && !ownLaneFree
        ? others
            .map((j) => ({ j, r: ahead(i, j) }))
            .filter(
              ({ j, r }) =>
                r > 0 &&
                r < 120 &&
                drivers[j].lane === d.lane &&
                Math.abs(vs[j].off - home) < SAME_LANE,
            )
            .sort((a, b) => a.r - b.r)[0]
        : undefined;
    const passing =
      startPass && leader
        ? leader.j
        : ownLaneFree || backInLine
          ? -1
          : (nextAhead?.j ?? me.passing);
    const target = startPass ? away : ownLaneFree || backInLine ? home : me.target;
    const step = Math.min(Math.max(target - me.off, -LATERAL_RATE * STEP), LATERAL_RATE * STEP);
    const v = Math.max(0, me.v + acc * STEP);
    return {
      p: wrap(me.p + ((me.v + v) / 2) * STEP, length),
      v,
      off: me.off + step,
      vlat: step / STEP,
      target,
      passing,
      abort: aborting && !backInLine && !ownLaneFree,
    };
  });
  return { time: fleet.time + STEP, vehicles: next };
};

/** Runs the traffic forward in fixed steps up to `time`; the same map always plays out the same way. */
export const advanceTo = (
  terrain: Terrain,
  drivers: readonly Driver[],
  fleet: Fleet,
  time: number,
): Fleet => {
  const length = roadLength(terrain);
  const steps = Math.min(Math.floor((time - fleet.time) / STEP), MAX_STEPS_PER_CALL);
  return Array.from({ length: Math.max(steps, 0) }).reduce<Fleet>(
    (f) => stepFleet(drivers, length, f),
    fleet,
  );
};

/** Where every vehicle is at `time`, a little past the last step so motion stays smooth. */
export const carsAt = (
  terrain: Terrain,
  drivers: readonly Driver[],
  fleet: Fleet,
  time: number,
): readonly Car[] => {
  const length = roadLength(terrain);
  const lag = Math.min(Math.max(time - fleet.time, 0), STEP);
  return drivers.map((d, i) => {
    const me = fleet.vehicles[i];
    const road = terrain.routes.roads[d.road];
    const travelled = wrap(me.p + me.v * lag, length);
    const s = d.lane === 1 ? travelled - length / 2 : length / 2 - travelled;
    const [px, pz] = pointAt(road, s);
    const [tx, tz] = tangentAt(road, s);
    const heading = d.lane === 1 ? 1 : -1;
    const off = me.off + me.vlat * lag;
    // Velocity is along the road plus the sideways drift of a lane change, so the nose follows it.
    const vx = tx * heading * me.v - tz * me.vlat;
    const vz = tz * heading * me.v + tx * me.vlat;
    return {
      kind: d.kind,
      x: px - tz * off,
      y: terrain.deckAt(road, s),
      z: pz + tx * off,
      yaw: me.v > 0.1 ? Math.atan2(vx, vz) : Math.atan2(tx * heading, tz * heading),
      paint: d.paint,
    };
  });
};
