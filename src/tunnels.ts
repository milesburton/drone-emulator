import { AIRFRAME_RADIUS as FOOTPRINT } from './airframe';
import type { Terrain } from './terrain';
import type { Vec3 } from './types';

/**
 * A straight tube across the line to the goal, which the pilot has to fly through: a hollow
 * trunk-and-timber pipe lying level, its axis `height` above the highest ground under it.
 * Walls are `outer - inner` thick; the airframe is 14 m across, so the bore is wide.
 */
export interface Tunnel {
  /** Centre of the mouth the drone enters by, and of the far mouth. */
  readonly entrance: Vec3;
  readonly exit: Vec3;
  /** Direction of travel through it, radians, atan2(dz, dx). */
  readonly yaw: number;
  readonly length: number;
  readonly inner: number;
  readonly outer: number;
}

export const TUNNEL_LENGTH = 26;
export const TUNNEL_INNER = 5.4;
export const TUNNEL_OUTER = 6.1;
/** Where along the line from pad to goal the tunnels sit, as fractions of its length. */
const FRACTIONS: readonly number[] = [0.36, 0.68];
/** The route lines up this far before a mouth, and carries on this far past the far one. */
export const LINE_UP = 30;
export const RUN_ON = 22;
/** The autopilot holds the tunnel's height from this far before the mouth. */
const HOLD_FROM = 48;
/** How far ahead on the axis the drone aims while lining up and passing through. */
const CARROT = 16;
/** Trees stay this far from the walls. */
export const TUNNEL_TREE_CLEAR = 12;
const ABOVE_WATER = 3;
const SAMPLES = 16;

/** Where a point is relative to a tunnel: along its axis, to the side, above the axis, and out from the axis. */
export const localTo = (t: Tunnel, [x, y, z]: Vec3) => {
  const dx = x - t.entrance[0];
  const dz = z - t.entrance[2];
  const along = dx * Math.cos(t.yaw) + dz * Math.sin(t.yaw);
  const lat = -dx * Math.sin(t.yaw) + dz * Math.cos(t.yaw);
  const dy = y - t.entrance[1];
  return { along, lat, dy, radial: Math.hypot(lat, dy) };
};

/** Tunnels across the line from `start` to `goal`, on dry ground, at the given cruising height above it. */
export const growTunnels = (
  terrain: Terrain,
  start: Vec3,
  goal: Vec3,
  cruise: number,
): readonly Tunnel[] => {
  const dx = goal[0] - start[0];
  const dz = goal[2] - start[2];
  const length = Math.hypot(dx, dz) || 1;
  const yaw = Math.atan2(dz, dx);
  const ux = dx / length;
  const uz = dz / length;
  return FRACTIONS.flatMap((f): readonly Tunnel[] => {
    const cx = start[0] + dx * f;
    const cz = start[2] + dz * f;
    const samples = Array.from({ length: SAMPLES + 1 }, (_, i) => {
      const along = (i / SAMPLES - 0.5) * TUNNEL_LENGTH;
      return [cx + ux * along, cz + uz * along] as const;
    });
    // The ground under the whole tube, side to side as well as end to end.
    const ground = samples.flatMap(([x, z]) =>
      [-1, 0, 1].map((k) => terrain.heightAt(x - uz * k * TUNNEL_INNER, z + ux * k * TUNNEL_INNER)),
    );
    if (ground.some((h) => h <= terrain.waterLevel + ABOVE_WATER)) return [];
    const y = Math.max(...ground) + cruise;
    const half = TUNNEL_LENGTH / 2;
    return [
      {
        entrance: [cx - ux * half, y, cz - uz * half],
        exit: [cx + ux * half, y, cz + uz * half],
        yaw,
        length: TUNNEL_LENGTH,
        inner: TUNNEL_INNER,
        outer: TUNNEL_OUTER,
      },
    ];
  });
};

/**
 * Distance on the ground plane from (x, z) to the tunnel's axis segment, optionally extended
 * `before` the mouth and `after` the far one.
 */
export const groundDistance = (t: Tunnel, x: number, z: number, before = 0, after = 0): number => {
  const { along, lat } = localTo(t, [x, t.entrance[1], z]);
  const clamped = Math.max(-before, Math.min(t.length + after, along));
  return Math.hypot(along - clamped, lat);
};

/** Distance to the lane the route follows through a tunnel, from its line-up point to its run-out point. */
export const laneDistance = (t: Tunnel, x: number, z: number): number =>
  groundDistance(t, x, z, LINE_UP + 10, RUN_ON + 10);

/** True when the airframe touches a wall or a mouth ring: anywhere in the wall band along the tube. */
export const hitsTunnel = (t: Tunnel, pos: Vec3): boolean => {
  const { along, radial } = localTo(t, pos);
  return (
    along > -FOOTPRINT / 2 &&
    along < t.length + FOOTPRINT / 2 &&
    radial > t.inner - FOOTPRINT &&
    radial < t.outer + FOOTPRINT
  );
};

/** Clear metres to the walls beyond the airframe's reach: inside the bore, or outside the tube. Beyond its ends, no limit (cap). */
export const tunnelClearance = (t: Tunnel, pos: Vec3, cap: number): number => {
  const { along, radial } = localTo(t, pos);
  if (along <= -FOOTPRINT / 2 || along >= t.length + FOOTPRINT / 2) return cap;
  return radial <= t.inner ? t.inner - FOOTPRINT - radial : radial - t.outer - FOOTPRINT;
};

/** The same tunnel flown the other way, for the trip home. */
export const reversed = (t: Tunnel): Tunnel => ({
  ...t,
  entrance: t.exit,
  exit: t.entrance,
  yaw: t.yaw + Math.PI,
});

const flights = new WeakMap<readonly Tunnel[], readonly Tunnel[]>();

/** Every tunnel in both directions, so the approach and the hold work out and back. */
const bothWays = (tunnels: readonly Tunnel[]): readonly Tunnel[] => {
  const cached = flights.get(tunnels);
  if (cached) return cached;
  const built = tunnels.flatMap((t) => [t, reversed(t)]);
  flights.set(tunnels, built);
  return built;
};

/** True when the drone is heading broadly the way the tunnel runs. */
const facing = (t: Tunnel, heading: number): boolean => Math.cos(heading - t.yaw) > 0.3;

/** The route's waypoints for a tunnel: a line-up point before the mouth, and a point beyond the far one. */
export const tunnelWaypoints = (t: Tunnel): readonly Vec3[] => [
  [
    t.entrance[0] - Math.cos(t.yaw) * LINE_UP,
    t.entrance[1],
    t.entrance[2] - Math.sin(t.yaw) * LINE_UP,
  ],
  [t.exit[0] + Math.cos(t.yaw) * RUN_ON, t.exit[1], t.exit[2] + Math.sin(t.yaw) * RUN_ON],
];

const approaching = (t: Tunnel, pos: Vec3): boolean => {
  const { along, lat } = localTo(t, pos);
  return along > -(LINE_UP + 10) && along < t.length + 2 && Math.abs(lat) < LINE_UP;
};

/**
 * While lining up for a tunnel or passing through it: the point on its axis a little ahead, so the
 * drone is drawn onto the axis rather than just towards the far waypoint. Null elsewhere.
 */
export const tunnelCarrot = (
  tunnels: readonly Tunnel[],
  pos: Vec3,
  heading: number,
): Vec3 | null => {
  const t = bothWays(tunnels).find((u) => facing(u, heading) && approaching(u, pos));
  if (!t) return null;
  const { along } = localTo(t, pos);
  const ahead = Math.min(t.length + RUN_ON, Math.max(along, -LINE_UP) + CARROT);
  return [
    t.entrance[0] + Math.cos(t.yaw) * ahead,
    t.entrance[1],
    t.entrance[2] + Math.sin(t.yaw) * ahead,
  ];
};

/** The height to hold while approaching or inside a tunnel; null when not near one. */
export const tunnelHold = (
  tunnels: readonly Tunnel[],
  pos: Vec3,
  heading: number,
): number | null => {
  const t = bothWays(tunnels).find((u) => {
    const { along, lat } = localTo(u, pos);
    return (
      facing(u, heading) && along > -HOLD_FROM && along < u.length + 15 && Math.abs(lat) < u.inner
    );
  });
  return t ? t.entrance[1] : null;
};
