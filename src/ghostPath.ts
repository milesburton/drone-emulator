import { nextAltitude } from './altitude';
import { turnSmoothly, YAW_ACCEL_PER_RATE } from './smooth';
import type { Terrain } from './terrain';
import type { Config, Vec3 } from './types';

/** Nominal airspeed, turn rate and arrival radius of a sortie (kept in step with sim.ts by a test). */
export const GHOST_AIR_SPEED = 36;
export const GHOST_TURN_RATE = 1.2;
export const GHOST_ARRIVAL = 20;

const STEP = 0.1;
const SPACING = 15;
const MAX_STEPS = 40_000;

/**
 * The path the autopilot will actually fly round a sortie: it points at the next waypoint, turns at
 * its limited yaw acceleration, drifts with the steady wind, and moves on to the next waypoint once
 * within the arrival radius. Gusts are left out. Returns points about SPACING metres apart.
 */
export const ghostPath = (
  waypoints: readonly Vec3[],
  terrain: Terrain,
  cfg: Pick<Config, 'windX' | 'windZ'>,
): readonly Vec3[] => {
  if (waypoints.length < 2) return waypoints;
  const targets = [...waypoints.slice(1), waypoints[0]];
  let [x, y, z] = waypoints[0];
  let heading = Math.atan2(targets[0][2] - z, targets[0][0] - x);
  let rate = 0;
  const out: Vec3[] = [[x, y, z]];
  let travelled = 0;
  let steps = 0;
  for (const [tx, , tz] of targets) {
    while (Math.hypot(tx - x, tz - z) >= GHOST_ARRIVAL && steps++ < MAX_STEPS) {
      const turn = turnSmoothly(
        heading,
        rate,
        Math.atan2(tz - z, tx - x),
        GHOST_TURN_RATE,
        STEP,
        YAW_ACCEL_PER_RATE,
      );
      heading = turn.heading;
      rate = turn.rate;
      x += (Math.cos(heading) * GHOST_AIR_SPEED + cfg.windX) * STEP;
      z += (Math.sin(heading) * GHOST_AIR_SPEED + cfg.windZ) * STEP;
      y = nextAltitude(terrain, y, x, z, heading, STEP);
      travelled +=
        Math.hypot(
          Math.cos(heading) * GHOST_AIR_SPEED + cfg.windX,
          Math.sin(heading) * GHOST_AIR_SPEED + cfg.windZ,
        ) * STEP;
      if (travelled >= SPACING) {
        out.push([x, y, z]);
        travelled = 0;
      }
    }
  }
  return out;
};
