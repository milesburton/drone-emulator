import type { Vec3 } from './types';

export const WIND_BOX = 500;
const WIND_DEPTH = 140;
const WIND_VISUAL_SPEED = 4;
const MAX_STREAK = 45;

export const windSpeed = (windX: number, windZ: number): number => Math.hypot(windX, windZ);

const wrap = (v: number, m: number): number => ((v % m) + m) % m;

/** Keeps a world-anchored lattice moving with the wind inside a box centred on `centre`. */
const drift = (offset: number, centre: number, velocity: number, time: number): number =>
  centre +
  wrap(offset * WIND_BOX + velocity * WIND_VISUAL_SPEED * time - centre + WIND_BOX / 2, WIND_BOX) -
  WIND_BOX / 2;

/** One faint streak (head, tail) for a fixed offset; position is a pure function of time. */
export const streakSegment = (
  offset: Vec3,
  windX: number,
  windZ: number,
  time: number,
  centre: Vec3,
): readonly [Vec3, Vec3] => {
  const speed = windSpeed(windX, windZ);
  const x = drift(offset[0], centre[0], windX, time);
  const z = drift(offset[2], centre[2], windZ, time);
  const y = centre[1] + (offset[1] - 0.5) * WIND_DEPTH;
  const length = Math.min(MAX_STREAK, 4 + speed * 2);
  const [ux, uz] = speed > 1e-6 ? [windX / speed, windZ / speed] : [0, 0];
  return [
    [x, y, z],
    [x - ux * length, y, z - uz * length],
  ];
};
