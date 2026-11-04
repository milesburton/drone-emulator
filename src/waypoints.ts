import { CLEARANCE, seatWaypoint } from './altitude';
import { ranges } from './rng';
import { pointAt } from './routes';
import type { Terrain } from './terrain';
import type { Config, Vec3 } from './types';

export { CLEARANCE };
export const WAYPOINT_COUNT = 6;
export const RIVER_WAYPOINTS = 14;

const place = seatWaypoint;

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

/** Evenly spaced points down the river and back up again, so the loop never cuts across country. */
export const riverWaypoints = (
  terrain: Terrain,
  count: number = RIVER_WAYPOINTS,
): readonly Vec3[] => {
  const { river } = terrain.routes;
  if (!river) return [];
  const half = terrain.cfg.worldSize * 0.42;
  const down = Array.from({ length: count }, (_, i) => {
    const [x, z] = pointAt(river, -half + (2 * half * i) / (count - 1));
    return place(terrain, x, z);
  });
  return [...down, ...down.slice(1, -1).reverse()];
};
