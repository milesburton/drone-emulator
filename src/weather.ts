import { next, nextRange, ranges } from './rng';
import type { Cloud, Config, Vec2, Vec3, Weather } from './types';

export const CLOUD_COUNT = 14;
const CLOUD_DRIFT = 1.5;
const RAIN_SPEED = 90;
const RAIN_STREAK = 6;

/** Every other cloud is a rain cloud; fixed by index so rain never jumps between clouds. */
export const isStormCloud = (index: number): boolean => index % 2 === 0;

export const generateClouds = (cfg: Config, rng: number): readonly [readonly Cloud[], number] => {
  const extent = cfg.worldSize * 0.6;
  const [xs, r1] = ranges(rng, CLOUD_COUNT, -extent, extent);
  const [zs, r2] = ranges(r1, CLOUD_COUNT, -extent, extent);
  const [ys, r3] = ranges(r2, CLOUD_COUNT, 190, 260);
  const [radii, r4] = ranges(r3, CLOUD_COUNT, 60, 120);
  return [xs.map((x, i) => ({ x, y: ys[i], z: zs[i], radius: radii[i] })), r4];
};

export const createWeather = (cfg: Config, rng: number): readonly [Weather, number] => {
  const [clouds, r1] = generateClouds(cfg, rng);
  return [
    {
      clouds,
      phase: 'clear',
      phaseLeft: 12,
      rain: 0,
      flash: 0,
      nextStrikeIn: 2,
      strike: null,
    },
    r1,
  ];
};

const driftCloud = (cloud: Cloud, cfg: Config, dt: number): Cloud => {
  const limit = cfg.worldSize * 0.72;
  const wrap = (v: number): number => (v > limit ? v - 2 * limit : v < -limit ? v + 2 * limit : v);
  return {
    ...cloud,
    x: wrap(cloud.x + cfg.windX * CLOUD_DRIFT * dt),
    z: wrap(cloud.z + cfg.windZ * CLOUD_DRIFT * dt),
  };
};

export const startStorm = (w: Weather): Weather => ({
  ...w,
  phase: 'storm',
  phaseLeft: 35,
  nextStrikeIn: 1,
});

/** Strongest storm gust, metres per second; close to the drone's airspeed, so a storm can push it well off course. */
export const GUST_MAX = 20;

/** Gust velocity at `time`: nil in clear air, swinging in strength and direction with the rain. */
export const gustAt = (time: number, rain: number): Vec2 => {
  const strength = GUST_MAX * rain * (0.65 + 0.35 * Math.sin(time * 0.9));
  const angle = time * 0.12 + 1.5 * Math.sin(time * 0.31);
  return [Math.cos(angle) * strength, Math.sin(angle) * strength];
};

/** Advances clouds, the clear/storm cycle, rain and lightning by `dt`. */
export const stepWeather = (
  w: Weather,
  cfg: Config,
  dt: number,
  rng: number,
): readonly [Weather, number] => {
  const clouds = w.clouds.map((c) => driftCloud(c, cfg, dt));
  const rain = w.rain + ((w.phase === 'storm' ? 1 : 0) - w.rain) * Math.min(1, dt * 0.5);
  const decayedFlash = Math.max(0, w.flash - dt * 3);

  const [phase, phaseLeft, r1] =
    w.phaseLeft - dt > 0
      ? ([w.phase, w.phaseLeft - dt, rng] as const)
      : (() => {
          const nextPhase = w.phase === 'clear' ? 'storm' : 'clear';
          const [len, r] = nextRange(rng, 25, 50);
          return [nextPhase, len, r] as const;
        })();

  const striking = phase === 'storm' && w.nextStrikeIn - dt <= 0;
  if (!striking) {
    return [
      {
        clouds,
        phase,
        phaseLeft,
        rain,
        flash: decayedFlash,
        nextStrikeIn: phase === 'storm' ? w.nextStrikeIn - dt : 2,
        strike: decayedFlash > 0 ? w.strike : null,
      },
      r1,
    ];
  }

  const stormClouds = clouds.filter((_, i) => isStormCloud(i));
  const [pick, r2] = next(r1);
  const cloud = stormClouds[Math.floor(pick * stormClouds.length)];
  const [jx, r3] = nextRange(r2, -0.5 * cloud.radius, 0.5 * cloud.radius);
  const [jz, r4] = nextRange(r3, -0.5 * cloud.radius, 0.5 * cloud.radius);
  const [wait, r5] = nextRange(r4, 2, 7);
  return [
    {
      clouds,
      phase,
      phaseLeft,
      rain,
      flash: 1,
      nextStrikeIn: wait,
      strike: [cloud.x + jx, cloud.z + jz],
    },
    r5,
  ];
};

/** Deterministic jagged bolt from cloud base to the ground at `strike`. */
export const boltPoints = (
  strike: Vec2,
  topY: number,
  groundY: number,
  segments = 10,
): readonly Vec3[] => {
  const seed = Math.floor(strike[0] * 131 + strike[1] * 977);
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    const [jx] = next(seed + i * 17);
    const [jz] = next(seed + i * 31 + 7);
    const wobble = i === 0 || i === segments ? 0 : 1;
    return [
      strike[0] + (jx - 0.5) * 30 * wobble,
      topY + (groundY - topY) * t,
      strike[1] + (jz - 0.5) * 30 * wobble,
    ] as const;
  });
};

/** Fixed unit-cube offsets for rain drops; positions are derived from time at draw time. */
export const rainDrops = (count: number, seed: number): readonly Vec3[] => {
  const [xs, r1] = ranges(seed, count, 0, 1);
  const [ys, r2] = ranges(r1, count, 0, 1);
  const [zs] = ranges(r2, count, 0, 1);
  return xs.map((x, i) => [x, ys[i], zs[i]] as const);
};

const wrap = (v: number, m: number): number => ((v % m) + m) % m;

/** Base of a cloud, where its rain starts. */
export const cloudBase = (cloud: Cloud): number => cloud.y - 0.2 * cloud.radius;

/**
 * One falling streak (bottom, top) for a fixed drop offset under `cloud`, between the
 * cloud base and the ground; the position is a pure function of time.
 */
export const rainStreak = (
  drop: Vec3,
  cloud: Cloud,
  groundY: number,
  time: number,
): readonly [Vec3, Vec3] => {
  const top = cloudBase(cloud);
  const fall = Math.max(top - groundY, 1);
  const x = cloud.x + (drop[0] - 0.5) * 1.6 * cloud.radius;
  const z = cloud.z + (drop[2] - 0.5) * 1.6 * cloud.radius;
  const y = Math.max(top - wrap(drop[1] * fall + time * RAIN_SPEED, fall), groundY);
  return [
    [x, y, z],
    [x, y + RAIN_STREAK, z],
  ];
};
