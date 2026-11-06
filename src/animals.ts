import { FOOTPRINT } from './altitude';
import { runFor } from './forestRun';
import { toRandomFn } from './rng';
import type { Terrain } from './terrain';
import type { Vec3 } from './types';

export type AnimalKind = 'deer' | 'bird';

/** An animal patrolling back and forth along a line across the forest, at a steady pace. */
export interface Animal {
  readonly kind: AnimalKind;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
  /** Metres per second along the path. */
  readonly speed: number;
  /** Where along the round trip (metres) it is at time zero. */
  readonly phase: number;
  /** Collision radius, metres. */
  readonly radius: number;
  /** Height of its centre above the ground, metres. */
  readonly height: number;
}

export interface AnimalState {
  readonly animal: Animal;
  readonly pos: Vec3;
  /** Direction of travel on the ground plane, radians. */
  readonly heading: number;
}

const SALT = 0x6a09e667;
const DEER = 10;
const BIRDS = 14;
/** Where along the line from pad to goal animals cross, as fractions of its length. */
const ALONG: readonly [number, number] = [0.14, 0.9];
const HALF_PATH: readonly [number, number] = [120, 210];
const lerp = ([a, b]: readonly [number, number], t: number): number => a + (b - a) * t;

/** The forest's animals for this terrain and seed: pure in both. */
const grow = (terrain: Terrain, seed: number): readonly Animal[] => {
  const { start, goal } = runFor(terrain, seed);
  const dx = goal[0] - start[0];
  const dz = goal[2] - start[2];
  const length = Math.hypot(dx, dz) || 1;
  const ux = dx / length;
  const uz = dz / length;
  const rand = toRandomFn(seed ^ SALT);
  return Array.from({ length: DEER + BIRDS }, (_, k): Animal => {
    const kind: AnimalKind = k < DEER ? 'deer' : 'bird';
    const along = lerp(ALONG, rand()) * length;
    const jitter = (rand() - 0.5) * 60;
    // Cross the line at a steep angle, so the animal moves through the corridor rather than along it.
    const angle = Math.atan2(uz, ux) + Math.PI / 2 + (rand() - 0.5) * 0.7;
    const half = lerp(HALF_PATH, rand());
    const cx = start[0] + ux * along - uz * jitter;
    const cz = start[2] + uz * along + ux * jitter;
    const to: readonly [number, number] = [
      cx + Math.cos(angle) * half,
      cz + Math.sin(angle) * half,
    ];
    const from: readonly [number, number] = [
      cx - Math.cos(angle) * half,
      cz - Math.sin(angle) * half,
    ];
    const speed = kind === 'deer' ? lerp([7, 12], rand()) : lerp([12, 20], rand());
    return {
      kind,
      from,
      to,
      speed,
      phase: rand() * 2 * half * 2,
      radius: kind === 'deer' ? 2.4 : 2.6,
      // A deer's back is just over a metre up; birds fly through the band the drone cruises in.
      height: kind === 'deer' ? 1.3 : lerp([5, 16], rand()),
    };
  });
};

const animals = new WeakMap<Terrain, Map<number, readonly Animal[]>>();

/** The animals for this terrain and seed, grown once. */
export const animalsFor = (terrain: Terrain, seed: number): readonly Animal[] => {
  const bySeed = animals.get(terrain) ?? new Map<number, readonly Animal[]>();
  animals.set(terrain, bySeed);
  const cached = bySeed.get(seed);
  if (cached) return cached;
  const built = grow(terrain, seed);
  bySeed.set(seed, built);
  return built;
};

/** Where an animal is at `time`, walking its path out and back. */
export const animalAt = (terrain: Terrain, a: Animal, time: number): AnimalState => {
  const length = Math.hypot(a.to[0] - a.from[0], a.to[1] - a.from[1]);
  const travelled = (a.phase + time * a.speed) % (2 * length);
  const outbound = travelled < length;
  const along = outbound ? travelled : 2 * length - travelled;
  const t = along / length;
  const x = a.from[0] + (a.to[0] - a.from[0]) * t;
  const z = a.from[1] + (a.to[1] - a.from[1]) * t;
  const heading = Math.atan2(a.to[1] - a.from[1], a.to[0] - a.from[0]) + (outbound ? 0 : Math.PI);
  const ground = Math.max(terrain.heightAt(x, z), terrain.waterLevel);
  return { animal: a, pos: [x, ground + a.height, z], heading };
};

/** True when the airframe touches an animal at `time`. */
export const hitsAnimal = (state: AnimalState, pos: Vec3): boolean =>
  Math.hypot(pos[0] - state.pos[0], pos[1] - state.pos[1], pos[2] - state.pos[2]) <
  state.animal.radius + FOOTPRINT;
