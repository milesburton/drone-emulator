import { trackFor } from './track';
import { gateAt } from './trackFlight';
import { pressureOf, windBiasOf } from './ekf';
import { MAX_ATTEMPTS } from './mission';
import { STATUS_STYLE, statusOf } from './status';
import type { Terrain } from './terrain';
import type { Snapshot } from './types';
import { gustAt } from './weather';

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const KNOTS_PER_MS = 1.943844;

const wrapDegrees = (deg: number): number => ((deg % 360) + 360) % 360;

/** Compass bearing of a ground-plane vector. North is -z (up the screen at the default view), east is +x. */
export const bearingOf = (dx: number, dz: number): number =>
  wrapDegrees((Math.atan2(dx, -dz) * 180) / Math.PI);

/** The eight-point compass name for a bearing. */
export const pointOf = (bearing: number): string =>
  POINTS[Math.round(wrapDegrees(bearing) / 45) % POINTS.length];

export interface Readouts {
  readonly wind: {
    /** Bearing the air is moving towards (the arrow), and the one it comes from (the name). */
    readonly toward: number;
    readonly from: number;
    readonly fromPoint: string;
    readonly speed: number;
    readonly knots: number;
    /** What the estimator thinks the wind is, as speed in m/s. */
    readonly estimated: number;
  };
  readonly heading: { readonly bearing: number; readonly point: string };
  readonly groundSpeed: number;
  readonly altitude: number;
  readonly battery: number;
  readonly status: { readonly label: string; readonly icon: string; readonly colour: string };
  readonly phase: string;
  readonly waypoint: string;
  readonly trip: string;
  readonly flights: string;
  readonly weather: string;
  readonly ekfError: number;
  readonly pressure: number;
}

/** Track progress: the gate being flown to, the lap, gates through and missed, and the best lap. */
export const trackLine = (s: Snapshot, terrain: Terrain): string => {
  const n = trackFor(terrain, s.config.seed).gates.length;
  const at = gateAt(s.drone.wp, n);
  const m = s.mission;
  const best = m.bestLap === null ? '' : ` · best ${m.bestLap.toFixed(1)} s`;
  return `${at === null ? 'pad' : `gate ${at.gate + 1}/${n}`} · ${m.laps} laps · ${m.passed} through, ${m.missed} missed${best}`;
};

/** Everything the instrument cluster shows, as plain numbers and strings. Altitude is above the ground. */
export const readouts = (s: Snapshot, terrain: Terrain, groundSpeed: number): Readouts => {
  const [x, y, z] = s.drone.pos;
  const gust = gustAt(s.time, s.weather.rain);
  const wx = s.config.windX + gust[0];
  const wz = s.config.windZ + gust[1];
  const toward = bearingOf(wx, wz);
  const speed = Math.hypot(wx, wz);
  const heading = bearingOf(Math.cos(s.drone.heading), Math.sin(s.drone.heading));
  const m = s.mission;
  const style = STATUS_STYLE[statusOf(s)];
  const retry = m.attempt > 0 ? ` (retry ${m.attempt + 1}/${MAX_ATTEMPTS})` : '';
  const why = m.lastFailure ? `, last: ${m.lastFailure}` : '';
  const [bx, bz] = windBiasOf(s.ekf);
  return {
    wind: {
      toward,
      from: wrapDegrees(toward + 180),
      fromPoint: pointOf(toward + 180),
      speed,
      knots: speed * KNOTS_PER_MS,
      estimated: Math.hypot(bx, bz),
    },
    heading: { bearing: heading, point: pointOf(heading) },
    groundSpeed,
    altitude: Math.max(y - terrain.heightAt(x, z), 0),
    battery: m.battery,
    status: {
      label: style.label,
      icon: style.icon,
      colour: `#${style.colour.toString(16).padStart(6, '0')}`,
    },
    phase: `${m.phase}${retry}`,
    waypoint:
      s.config.mode === 'track' ? trackLine(s, terrain) : `${s.drone.wp + 1}/${s.waypoints.length}`,
    trip: `${m.trip.toFixed(0)} m (total ${m.totalTrip.toFixed(0)} m)`,
    flights: `${m.successes} ok, ${m.failures} failed, ${m.crashed} crashed (${m.lost} after power loss)${why}${m.crashCause ? `, last crash: ${m.crashCause}` : ''}`,
    weather: `${s.weather.phase}, rain ${(s.weather.rain * 100).toFixed(0)}%`,
    ekfError: Math.hypot(s.ekf.x[0] - x, s.ekf.x[1] - z),
    pressure: pressureOf(s.ekf),
  };
};
