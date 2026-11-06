import { groundBeneath, MAX_CLIMB, MAX_DESCENT, CLIMB_RESPONSE } from './altitude';
import { routeEnergy } from './mission';
import type { Terrain } from './terrain';
import { trackFor, type Gate, type Track } from './track';
import type { Config, Vec3 } from './types';

/** Speed through the air on the track, m/s; slower than a sortie so a 24 m gate and tight corners are flyable. */
export const TRACK_SPEED = 20;
/** Closest the airframe's footprint may come to the ground on the track, metres. */
export const TRACK_FLOOR = 5;
/** Height above the pad that a track takeoff climbs to before heading for the first gate. */
export const TRACK_TAKEOFF = 10;
/** Most laps one sortie plans, however little a lap costs. */
export const MAX_LAPS = 10;
/** Charge a track sortie may plan to use, as for sorties. */
const TRACK_BUDGET = 0.7;

/** Speed through the air for this mode. */
export const speedFor = (cfg: Config): number => (cfg.mode === 'track' ? TRACK_SPEED : 36);

/** The pad on a track: the start spot ahead of the first gate. */
export const trackPad = (terrain: Terrain, seed: number): Vec3 => trackFor(terrain, seed).start;

const loop = (track: Track): readonly Vec3[] => track.gates.map((g) => g.pos);

/** How many laps fit the planned battery budget, at least one. */
export const lapsFor = (track: Track, terrain: Terrain): number => {
  const cost = routeEnergy(loop(track), terrain, TRACK_SPEED);
  return Math.max(1, Math.min(MAX_LAPS, Math.floor(TRACK_BUDGET / cost)));
};

/**
 * The route for a track sortie: the pad, then every gate in order for as many laps as the battery
 * allows. Heights are the gates' own, not terrain-following.
 */
export const trackRoute = (terrain: Terrain, seed: number): readonly Vec3[] => {
  const track = trackFor(terrain, seed);
  const gates = loop(track);
  const laps = Array.from({ length: lapsFor(track, terrain) }, () => gates).flat();
  // The first gate again at the end, so the last lap is timed like the others.
  return [track.start, ...laps, gates[0]];
};

/** Which gate and lap a route waypoint (index into `trackRoute`) is; null for the pad. Gate 0 is the start/finish. */
export const gateAt = (wp: number, gates: number): { gate: number; lap: number } | null =>
  wp <= 0 ? null : { gate: (wp - 1) % gates, lap: Math.floor((wp - 1) / gates) };

/** Eases altitude towards the gate's own height, never closer to the ground than the track floor. */
export const nextTrackAltitude = (
  terrain: Terrain,
  y: number,
  x: number,
  z: number,
  targetY: number,
  dt: number,
): number => {
  const wanted = (targetY - y) * Math.min(1, dt * CLIMB_RESPONSE);
  const eased = y + Math.max(-MAX_DESCENT * dt, Math.min(MAX_CLIMB * dt, wanted));
  return Math.max(eased, Math.max(groundBeneath(terrain, x, z), terrain.waterLevel) + TRACK_FLOOR);
};

/** How far ahead along a gate's axis the autopilot aims, metres: longer lines up sooner but cuts across further. */
export const LEAD = 40;

/**
 * Where to steer for `gate` from `from`: a point on the gate's axis `LEAD` metres ahead of the
 * drone's own position along it, so the drone eases onto the axis and crosses square to the
 * opening. Past the gate's plane (a miss) it aims back before the gate to come round again.
 */
export const aimAt = (gate: Gate, from: Vec3): Vec3 => {
  const fx = Math.cos(gate.yaw);
  const fz = Math.sin(gate.yaw);
  const along = (from[0] - gate.pos[0]) * fx + (from[2] - gate.pos[2]) * fz;
  const k = along > 0 ? -LEAD : along + LEAD;
  return [gate.pos[0] + fx * k, gate.pos[1], gate.pos[2] + fz * k];
};
