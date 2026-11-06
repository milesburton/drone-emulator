import { AIRFRAME_RADIUS as FOOTPRINT } from './airframe';
import { groundBeneath } from './altitude';
import { FRAME } from './gates';
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

/** Something hanging in the air to fly past, over or under: a round balloon, or a blimp whose hull is flown round as a sphere. */
export type SkyKind = 'balloon' | 'blimp';

export interface SkyObstacle {
  readonly kind: SkyKind;
  /** Centre of the object, in the air. */
  readonly pos: Vec3;
  /** Collision radius, metres. */
  readonly radius: number;
}

export interface Track {
  readonly centre: Vec3;
  /** Where the drone waits before the first gate, on the ground. */
  readonly start: Vec3;
  /** Where the drone turns for the pad after the last lap, clear of the other gates. */
  readonly exit: Vec3;
  /** In flying order; the lap closes from the last back to the first. */
  readonly gates: readonly Gate[];
  readonly obstacles: readonly Obstacle[];
  /** Balloons and blimps floating near the line, each clear of every leg flown in all three dimensions. */
  readonly sky: readonly SkyObstacle[];
}

/** Gate openings leave about 3 m clear either side of the 3 m airframe. */
export const GATE_WIDTH: Readonly<Record<GateKind, number>> = {
  gate: 10,
  hoop: 9.5,
  arch: 10,
  dive: 10,
};
/** Height of the opening's centre above the ground, metres, by kind. */
export const GATE_HEIGHT: Readonly<Record<GateKind, readonly [number, number]>> = {
  gate: [2.5, 5.5],
  hoop: [2.2, 4.5],
  arch: [2, 3.5],
  dive: [6.5, 9],
};
const GATE_KINDS: readonly GateKind[] = ['gate', 'hoop', 'arch', 'dive'];
const OBSTACLE_SPECS: Readonly<
  Record<ObstacleKind, { readonly radius: number; readonly height: number }>
> = {
  pylon: { radius: 0.8, height: 14 },
  pole: { radius: 0.3, height: 10 },
  flag: { radius: 0.5, height: 9 },
  tree: { radius: 1.4, height: 11 },
};
const OBSTACLE_KINDS = Object.keys(OBSTACLE_SPECS) as readonly ObstacleKind[];

export const MIN_GATES = 8;
export const MAX_GATES = 12;
/** Tightest turn the micro drone makes at track speed, metres (speed over turn rate; see trackFlight.ts). */
export const TRACK_TURN_RADIUS = 9;
/** Nearest two gates may be: three turn radii, so the next gate is always reachable. */
export const MIN_SPACING = 3 * TRACK_TURN_RADIUS;
/** Sharpest change of course allowed at a gate, radians. */
export const MAX_TURN = (100 * Math.PI) / 180;
/** Space kept between an obstacle's edge and the racing line, beyond the airframe's reach. */
export const OBSTACLE_MARGIN = 7;
/** The autopilot lines up this far before a gate, on its axis, so the legs it flies include that point. */
export const APPROACH = 30;
/** Loop radius range, metres, and the arena it sits in. */
const LOOP_RADIUS: readonly [number, number] = [60, 100];
export const ARENA_RADIUS = 140;
/** The pad is this far before the first gate and this far to one side, so the drone never has to fly back through the gate to land. */
const START_RUN = 25;
const START_SIDE = 28;
/** Pad positions to try, as [back from gate 0, to the side], nearest and left first. */
/** Directions to try for the exit leg, as turns from gate 0's axis, straight on first. */
const EXIT_TURNS: readonly number[] = [0, 0.7, -0.7, 1.4, -1.4];
const PAD_CHOICES: readonly (readonly [number, number])[] = [
  [START_RUN, START_SIDE],
  [START_RUN, -START_SIDE],
  [START_RUN * 1.6, START_SIDE],
  [START_RUN * 1.6, -START_SIDE],
];
/** How far past the start/finish gate the drone flies before turning for the pad. */
export const EXIT_RUN = 32;
const OBSTACLES = 14;
const SKY_OBJECTS = 9;
const SKY_SPECS: Readonly<Record<SkyKind, { readonly radius: readonly [number, number] }>> = {
  balloon: { radius: [1.6, 2.6] },
  blimp: { radius: [3.2, 4.2] },
};
const SKY_KINDS = Object.keys(SKY_SPECS) as readonly SkyKind[];
/** Height of a sky object's centre above the ground, metres. */
const SKY_HEIGHT: readonly [number, number] = [7, 16];
/** Room kept between a sky object and any flown leg, beyond the airframe, to allow for the autopilot's height error. */
const SKY_MARGIN = 7;
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

/** Distance from a point to the segment a..b in three dimensions. */
const toLeg3 = (a: Vec3, b: Vec3, p: Vec3): number => {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t =
    len2 < 1e-9
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / len2),
        );
  return Math.hypot(p[0] - (a[0] + d[0] * t), p[1] - (a[1] + d[1] * t), p[2] - (a[2] + d[2] * t));
};

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
  // The legs flown outside the loop: pad to gate 0, gate 0 to the exit point, and back to the pad.
  const first = gates[0];
  const run: Vec2 = [Math.cos(first.yaw), Math.sin(first.yaw)];
  const gate0: Vec2 = [first.pos[0], first.pos[2]];
  // The pad sits beside the start run and the exit point ahead of gate 0; try a few of each and
  // take the first pairing whose legs (pad to gate 0, gate 0 to exit, exit to pad) clear every other gate.
  const padAt = ([back, side]: readonly [number, number]): Vec2 => [
    gate0[0] - run[0] * back - run[1] * side,
    gate0[1] - run[1] * back + run[0] * side,
  ];
  const exitAt = (turn: number): Vec2 => [
    gate0[0] + Math.cos(first.yaw + turn) * EXIT_RUN,
    gate0[1] + Math.sin(first.yaw + turn) * EXIT_RUN,
  ];
  const legClear = (a: Vec2, b: Vec2): boolean =>
    gates
      .slice(1)
      .every(
        (g) =>
          toLeg(a, b, g.pos[0], g.pos[2]) > g.width / 2 + FRAME + FOOTPRINT + OBSTACLE_MARGIN / 2,
      );
  const pairs = EXIT_TURNS.flatMap((turn) =>
    PAD_CHOICES.map((choice) => [padAt(choice), exitAt(turn)] as const),
  );
  const [pad, exit] =
    pairs.find(([p, e]) => legClear(p, gate0) && legClear(gate0, e) && legClear(e, p)) ?? pairs[0];
  const startAt = seat(terrain, pad[0], pad[1]);
  const exitPoint: Vec3 = [exit[0], first.pos[1], exit[1]];
  // Each gate is reached from a line-up point on its axis, so that is part of the line flown too.
  const lineUps = gates.map((g): Vec2 => [
    g.pos[0] - Math.cos(g.yaw) * APPROACH,
    g.pos[2] - Math.sin(g.yaw) * APPROACH,
  ]);
  const flown: readonly (readonly [Vec2, Vec2])[] = [
    ...legs,
    ...gates.flatMap((g, i): readonly (readonly [Vec2, Vec2])[] => [
      [points[(i + count - 1) % count], lineUps[i]],
      [lineUps[i], [g.pos[0], g.pos[2]]],
    ]),
    [pad, gate0],
    [gate0, exit],
    [exit, pad],
  ];
  const gateClear = (x: number, z: number, radius: number): boolean =>
    gates.every((g) => Math.hypot(g.pos[0] - x, g.pos[2] - z) > g.width + radius + OBSTACLE_MARGIN);
  const clearOfLine = (x: number, z: number, radius: number): boolean =>
    flown.every(([a, b]) => toLeg(a, b, x, z) > radius + FOOTPRINT + OBSTACLE_MARGIN);
  const [rolls] = ranges((seed ^ SALT) + 97, OBSTACLES * 4 * 6, 0, 1);
  const obstacles = Array.from({ length: OBSTACLES * 6 }, (_, k): Obstacle | null => {
    const kind = OBSTACLE_KINDS[Math.floor(rolls[k * 4 + 2] * OBSTACLE_KINDS.length)];
    const spec = OBSTACLE_SPECS[kind];
    const angle = rolls[k * 4] * Math.PI * 2;
    const reach = Math.sqrt(rolls[k * 4 + 1]) * (ARENA_RADIUS - 8);
    const x = centre[0] + Math.cos(angle) * reach;
    const z = centre[2] + Math.sin(angle) * reach;
    // Close to the line is the point of an obstacle, so favour places within a long stone's throw of it.
    const near = legs.some(([a, b]) => toLeg(a, b, x, z) < 20);
    const wet = terrain.heightAt(x, z) <= terrain.waterLevel + 1;
    return clearOfLine(x, z, spec.radius) && gateClear(x, z, spec.radius) && near && !wet
      ? { kind, pos: seat(terrain, x, z), radius: spec.radius, height: spec.height }
      : null;
  })
    .filter((o): o is Obstacle => o !== null)
    .slice(0, OBSTACLES);

  // Sky objects: near the line, but clear of every flown leg (the loop, takeoff, exit and return) in 3D.
  const legs3: readonly (readonly [Vec3, Vec3])[] = [
    ...gates.map((g, i) => [g.pos, gates[(i + 1) % gates.length].pos] as const),
    ...gates.flatMap((g, i): readonly (readonly [Vec3, Vec3])[] => {
      const lineUp: Vec3 = [
        g.pos[0] - Math.cos(g.yaw) * APPROACH,
        g.pos[1],
        g.pos[2] - Math.sin(g.yaw) * APPROACH,
      ];
      return [
        [gates[(i + gates.length - 1) % gates.length].pos, lineUp],
        [lineUp, g.pos],
      ];
    }),
    [startAt, first.pos],
    [first.pos, exitPoint],
    [exitPoint, startAt],
  ];
  const [skyRolls] = ranges((seed ^ SALT) + 211, SKY_OBJECTS * 6 * 5, 0, 1);
  const sky = Array.from({ length: SKY_OBJECTS * 6 }, (_, k): SkyObstacle | null => {
    const r = skyRolls.slice(k * 5, k * 5 + 5);
    const kind = SKY_KINDS[Math.floor(r[2] * SKY_KINDS.length)];
    const [lo, hi] = SKY_SPECS[kind].radius;
    const radius = lerp([lo, hi], r[3]);
    const reach = Math.sqrt(r[1]) * (ARENA_RADIUS - 14);
    const x = centre[0] + Math.cos(r[0] * Math.PI * 2) * reach;
    const z = centre[2] + Math.sin(r[0] * Math.PI * 2) * reach;
    const y = Math.max(terrain.heightAt(x, z), terrain.waterLevel) + lerp(SKY_HEIGHT, r[4]);
    const pos: Vec3 = [x, y, z];
    const near = legs.some(([a, b]) => toLeg(a, b, x, z) < 24);
    const clear = legs3.every(([a, b]) => toLeg3(a, b, pos) > radius + FOOTPRINT + SKY_MARGIN);
    const gatesClear = gates.every(
      (g) => Math.hypot(g.pos[0] - x, g.pos[1] - y, g.pos[2] - z) > g.width + radius + SKY_MARGIN,
    );
    return near && clear && gatesClear ? { kind, pos, radius } : null;
  })
    .filter((o): o is SkyObstacle => o !== null)
    .slice(0, SKY_OBJECTS);

  return {
    centre,
    start: startAt,
    exit: exitPoint,
    gates,
    obstacles,
    sky,
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
  if (terrain.arena) return terrain.arena.centre;
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
