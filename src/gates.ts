import { FOOTPRINT } from './altitude';
import type { Gate, Obstacle } from './track';
import type { Vec3 } from './types';

/** Thickness of a gate's frame members, metres; matches the model. */
export const FRAME = 1.8;
/** Vertical reach of the airframe about its centre: skids below, rotors above. */
const REACH_V = 3;
/** The opening of a `dive` gate reaches this much higher than the others. */
const DIVE_TOP = 1.6;
/** A crossing this far off centre (in gate widths) still counts as a miss; further out is not near the gate. */
const MISS_BAND = 2;

export type GateResult = 'pass' | 'miss';

interface Local {
  /** Distance past the gate plane, along the way through it. */
  readonly along: number;
  /** Sideways from the centre of the opening. */
  readonly lat: number;
  /** Above the centre of the opening. */
  readonly dy: number;
}

const toLocal = (gate: Gate, [x, y, z]: Vec3): Local => {
  const dx = x - gate.pos[0];
  const dz = z - gate.pos[2];
  return {
    along: dx * Math.cos(gate.yaw) + dz * Math.sin(gate.yaw),
    lat: -dx * Math.sin(gate.yaw) + dz * Math.cos(gate.yaw),
    dy: y - gate.pos[1],
  };
};

const opening = (gate: Gate, { lat, dy }: Local): boolean => {
  const half = gate.width / 2;
  switch (gate.kind) {
    case 'gate':
      return Math.abs(lat) <= half && dy <= half;
    case 'dive':
      return Math.abs(lat) <= half && dy <= half * DIVE_TOP && dy >= -half;
    case 'hoop':
      return Math.hypot(lat, dy) <= half;
    case 'arch':
      return Math.abs(lat) <= half && (dy <= 0 || Math.hypot(lat, dy) <= half);
  }
};

/**
 * Whether the move from `a` to `b` crosses the gate's plane the right way round, and if so whether
 * it went through the opening. Null when it did not cross, or crossed nowhere near.
 */
export const crossing = (gate: Gate, a: Vec3, b: Vec3): GateResult | null => {
  const from = toLocal(gate, a);
  const to = toLocal(gate, b);
  if (!(from.along < 0 && to.along >= 0)) return null;
  const t = -from.along / (to.along - from.along);
  const at: Local = {
    along: 0,
    lat: from.lat + (to.lat - from.lat) * t,
    dy: from.dy + (to.dy - from.dy) * t,
  };
  if (opening(gate, at)) return 'pass';
  return Math.abs(at.lat) <= gate.width * MISS_BAND ? 'miss' : null;
};

/** The airframe's cross-section (14 m wide, 6 m deep) overlaps a ring of tube radius 0.7 about the centre. */
const ring = (half: number, side: number, up: number): boolean =>
  Math.hypot(side + FOOTPRINT, up + REACH_V) > half - 0.7 &&
  Math.hypot(Math.max(side - FOOTPRINT, 0), Math.max(up - REACH_V, 0)) < half + 0.7;

/**
 * True when the airframe, a 14 m disc about 6 m deep, touches the gate's frame at `pos`. The
 * posts and top bar are boxes; hoops and arches are rings tested at the corner of the airframe that reaches furthest.
 */
export const hitsGate = (gate: Gate, pos: Vec3): boolean => {
  const { along, lat, dy } = toLocal(gate, pos);
  if (Math.abs(along) > FRAME / 2 + FOOTPRINT) return false;
  const half = gate.width / 2;
  const side = Math.abs(lat);
  const bar = (top: number): boolean =>
    side <= half + FRAME + FOOTPRINT && Math.abs(dy - top) < FRAME / 2 + REACH_V;
  const posts = (top: number): boolean =>
    side > half - FOOTPRINT && side < half + FRAME + FOOTPRINT && dy < top + REACH_V;
  switch (gate.kind) {
    case 'gate':
      return posts(half) || bar(half);
    case 'dive':
      return (
        posts(half * DIVE_TOP) ||
        bar(half * DIVE_TOP) ||
        (side <= half && Math.abs(dy + half) < FRAME / 2 + REACH_V)
      );
    case 'hoop':
      return (
        ring(half, side, Math.abs(dy)) || (side < FRAME / 2 + FOOTPRINT && dy < -half + REACH_V)
      );
    case 'arch':
      return (
        (side > half - FOOTPRINT && side < half + FOOTPRINT && dy < REACH_V) ||
        (dy > -REACH_V && ring(half, side, Math.max(dy, 0)))
      );
  }
};

/** True when the airframe's footprint overlaps the obstacle's column at `pos`. */
export const hitsObstacle = (o: Obstacle, [x, y, z]: Vec3): boolean =>
  Math.hypot(x - o.pos[0], z - o.pos[2]) < o.radius + FOOTPRINT &&
  y - REACH_V < o.pos[1] + o.height;
