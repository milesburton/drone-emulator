import { surfaceAt } from './crash';
import { ranges } from './rng';
import type { Terrain } from './terrain';
import type { Vec3 } from './types';

/** Other aircraft sharing the airspace: they fly fixed circuits and take no part in the mission. */
export type CraftKind = 'quad' | 'octo' | 'plane';

/** Mix of craft around the area; the index picks the kind. */
export const CRAFT_KINDS: readonly CraftKind[] = ['quad', 'octo', 'plane', 'quad', 'octo', 'plane'];
export const CRAFT_COUNT = CRAFT_KINDS.length;
/** Distance, metres, within which the mission drone counts as having hit another craft. */
export const COLLISION_RADIUS = 9;
const SALT = 0x3c6ef372;

interface Profile {
  readonly radius: readonly [number, number];
  readonly clearance: readonly [number, number];
  readonly speed: readonly [number, number];
}

const PROFILES: Readonly<Record<CraftKind, Profile>> = {
  quad: { radius: [70, 160], clearance: [30, 70], speed: [7, 13] },
  octo: { radius: [60, 130], clearance: [25, 60], speed: [5, 9] },
  plane: { radius: [220, 420], clearance: [60, 120], speed: [24, 34] },
};

export interface Craft {
  readonly kind: CraftKind;
  readonly pos: Vec3;
  /** Direction of travel in the (x, z) plane, radians. */
  readonly heading: number;
  /** Bank into the circuit, radians; right wing down positive. */
  readonly roll: number;
}

const lerp = ([a, b]: readonly [number, number], t: number): number => a + (b - a) * t;

/**
 * Where craft `i` is at `time`: a circle around a seeded centre, flown at a seeded height above the
 * land (or the water). Everything follows from the seed and the time, so there is no state to carry.
 */
export const craftAt = (seed: number, i: number, time: number, terrain: Terrain): Craft => {
  const kind = CRAFT_KINDS[i % CRAFT_KINDS.length];
  const p = PROFILES[kind];
  const [[cx, cz, r, clear, v, phase, dir]] = ranges((seed ^ SALT) + i * 7919, 7, 0, 1);
  const radius = lerp(p.radius, r);
  const speed = lerp(p.speed, v);
  const sign = dir < 0.5 ? -1 : 1;
  const angle = phase * Math.PI * 2 + (sign * speed * time) / radius;
  const centre = [(cx - 0.5) * terrain.extent * 1.2, (cz - 0.5) * terrain.extent * 1.2] as const;
  const x = centre[0] + Math.cos(angle) * radius;
  const z = centre[1] + Math.sin(angle) * radius;
  return {
    kind,
    pos: [x, surfaceAt(terrain, x, z) + lerp(p.clearance, clear), z],
    heading: angle + (sign * Math.PI) / 2,
    // Level flight round a circle banks by atan(v^2 / (g r)); multirotors stay nearly flat.
    roll: sign * Math.atan((speed * speed) / (9.81 * radius)) * (kind === 'plane' ? 1 : 0.4),
  };
};

/** Every craft's position at `time`. */
export const fleetAt = (seed: number, time: number, terrain: Terrain): readonly Craft[] =>
  Array.from({ length: CRAFT_COUNT }, (_, i) => craftAt(seed, i, time, terrain));

/** True when `pos` is within collision range of any craft. */
export const hitsCraft = (pos: Vec3, seed: number, time: number, terrain: Terrain): boolean =>
  fleetAt(seed, time, terrain).some(
    (c) => Math.hypot(c.pos[0] - pos[0], c.pos[1] - pos[1], c.pos[2] - pos[2]) < COLLISION_RADIUS,
  );
