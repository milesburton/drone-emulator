import { pressureOf, windBiasOf } from './ekf';
import { MAX_ATTEMPTS } from './mission';
import type { Snapshot } from './types';

const fixed = (v: number, digits = 1): string => v.toFixed(digits);

/** Pure text summary of a snapshot for the HUD. */
export const describe = (s: Snapshot): string => {
  const [x, y, z] = s.drone.pos;
  const [wx, wz] = windBiasOf(s.ekf);
  const error = Math.hypot(s.ekf.x[0] - x, s.ekf.x[1] - z);
  const m = s.mission;
  const retry = m.attempt > 0 ? ` (retry ${m.attempt + 1}/${MAX_ATTEMPTS})` : '';
  const why = m.lastFailure ? `, last: ${m.lastFailure}` : '';
  return [
    `t        ${fixed(s.time, 0)} s`,
    `phase    ${m.phase}${retry}`,
    `battery  ${fixed(m.battery * 100, 0)}%`,
    `trip     ${fixed(m.trip, 0)} m (total ${fixed(m.totalTrip, 0)} m)`,
    `flights  ${m.successes} ok, ${m.failures} failed${why}`,
    `waypoint ${s.drone.wp + 1}/${s.waypoints.length}`,
    `position ${fixed(x, 0)}, ${fixed(y, 0)}, ${fixed(z, 0)}`,
    `EKF err  ${fixed(error)} m`,
    `wind     true ${fixed(s.config.windX)}, ${fixed(s.config.windZ)}`,
    `         est  ${fixed(wx)}, ${fixed(wz)}`,
    `pressure ${fixed(pressureOf(s.ekf))} hPa`,
    `weather  ${s.weather.phase} (rain ${fixed(s.weather.rain * 100, 0)}%)`,
  ].join('\n');
};
