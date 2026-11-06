import { FOOTPRINT, groundBeneath } from './altitude';
import { animalAt, type Animal } from './animals';
import { toSegment3 } from './gates';
import { toRandomFn } from './rng';
import type { Terrain } from './terrain';
import type { Vec3 } from './types';

/** Speed through the air on a forest run, m/s (about 215 km/h); a racer at full tilt. */
export const RUN_SPEED = 60;
/** Fastest turn on a run, radians per second: about a 20 m radius at speed. */
export const RUN_TURN_RATE = 3;
/** Height above the ground the drone cruises at, and the band it may dodge within, metres. */
export const RUN_ALT = 9;
export const RUN_FLOOR = 4.5;
export const RUN_CEILING = 15;

/** A tree in the run's forest, scaled to the 14 m airframe; its trunk is what the drone must dodge. */
export interface RunTree {
  readonly kind: 'tree';
  readonly species: 'conifer' | 'broadleaf';
  /** Base of the trunk, on the ground. */
  readonly pos: Vec3;
  /** Trunk radius, metres. Named so a `RunTree` can be steered round like any other column. */
  readonly radius: number;
  readonly height: number;
}

/** A limb sticking out of a trunk: a straight cylinder, `radius` thick. */
export interface Branch {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly radius: number;
}

export interface Run {
  /** The pad the run starts from. */
  readonly start: Vec3;
  /** The goal: a clearing at the far end of the forest. */
  readonly goal: Vec3;
  readonly trees: readonly RunTree[];
  readonly branches: readonly Branch[];
}

const SALT = 0x2545f491;
/** Straight-line distance from the pad to the goal, metres. */
export const GOAL_DISTANCE = 760;
/** How much of the world the goal may sit in, as a fraction of its size on each side of the centre. */
const GOAL_LIMIT = 0.45;
const GOAL_ATTEMPTS = 48;
/** Jittered grid: one trunk per cell, somewhere in a central window, so no two are closer than CELL - WINDOW. */
const CELL = 38;
const WINDOW = 14;
/** Forest half-width either side of the line, and the clearings kept round the pad and the goal. */
const CORRIDOR = 230;
export const PAD_CLEARING = 60;
export const GOAL_CLEARING = 75;
const MAX_SLOPE = 0.7;
const SLOPE_STEP = 4;
const TRUNK: readonly [number, number] = [1.4, 2.8];
const TREE_HEIGHT: readonly [number, number] = [30, 48];
const LIMB_HEIGHT: readonly [number, number] = [4.5, 13];
const LIMB_LENGTH: readonly [number, number] = [5, 10];
const LIMB_RADIUS = 1.1;

const lerp = ([a, b]: readonly [number, number], t: number): number => a + (b - a) * t;

const slopeAt = (terrain: Terrain, x: number, z: number): number =>
  Math.hypot(
    terrain.heightAt(x + SLOPE_STEP, z) - terrain.heightAt(x - SLOPE_STEP, z),
    terrain.heightAt(x, z + SLOPE_STEP) - terrain.heightAt(x, z - SLOPE_STEP),
  ) /
  (2 * SLOPE_STEP);

const dryAt = (terrain: Terrain, x: number, z: number): boolean =>
  terrain.heightAt(x, z) > terrain.waterLevel + 3;

/** Distance from (px, pz) to the segment a..b on the ground plane. */
const toLine = (a: Vec3, b: Vec3, px: number, pz: number): number => {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len2 = dx * dx + dz * dz;
  const t =
    len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / len2));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[2] + dz * t));
};

/** The share of points along start..goal that are dry, steep-free ground. */
const passable = (terrain: Terrain, a: Vec3, b: Vec3): number => {
  const n = 24;
  const ok = Array.from({ length: n + 1 }, (_, i) => {
    const x = a[0] + ((b[0] - a[0]) * i) / n;
    const z = a[2] + ((b[2] - a[2]) * i) / n;
    return dryAt(terrain, x, z) && slopeAt(terrain, x, z) < MAX_SLOPE ? 1 : 0;
  });
  return ok.reduce<number>((sum, v) => sum + v, 0) / (n + 1);
};

const startOf = (terrain: Terrain): Vec3 => {
  const pad = terrain.pad;
  return pad ?? [0, terrain.heightAt(0, 0), 0];
};

/** Where the goal is: the first direction, from a seeded one round the compass, with a mostly dry and gentle line to it. */
const goalFor = (terrain: Terrain, start: Vec3, seed: number): Vec3 => {
  const limit = terrain.cfg.worldSize * GOAL_LIMIT;
  const rand = toRandomFn(seed ^ SALT);
  const base = rand() * Math.PI * 2;
  const candidates = Array.from({ length: GOAL_ATTEMPTS }, (_, k): Vec3 => {
    const angle = base + ((k * 2.399963) % (Math.PI * 2));
    const distance = GOAL_DISTANCE * (1 - 0.35 * (k / GOAL_ATTEMPTS));
    const x = start[0] + Math.cos(angle) * distance;
    const z = start[2] + Math.sin(angle) * distance;
    return [x, terrain.heightAt(x, z), z];
  }).filter(([x, , z]) => Math.abs(x) <= limit && Math.abs(z) <= limit);
  const scored = candidates.map((c) => ({
    c,
    score: dryAt(terrain, c[0], c[2]) ? passable(terrain, start, c) : -1,
  }));
  const good = scored.find((s) => s.score >= 0.95);
  const best = scored.reduce((b, s) => (s.score > b.score ? s : b), { c: start, score: -2 });
  return (good ?? best).c;
};

const growTrees = (terrain: Terrain, start: Vec3, goal: Vec3, seed: number): readonly RunTree[] => {
  const minX = Math.min(start[0], goal[0]) - CORRIDOR;
  const maxX = Math.max(start[0], goal[0]) + CORRIDOR;
  const minZ = Math.min(start[2], goal[2]) - CORRIDOR;
  const maxZ = Math.max(start[2], goal[2]) + CORRIDOR;
  const i0 = Math.floor(minX / CELL);
  const i1 = Math.ceil(maxX / CELL);
  const j0 = Math.floor(minZ / CELL);
  const j1 = Math.ceil(maxZ / CELL);
  return Array.from({ length: i1 - i0 + 1 }, (_, a) => i0 + a).flatMap((i) =>
    Array.from({ length: j1 - j0 + 1 }, (_, b) => j0 + b).flatMap((j): readonly RunTree[] => {
      const rand = toRandomFn(
        (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ seed ^ SALT) >>> 0,
      );
      const x = (i + 0.5) * CELL + (rand() - 0.5) * WINDOW;
      const z = (j + 0.5) * CELL + (rand() - 0.5) * WINDOW;
      const species: RunTree['species'] = rand() < 0.55 ? 'conifer' : 'broadleaf';
      const radius = lerp(TRUNK, rand());
      const height = lerp(TREE_HEIGHT, rand());
      const keep = rand() < 0.92;
      const y = terrain.heightAt(x, z);
      return keep &&
        toLine(start, goal, x, z) < CORRIDOR &&
        Math.hypot(x - start[0], z - start[2]) > PAD_CLEARING &&
        Math.hypot(x - goal[0], z - goal[2]) > GOAL_CLEARING &&
        dryAt(terrain, x, z) &&
        slopeAt(terrain, x, z) < MAX_SLOPE
        ? [{ kind: 'tree', species, pos: [x, y, z], radius, height }]
        : [];
    }),
  );
};

const growLimbs = (trees: readonly RunTree[], seed: number): readonly Branch[] =>
  trees.flatMap((tree, k): readonly Branch[] => {
    const rand = toRandomFn((k * 2654435761) ^ seed ^ SALT);
    const count = rand() < 0.35 ? 0 : rand() < 0.5 ? 1 : 2;
    return Array.from({ length: count }, (): Branch => {
      const angle = rand() * Math.PI * 2;
      const length = lerp(LIMB_LENGTH, rand()) + tree.radius;
      const y = tree.pos[1] + lerp(LIMB_HEIGHT, rand());
      return {
        from: [tree.pos[0], y, tree.pos[2]],
        to: [
          tree.pos[0] + Math.cos(angle) * length,
          y + (rand() - 0.5) * 3,
          tree.pos[2] + Math.sin(angle) * length,
        ],
        radius: LIMB_RADIUS,
      };
    });
  });

interface Indexed extends Run {
  /** Trees and limbs by grid cell, for the collision and steering queries. */
  readonly cells: ReadonlyMap<
    string,
    { readonly trees: readonly RunTree[]; readonly branches: readonly Branch[] }
  >;
}

const key = (i: number, j: number): string => `${i},${j}`;

const index = (run: Run): Indexed => {
  const cells = new Map<string, { trees: RunTree[]; branches: Branch[] }>();
  const at = (x: number, z: number) => {
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    const found = cells.get(k) ?? { trees: [], branches: [] };
    cells.set(k, found);
    return found;
  };
  run.trees.forEach((t) => at(t.pos[0], t.pos[2]).trees.push(t));
  run.branches.forEach((b) => at(b.from[0], b.from[2]).branches.push(b));
  return { ...run, cells };
};

const runs = new WeakMap<Terrain, Map<number, Indexed>>();

/** The run for this terrain and seed, grown once and reused. */
export const runFor = (terrain: Terrain, seed: number): Run & Indexed => {
  const byTerrain = runs.get(terrain) ?? new Map<number, Indexed>();
  runs.set(terrain, byTerrain);
  const cached = byTerrain.get(seed);
  if (cached) return cached;
  const start = startOf(terrain);
  const goal = goalFor(terrain, start, seed);
  const trees = growTrees(terrain, start, goal, seed);
  const built = index({ start, goal, trees, branches: growLimbs(trees, seed) });
  byTerrain.set(seed, built);
  return built;
};

/** Trees and limbs in the grid cells within `range` metres of (x, z). */
export const near = (
  run: Run & Indexed,
  x: number,
  z: number,
  range: number,
): { readonly trees: readonly RunTree[]; readonly branches: readonly Branch[] } => {
  const reach = Math.ceil(range / CELL);
  const ci = Math.floor(x / CELL);
  const cj = Math.floor(z / CELL);
  const found = Array.from({ length: 2 * reach + 1 }, (_, a) => ci - reach + a).flatMap((i) =>
    Array.from({ length: 2 * reach + 1 }, (_, b) => run.cells.get(key(i, cj - reach + b))).flatMap(
      (c) => (c ? [c] : []),
    ),
  );
  return { trees: found.flatMap((c) => c.trees), branches: found.flatMap((c) => c.branches) };
};

/** True when the airframe's footprint touches a trunk. The flight band stays below the crowns. */
export const hitsTrunk = (tree: RunTree, [x, , z]: Vec3): boolean =>
  Math.hypot(x - tree.pos[0], z - tree.pos[2]) < tree.radius + FOOTPRINT;

/** True when the airframe touches a limb. */
export const hitsLimb = (b: Branch, pos: Vec3): boolean =>
  toSegment3(b.from, b.to, pos) < b.radius + FOOTPRINT;

/** Whether the drone at `pos` has struck anything in the forest: a trunk or a limb. */
export const strikes = (run: Run & Indexed, pos: Vec3): boolean => {
  const around = near(run, pos[0], pos[2], CELL);
  return (
    around.trees.some((t) => hitsTrunk(t, pos)) || around.branches.some((b) => hitsLimb(b, pos))
  );
};

/** Ground height the run's altitude control follows: the highest ground under the airframe, ahead and here. */
export const groundAhead = (
  terrain: Terrain,
  x: number,
  z: number,
  heading: number,
  ahead: number,
): number =>
  Math.max(
    groundBeneath(terrain, x, z),
    groundBeneath(terrain, x + Math.cos(heading) * ahead, z + Math.sin(heading) * ahead),
  );

/** Climb and descent limits on a run, metres per second: the ground rises fast at this speed. */
const RUN_CLIMB = 30;
const RUN_DESCENT = 24;
const RUN_RESPONSE = 3;
/** How far ahead the run looks for rising ground, metres. */
const GROUND_LOOK = 50;

/**
 * Eases altitude towards `RUN_ALT` above the highest ground under and ahead of the airframe,
 * keeping to the band between the floor and the ceiling above the ground here.
 */
export const nextRunAltitude = (
  terrain: Terrain,
  y: number,
  x: number,
  z: number,
  heading: number,
  dt: number,
): number => {
  const here = Math.max(groundBeneath(terrain, x, z), terrain.waterLevel);
  const ahead = Math.max(here, groundAhead(terrain, x, z, heading, GROUND_LOOK));
  const wanted = Math.min(ahead + RUN_ALT, here + RUN_CEILING);
  const step = (wanted - y) * Math.min(1, dt * RUN_RESPONSE);
  const eased = y + Math.max(-RUN_DESCENT * dt, Math.min(RUN_CLIMB * dt, step));
  return Math.max(eased, here + RUN_FLOOR);
};

/** How far ahead, in seconds of flight, the planner looks along each candidate heading. */
const PLAN_LOOK = 2;
const PLAN_STEP = 4;
/** Seconds the autopilot takes to close most of a height gap, for predicting its height along a path. */
const HEIGHT_LAG = 0.4;
/** Candidate headings: this many either side of the goal bearing, this far apart (radians). */
const PLAN_FAN = 24;
const PLAN_SPACING = 0.085;
/** Clear metres past the airframe's reach that a path must keep, and the clearance beyond which more is no better. */
const PLAN_SAFE = 5;
const PLAN_CAP = 16;
/** Cost of each radian of turning away from the current heading, against each radian away from the goal bearing. */
const PLAN_TURN_COST = 0.45;

/**
 * Metres of clearance the path along `theta` keeps from trunks and limbs, beyond the airframe's
 * reach (negative means the path hits one). Limbs are tested at the drone's own height.
 */
const clearanceAlong = (
  terrain: Terrain,
  pos: Vec3,
  heading: number,
  theta: number,
  speed: number,
  wind: readonly [number, number],
  length: number,
  trees: readonly RunTree[],
  limbs: readonly Branch[],
  critters: readonly (readonly Vec3[])[],
  radii: readonly number[],
): number => {
  const steps = Math.ceil(length / PLAN_STEP);
  const stepTurn = (RUN_TURN_RATE * PLAN_STEP) / speed;
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
  // Roll the drone forward, turning towards `theta` as fast as it can, and keep the worst clearance.
  return Array.from({ length: steps }).reduce<{ x: number; z: number; h: number; worst: number }>(
    (st, _, i) => {
      const gap = wrap(theta - st.h);
      const h = st.h + Math.max(-stepTurn, Math.min(stepTurn, gap));
      // The wind carries the drone as well as its own motion through the air.
      const x = st.x + Math.cos(h) * PLAN_STEP + (wind[0] * PLAN_STEP) / speed;
      const z = st.z + Math.sin(h) * PLAN_STEP + (wind[1] * PLAN_STEP) / speed;
      const d = (i + 1) * PLAN_STEP;
      // The autopilot follows the ground, so the drone's height there is where its easing takes it.
      const cruise = Math.max(terrain.heightAt(x, z), terrain.waterLevel) + RUN_ALT;
      const p: Vec3 = [
        x,
        pos[1] + (cruise - pos[1]) * (1 - Math.exp(-d / (speed * HEIGHT_LAG))),
        z,
      ];
      const trunk = trees.reduce(
        (m, t) => Math.min(m, Math.hypot(p[0] - t.pos[0], p[2] - t.pos[2]) - t.radius - FOOTPRINT),
        PLAN_CAP,
      );
      const limb = limbs.reduce(
        (m, b) => Math.min(m, toSegment3(b.from, b.to, p) - b.radius - FOOTPRINT),
        PLAN_CAP,
      );
      // An animal is where its path puts it by the time the drone gets there.
      const animal = (critters[i] ?? []).reduce(
        (m, at, k) =>
          Math.min(m, Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) - radii[k] - FOOTPRINT),
        PLAN_CAP,
      );
      return { x, z, h, worst: Math.min(st.worst, trunk, limb, animal) };
    },
    { x: pos[0], z: pos[2], h: heading, worst: PLAN_CAP },
  ).worst;
};

/**
 * The heading to fly: the one nearest the goal bearing (and the current heading) whose path stays
 * clear of every trunk and limb; if none does, the one with the most room.
 */
export const planCourse = (
  terrain: Terrain,
  pos: Vec3,
  heading: number,
  goalBearing: number,
  speed: number,
  wind: readonly [number, number],
  critters: readonly Animal[],
  time: number,
  around: { readonly trees: readonly RunTree[]; readonly branches: readonly Branch[] },
): number => {
  const length = speed * PLAN_LOOK;
  const trees = around.trees.filter(
    (t) =>
      Math.hypot(t.pos[0] - pos[0], t.pos[2] - pos[2]) < length + t.radius + FOOTPRINT + PLAN_CAP,
  );
  const limbs = around.branches.filter(
    (b) => Math.hypot(b.from[0] - pos[0], b.from[2] - pos[2]) < length + 30,
  );
  // Only animals that could be within reach of the drone's paths in the next couple of seconds matter.
  const nearby = critters.filter((a) => {
    const now = animalAt(terrain, a, time).pos;
    return Math.hypot(now[0] - pos[0], now[2] - pos[2]) < length + a.speed * PLAN_LOOK + 20;
  });
  // Where each of those animals will be at each step of the look-ahead; the same for every candidate path.
  const steps = Math.ceil(length / PLAN_STEP);
  const ahead = Array.from({ length: steps }, (_, i) =>
    nearby.map((a) => animalAt(terrain, a, time + ((i + 1) * PLAN_STEP) / speed).pos),
  );
  const radii = nearby.map((a) => a.radius);
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
  const candidates = Array.from({ length: 2 * PLAN_FAN + 1 }, (_, k) => {
    const theta = goalBearing + (k - PLAN_FAN) * PLAN_SPACING;
    return {
      theta,
      clearance: clearanceAlong(
        terrain,
        pos,
        heading,
        theta,
        speed,
        wind,
        length,
        trees,
        limbs,
        ahead,
        radii,
      ),
      cost: Math.abs(wrap(theta - goalBearing)) + PLAN_TURN_COST * Math.abs(wrap(theta - heading)),
    };
  });
  const safe = candidates.filter((c) => c.clearance >= PLAN_SAFE);
  const pick =
    safe.length > 0
      ? safe.reduce((best, c) => (c.cost < best.cost ? c : best))
      : candidates.reduce((best, c) => (c.clearance > best.clearance ? c : best));
  return pick.theta;
};
