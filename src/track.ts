import { FOOTPRINT, groundBeneath, TURN_RADIUS } from './altitude';
import { ranges } from './rng';
import { distanceTo } from './routes';
import type { Terrain } from './terrain';
import type { Vec2, Vec3 } from './types';

/** Something to fly through. The opening is `width` wide, centred on `pos`, facing along `yaw`. */
export type GateKind = 'gate' | 'hoop' | 'arch' | 'dive';
/** Something to keep clear of. Seated on the ground and `height` tall. */
export type ObstacleKind = 'pylon' | 'pole' | 'flag' | 'tree';

export interface Gate {
  readonly kind: GateKind;
  /** Centre of the opening. */
  readonly pos: Vec3;
  /** Direction of travel through the gate, radians, atan2(dz, dx) like the drone's heading. */
  readonly yaw: number;
  readonly width: number;
}

export interface Obstacle {
  readonly kind: ObstacleKind;
  /** Base of the obstacle, on the ground. */
  readonly pos: Vec3;
  readonly radius: number;
  readonly height: number;
}

export interface Track {
  readonly centre: Vec3;
  /** Where the drone waits before the first gate, on the ground. */
  readonly start: Vec3;
  /** In flying order; the lap closes from the last back to the first. */
  readonly gates: readonly Gate[];
  readonly obstacles: readonly Obstacle[];
}

/** Gate openings leave about 8 m clear either side of the 14 m airframe. */
export const GATE_WIDTH: Readonly<Record<GateKind, number>> = {
  gate: 36,
  hoop: 34,
  arch: 36,
  dive: 36,
};
/** Height of the opening's centre above the ground, metres, by kind. */
export const GATE_HEIGHT: Readonly<Record<GateKind, readonly [number, number]>> = {
  gate: [8, 16],
  hoop: [6, 12],
  arch: [6, 10],
  dive: [20, 28],
};
const GATE_KINDS: readonly GateKind[] = ['gate', 'hoop', 'arch', 'dive'];
const OBSTACLE_SPECS: Readonly<
  Record<ObstacleKind, { readonly radius: number; readonly height: number }>
> = {
  pylon: { radius: 2.5, height: 40 },
  pole: { radius: 0.8, height: 30 },
  flag: { radius: 1.5, height: 28 },
  tree: { radius: 4, height: 32 },
};
const OBSTACLE_KINDS = Object.keys(OBSTACLE_SPECS) as readonly ObstacleKind[];

export const MIN_GATES = 8;
export const MAX_GATES = 12;
/** Nearest two gates may be: three turn radii, so the next gate is always reachable. */
export const MIN_SPACING = 3 * TURN_RADIUS;
/** Sharpest change of course allowed at a gate, radians. */
export const MAX_TURN = (100 * Math.PI) / 180;
/** Space kept between an obstacle's edge and the racing line, beyond the airframe's reach. */
export const OBSTACLE_MARGIN = 20;
/** Loop radius range, metres, and the arena it sits in. */
const LOOP_RADIUS: readonly [number, number] = [150, 230];
export const ARENA_RADIUS = 300;
/** Distance before the first gate that the drone starts from. */
const START_RUN = 70;
const OBSTACLES = 14;
const ATTEMPTS = 60;
const SALT = 0x1f83d9ab;

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = ([a, b]: readonly [number, number], t: number): number => a + (b - a) * t;
const seat = (terrain: Terrain, x: number, z: number, above = 0): Vec3 => [
  x,
  // A gate stands clear of the highest ground under the airframe's reach, and of the water.
  (above > 0
    ? Math.max(groundBeneath(terrain, x, z), terrain.waterLevel)
    : terrain.heightAt(x, z)) + above,
  z,
];

/** Distance from (px, pz) to the segment a..b. */
const toLeg = (a: Vec2, b: Vec2, px: number, pz: number): number => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t =
    len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
};

/** Positions of the loop corners, as (x, z): one per gate, spread round the centre with jittered radius. */
const loopPoints = (centre: Vec3, count: number, rolls: readonly number[]): readonly Vec2[] => {
  const phase = rolls[0] * Math.PI * 2;
  return Array.from({ length: count }, (_, i) => {
    const jitter = (rolls[1 + i] - 0.5) * 0.3;
    const angle = phase + ((i + jitter) / count) * Math.PI * 2;
    const radius = lerp(LOOP_RADIUS, rolls[1 + count + i]);
    return [centre[0] + Math.cos(angle) * radius, centre[2] + Math.sin(angle) * radius] as const;
  });
};

/** Course changes at each corner of a closed loop of points. */
const turnsOf = (points: readonly Vec2[]): readonly number[] =>
  points.map((p, i) => {
    const prev = points[(i + points.length - 1) % points.length];
    const next = points[(i + 1) % points.length];
    return Math.abs(
      wrap(Math.atan2(next[1] - p[1], next[0] - p[0]) - Math.atan2(p[1] - prev[1], p[0] - prev[0])),
    );
  });

const legalLoop = (points: readonly Vec2[]): boolean =>
  turnsOf(points).every((t) => t <= MAX_TURN) &&
  points.every((p, i) => {
    const q = points[(i + 1) % points.length];
    return Math.hypot(q[0] - p[0], q[1] - p[1]) >= MIN_SPACING;
  });

/** A regular polygon always satisfies the rules, so generation can never fail. */
const regularLoop = (centre: Vec3, count: number, phase: number): readonly Vec2[] =>
  Array.from({ length: count }, (_, i) => {
    const angle = phase + (i / count) * Math.PI * 2;
    return [centre[0] + Math.cos(angle) * 190, centre[2] + Math.sin(angle) * 190] as const;
  });

/**
 * A closed loop of gates round `centre`, with obstacles beside the line to be avoided. Pure in the
 * terrain, centre and seed. Every gate is at least `MIN_SPACING` from the next, no corner turns
 * more than `MAX_TURN`, and no obstacle comes within the airframe's reach (plus a margin) of a leg.
 */
export const generateTrack = (terrain: Terrain, centre: Vec3, seed: number): Track => {
  const [[countRoll, ...rest]] = ranges(seed ^ SALT, 1 + 2 * MAX_GATES + 1, 0, 1);
  const count = MIN_GATES + Math.floor(countRoll * (MAX_GATES - MIN_GATES + 1));
  const attempt = (n: number): readonly Vec2[] | null => {
    if (n >= ATTEMPTS) return null;
    const [[...rolls]] = ranges((seed ^ SALT) + n * 7919 + 1, 1 + 2 * count, 0, 1);
    const points = loopPoints(centre, count, rolls);
    return legalLoop(points) ? points : attempt(n + 1);
  };
  const points = attempt(0) ?? regularLoop(centre, count, rest[0] * Math.PI * 2);

  const [heights] = ranges((seed ^ SALT) + 31, count * 2, 0, 1);
  const gates = points.map((p, i): Gate => {
    const prev = points[(i + count - 1) % count];
    const next = points[(i + 1) % count];
    const kind = GATE_KINDS[Math.floor(heights[count + i] * GATE_KINDS.length)];
    // Face the bisector of the corner, so the opening is square to the line flown through it.
    const into = Math.atan2(p[1] - prev[1], p[0] - prev[0]);
    const out = Math.atan2(next[1] - p[1], next[0] - p[0]);
    return {
      kind,
      pos: seat(terrain, p[0], p[1], lerp(GATE_HEIGHT[kind], heights[i])),
      yaw: into + wrap(out - into) / 2,
      width: GATE_WIDTH[kind],
    };
  });

  const legs = points.map((p, i) => [p, points[(i + 1) % count]] as const);
  const gateClear = (x: number, z: number, radius: number): boolean =>
    gates.every((g) => Math.hypot(g.pos[0] - x, g.pos[2] - z) > g.width + radius + OBSTACLE_MARGIN);
  const clearOfLine = (x: number, z: number, radius: number): boolean =>
    legs.every(([a, b]) => toLeg(a, b, x, z) > radius + FOOTPRINT + OBSTACLE_MARGIN);
  const [rolls] = ranges((seed ^ SALT) + 97, OBSTACLES * 4 * 6, 0, 1);
  const obstacles = Array.from({ length: OBSTACLES * 6 }, (_, k): Obstacle | null => {
    const kind = OBSTACLE_KINDS[Math.floor(rolls[k * 4 + 2] * OBSTACLE_KINDS.length)];
    const spec = OBSTACLE_SPECS[kind];
    const angle = rolls[k * 4] * Math.PI * 2;
    const reach = Math.sqrt(rolls[k * 4 + 1]) * (ARENA_RADIUS - 20);
    const x = centre[0] + Math.cos(angle) * reach;
    const z = centre[2] + Math.sin(angle) * reach;
    // Close to the line is the point of an obstacle, so favour places within a long stone's throw of it.
    const near = legs.some(([a, b]) => toLeg(a, b, x, z) < 60);
    const wet = terrain.heightAt(x, z) <= terrain.waterLevel + 1;
    return clearOfLine(x, z, spec.radius) && gateClear(x, z, spec.radius) && near && !wet
      ? { kind, pos: seat(terrain, x, z), radius: spec.radius, height: spec.height }
      : null;
  })
    .filter((o): o is Obstacle => o !== null)
    .slice(0, OBSTACLES);

  const first = gates[0];
  const run: Vec2 = [Math.cos(first.yaw), Math.sin(first.yaw)];
  return {
    centre,
    start: seat(terrain, first.pos[0] - run[0] * START_RUN, first.pos[2] - run[1] * START_RUN),
    gates,
    obstacles,
  };
};

const tracks = new WeakMap<Terrain, Map<number, Track>>();

/** The track for this terrain and seed, built once and reused. */
export const trackFor = (terrain: Terrain, seed: number): Track => {
  const byTerrain = tracks.get(terrain) ?? new Map<number, Track>();
  tracks.set(terrain, byTerrain);
  const known = byTerrain.get(seed);
  if (known) return known;
  const built = generateTrack(terrain, findArena(terrain, seed), seed);
  byTerrain.set(seed, built);
  return built;
};

/** Ground the arena must be: this flat across its radius, in metres of relief, strictest first. */
const ARENA_RELIEF: readonly number[] = [15, 30, 60];
const ARENA_PROBES = 24;
const ARENA_STEP = 60;
const ARENA_RINGS = 12;
const ARENA_SALT = 0x5be0cd19;

const usableArena = (terrain: Terrain, x: number, z: number, relief: number): boolean => {
  const probes = Array.from({ length: ARENA_PROBES }, (_, k): Vec2 => {
    const ring = 1 + (k % 3);
    const angle = (k / ARENA_PROBES) * Math.PI * 2 * 3;
    return [x + Math.cos(angle) * ring * 100, z + Math.sin(angle) * ring * 100];
  });
  const heights = [[x, z] as Vec2, ...probes].map(([px, pz]) => terrain.heightAt(px, pz));
  const { river, roads } = terrain.routes;
  return (
    Math.min(...heights) > terrain.waterLevel + 3 &&
    Math.max(...heights) - Math.min(...heights) <= relief &&
    (!river || distanceTo(river, x, z) > ARENA_RADIUS * 0.4) &&
    roads.every((road) => distanceTo(road, x, z) > ARENA_RADIUS * 0.3)
  );
};

/**
 * Centre of a dry, flat-enough area for a track: the nearest to a seed-chosen spot that meets the
 * strictest standard any candidate meets; failing all, the flattest candidate.
 */
export const findArena = (terrain: Terrain, seed: number): Vec3 => {
  const half = terrain.cfg.worldSize / 2;
  const [[cx, cz]] = ranges(seed ^ ARENA_SALT, 2, -0.25 * half, 0.25 * half);
  const limit = 0.4 * terrain.cfg.worldSize - ARENA_RADIUS * 0.5;
  const candidates = Array.from({ length: ARENA_RINGS + 1 }, (_, ring) => {
    const count = Math.max(1, ring * 6);
    return Array.from({ length: count }, (_, k): Vec2 => {
      const angle = (2 * Math.PI * k) / count;
      return [cx + Math.cos(angle) * ring * ARENA_STEP, cz + Math.sin(angle) * ring * ARENA_STEP];
    });
  })
    .flat()
    .filter(([x, z]) => Math.abs(x) <= limit && Math.abs(z) <= limit);
  const relief = ([x, z]: Vec2): number => {
    const hs = [0, 1, 2, 3, 4, 5].map((k) =>
      terrain.heightAt(x + Math.cos(k * 1.047) * 200, z + Math.sin(k * 1.047) * 200),
    );
    return Math.max(...hs) - Math.min(...hs);
  };
  const dry = candidates.filter(([x, z]) => terrain.heightAt(x, z) > terrain.waterLevel + 3);
  const flattest = (dry.length > 0 ? dry : candidates).reduce((best, c) =>
    relief(c) < relief(best) ? c : best,
  );
  const [x, z] =
    ARENA_RELIEF.map((r) => candidates.find(([px, pz]) => usableArena(terrain, px, pz, r))).find(
      (c) => c !== undefined,
    ) ?? flattest;
  return seat(terrain, x, z);
};
