import { ranges } from './rng';
import type { Terrain } from './terrain';
import type { Config, Vec3 } from './types';

export const CLEARANCE = 40;
export const WAYPOINT_COUNT = 6;

const place = (terrain: Terrain, x: number, z: number): Vec3 => [
  x,
  terrain.heightAt(x, z) + CLEARANCE,
  z,
];

export const generateWaypoints = (
  cfg: Config,
  terrain: Terrain,
  rng: number,
  count: number = WAYPOINT_COUNT,
): readonly [readonly Vec3[], number] => {
  const half = cfg.worldSize * 0.4;
  const [xs, r1] = ranges(rng, count, -half, half);
  const [zs, r2] = ranges(r1, count, -half, half);
  return [xs.map((x, i) => place(terrain, x, zs[i])), r2];
};

/** Re-seats waypoint heights after the terrain changes. */
export const retarget = (waypoints: readonly Vec3[], terrain: Terrain): readonly Vec3[] =>
  waypoints.map(([x, , z]) => place(terrain, x, z));
