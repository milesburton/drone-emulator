import { createNoise2D } from 'simplex-noise';
import { characterFor, profileOf } from './biome';
import { toRandomFn } from './rng';
import { searchPad } from './pad';
import { findArena } from './track';
import { createRoutes, distanceTo, pointAt, tangentAt, type Route, type Routes } from './routes';
import type { Config, Vec3 } from './types';

export interface Terrain {
  readonly heightAt: (x: number, z: number) => number;
  readonly waterLevel: number;
  readonly cfg: Config;
  readonly routes: Routes;
  /** Launch pad the ground was levelled for; null only for hand-built terrains and in track mode. */
  readonly pad: Vec3 | null;
  /** Track mode: the flat, fenced ground the track is laid out on; null in sortie mode. */
  readonly arena: Arena | null;
  /** Height of the road surface at `s` along `road`: smooth, and clear of the ground beneath it. */
  readonly deckAt: (road: Route, s: number) => number;
  /** Half-size of the rendered land; far larger than the playable world so it reaches the fog. */
  readonly extent: number;
}

/** Flat ground for the FPV track: level to `ARENA_FLAT`, easing back to the natural land by `ARENA_FLAT + ARENA_BLEND`. */
export interface Arena {
  /** Centre of the arena, at the level of its floor. */
  readonly centre: Vec3;
  /** Radius of the fence, metres. */
  readonly radius: number;
}

/** The fence stands this far from the arena's centre, and is this tall. */
export const FENCE_RADIUS = 390;
export const FENCE_HEIGHT = 60;
const ARENA_FLAT = 430;
const ARENA_BLEND = 140;
/** The floor is at least this far above the water. */
const ARENA_ABOVE_WATER = 4;

export type Rgb = readonly [number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (edge0: number, edge1: number, v: number): number => {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Terrain-affecting config fields; if this key is unchanged the terrain can be reused. */
export const terrainKey = (cfg: Config): string =>
  [
    cfg.seed,
    cfg.biome,
    cfg.terrainScale,
    cfg.worldSize,
    cfg.resolution,
    cfg.lakes,
    cfg.river,
    cfg.roads,
    cfg.mode,
  ].join(':');

const HILL_FREQUENCY = 1 / 380;
const BANK_RATIO = 3.3;
const FLOODPLAIN_NEAR = 30;
const FLOODPLAIN_FAR = 130;
export const ROAD_HALF_WIDTH = 4;
export const ROAD_LIFT = 0.8;
const ROAD_VERGE_NEAR = ROAD_HALF_WIDTH + 6;
const ROAD_VERGE_FAR = ROAD_HALF_WIDTH + 45;
const ROAD_BED_ABOVE_WATER = 3;
/** Roads are graded from the hills along their line: smoothed, then no steeper than this. */
const GRADE_STEP = 6;
const GRADE_SMOOTHING = 10;
const GRADE_MAX_SLOPE = 0.08;
/** Ground within PAD_LEVEL of the pad is flat; it eases back to the natural land by PAD_BLEND. */
export const PAD_LEVEL = 14;
const PAD_BLEND = 45;
/** Roads within JUNCTION_NEAR of an earlier road share its level, easing off by JUNCTION_FAR. */
const JUNCTION_NEAR = 20;
const JUNCTION_FAR = 260;
/** A road crossing an earlier one climbs to BRIDGE_CLEARANCE above it, from BRIDGE_FAR out to BRIDGE_NEAR. */
const BRIDGE_CLEARANCE = 5;
const BRIDGE_NEAR = ROAD_HALF_WIDTH + 8;
const BRIDGE_FAR = 140;
/** Approaches to a bridge climb no faster than this, so stacked bridges stay drivable. */
const BRIDGE_MAX_SLOPE = 0.035;

/** How much further than the playable world the land extends, and how many coarse rings it uses. */
export const FAR_FACTOR = 4.5;
const FAR_CELLS = 40;
const FAR_GROWTH = 3;

/** `heights` is the ground level the road is cut to; `lift` raises the deck above it on a bridge. */
type Grade = {
  readonly origin: number;
  readonly heights: readonly number[];
  readonly lift: readonly number[];
};

const blur = (values: readonly number[], radius: number): readonly number[] => {
  const prefix = values.reduce<number[]>((acc, v) => [...acc, acc[acc.length - 1] + v], [0]);
  return values.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    return (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  });
};

/** Clamps each step to `maxStep`, forwards then backwards, so no slope is steeper than allowed. */
const limitSlope = (values: readonly number[], maxStep: number): readonly number[] => {
  const pass = (list: readonly number[]): number[] =>
    list.reduce<number[]>(
      (acc, v) =>
        acc.length === 0
          ? [v]
          : [
              ...acc,
              Math.min(acc[acc.length - 1] + maxStep, Math.max(acc[acc.length - 1] - maxStep, v)),
            ],
      [],
    );
  return pass(pass(values).reverse()).reverse();
};

/** Widens every peak's flanks so no slope is steeper than `maxStep` per sample; peaks keep their height. */
const rampUp = (values: readonly number[], maxStep: number): readonly number[] => {
  const pass = (list: readonly number[]): number[] =>
    list.reduce<number[]>(
      (acc, v) => [...acc, acc.length === 0 ? v : Math.max(v, acc[acc.length - 1] - maxStep)],
      [],
    );
  return pass(pass(values).reverse()).reverse();
};

const buildGrade = (
  road: Route,
  baseAt: (x: number, z: number) => number,
  roadBed: number,
  extent: number,
  earlier: readonly (readonly [Route, Grade])[],
): Grade => {
  const count = Math.ceil((2 * extent) / GRADE_STEP) + 1;
  const origin = -extent;
  const points = Array.from({ length: count }, (_, i) => pointAt(road, origin + i * GRADE_STEP));
  const smooth = blur(
    blur(
      points.map(([x, z]) => baseAt(x, z)),
      GRADE_SMOOTHING,
    ),
    GRADE_SMOOTHING,
  ).map((h) => Math.max(h, roadBed));
  const limited = limitSlope(smooth, GRADE_MAX_SLOPE * GRADE_STEP);
  // Near an earlier road, whether crossing or running alongside, take on its level.
  const levelled = earlier.reduce(
    (heights, [other, grade]) =>
      heights.map((h, k) => {
        const [x, z] = points[k];
        const nearness = 1 - smoothstep(JUNCTION_NEAR, JUNCTION_FAR, distanceTo(other, x, z));
        return lerp(h, gradeAt(grade, alongOf(other, x, z)), nearness);
      }),
    limited,
  );
  // Where it crosses an earlier road at a real angle, this road goes over it on a bridge.
  const wanted = points.map(([x, z], k) =>
    earlier.reduce((best, [other, grade]) => {
      const [tx, tz] = tangentAt(road, origin + k * GRADE_STEP);
      const [ux, uz] = tangentAt(other, alongOf(other, x, z));
      const crossing = smoothstep(0.25, 0.55, Math.abs(tx * uz - tz * ux));
      const over = 1 - smoothstep(BRIDGE_NEAR, BRIDGE_FAR, distanceTo(other, x, z));
      const clear = BRIDGE_CLEARANCE + liftAt(grade, alongOf(other, x, z));
      return Math.max(best, crossing * over * clear);
    }, 0),
  );
  return {
    origin,
    heights: blur(levelled, GRADE_SMOOTHING / 2),
    lift: rampUp(wanted, BRIDGE_MAX_SLOPE * GRADE_STEP),
  };
};

const sampleGrade = (origin: number, values: readonly number[], s: number): number => {
  const f = Math.min(values.length - 1, Math.max(0, (s - origin) / GRADE_STEP));
  const i = Math.min(values.length - 2, Math.floor(f));
  return lerp(values[i], values[i + 1], f - i);
};

const gradeAt = ({ origin, heights }: Grade, s: number): number => sampleGrade(origin, heights, s);

const liftAt = ({ origin, lift }: Grade, s: number): number => sampleGrade(origin, lift, s);

const alongOf = (road: Route, x: number, z: number): number => (road.along === 'x' ? x : z);

export const createTerrain = (cfg: Config): Terrain => {
  const hills = createNoise2D(toRandomFn(cfg.seed));
  const lakeNoise = createNoise2D(toRandomFn(cfg.seed ^ 0x9e3779b9));
  // An arena has no room for roads or a river, so a track map is built without them.
  const routes = createRoutes(cfg.mode === 'track' ? { ...cfg, roads: false, river: false } : cfg);
  const character = characterFor(cfg);
  const relief = cfg.terrainScale * character.relief;
  const channelHalfWidth = character.riverHalfWidth;
  const bankWidth = channelHalfWidth * BANK_RATIO;
  const frequency = HILL_FREQUENCY * character.hillFrequency;
  const waterLevel = -character.waterFraction * cfg.terrainScale;
  const lakeBed = waterLevel - 0.1 * cfg.terrainScale;
  const riverBed = waterLevel - 0.08 * cfg.terrainScale;
  const floodplain = waterLevel + 0.06 * cfg.terrainScale;
  const roadBed = waterLevel + ROAD_BED_ABOVE_WATER;

  const baseAt = (x: number, z: number): number => {
    const fx = x * frequency;
    const fz = z * frequency;
    return (
      (0.62 * hills(fx, fz) + 0.28 * hills(fx * 3.1, fz * 3.1) + 0.1 * hills(fx * 9, fz * 9)) *
      relief
    );
  };

  const extent = cfg.worldSize * FAR_FACTOR;
  const grades = new Map(
    routes.roads.reduce<readonly (readonly [Route, Grade])[]>(
      (built, road) => [...built, [road, buildGrade(road, baseAt, roadBed, extent, built)]],
      [],
    ),
  );
  const deckAt = (road: Route, s: number): number => {
    const grade = grades.get(road);
    return (grade ? gradeAt(grade, s) + liftAt(grade, s) : roadBed) + ROAD_LIFT;
  };

  /** Land, roads and river, with the ground levelled under `pad` when there is one. */
  const heightFor =
    (pad: Vec3 | null, arena: Arena | null) =>
    (x: number, z: number): number => {
      const base = baseAt(x, z);
      const nearest = routes.roads.reduce<{ road: Route | null; distance: number }>(
        (best, road) => {
          const distance = distanceTo(road, x, z);
          return distance < best.distance ? { road, distance } : best;
        },
        { road: null, distance: Infinity },
      );
      const roadBlend = 1 - smoothstep(ROAD_VERGE_NEAR, ROAD_VERGE_FAR, nearest.distance);
      const lakeShore = cfg.lakes
        ? lerp(
            lakeBed,
            base,
            smoothstep(0, character.lakeWidth, Math.abs(lakeNoise(x * 0.0028, z * 0.0028))),
          )
        : base;
      // Dry ground beside a road is cut or filled to the road's grade, so the road never meets a
      // slope edge-on. Water is left alone: the road crosses it on a bridge.
      const graded = nearest.road
        ? lerp(
            lakeShore,
            gradeAt(grades.get(nearest.road) as Grade, alongOf(nearest.road, x, z)),
            roadBlend * smoothstep(waterLevel, waterLevel + ROAD_BED_ABOVE_WATER, lakeShore),
          )
        : lakeShore;
      const natural = routes.river
        ? ((distance) =>
            lerp(
              riverBed,
              lerp(
                Math.max(graded, floodplain),
                graded,
                smoothstep(FLOODPLAIN_NEAR, FLOODPLAIN_FAR, distance),
              ),
              smoothstep(channelHalfWidth, bankWidth, distance),
            ))(distanceTo(routes.river, x, z))
        : graded;
      const levelled = pad
        ? lerp(
            natural,
            pad[1],
            (1 - smoothstep(PAD_LEVEL, PAD_BLEND, Math.hypot(x - pad[0], z - pad[2]))) *
              (1 - roadBlend),
          )
        : natural;
      return arena
        ? lerp(
            levelled,
            arena.centre[1],
            1 -
              smoothstep(
                ARENA_FLAT,
                ARENA_FLAT + ARENA_BLEND,
                Math.hypot(x - arena.centre[0], z - arena.centre[2]),
              ),
          )
        : levelled;
    };

  const draft: Terrain = {
    heightAt: heightFor(null, null),
    waterLevel,
    cfg,
    routes,
    extent,
    pad: null,
    arena: null,
    deckAt,
  };
  if (cfg.mode === 'track') {
    const [x, y, z] = findArena(draft, cfg.seed);
    const arena: Arena = {
      centre: [x, Math.max(y, waterLevel + ARENA_ABOVE_WATER), z],
      radius: FENCE_RADIUS,
    };
    return { ...draft, heightAt: heightFor(null, arena), arena };
  }
  const pad = searchPad(draft, cfg.seed);
  return { ...draft, heightAt: heightFor(pad, null), pad };
};

/**
 * Ascending grid coordinates along one axis: uniform across the playable world, then
 * spacing that grows towards `outer`. One mesh with graded spacing has no seams.
 */
export const gridCoords = (
  inner: number,
  outer: number,
  innerCells: number,
  outerCells: number,
): readonly number[] => {
  const far = Array.from(
    { length: outerCells },
    (_, k) =>
      inner +
      ((outer - inner) * (Math.exp((FAR_GROWTH * (k + 1)) / outerCells) - 1)) /
        (Math.exp(FAR_GROWTH) - 1),
  );
  const centre = Array.from(
    { length: innerCells + 1 },
    (_, i) => -inner + (2 * inner * i) / innerCells,
  );
  return [...far.map((v) => -v).reverse(), ...centre, ...far];
};

export const terrainCoords = (terrain: Terrain): readonly number[] =>
  gridCoords(terrain.cfg.worldSize / 2, terrain.extent, terrain.cfg.resolution - 1, FAR_CELLS);

/** Pairs of left/right edge vertices laying a road along its smooth grade. */
export const roadRibbon = (road: Route, terrain: Terrain): readonly Vec3[] =>
  terrainCoords(terrain).flatMap((s) => {
    const [x, z] = pointAt(road, s);
    const [tx, tz] = tangentAt(road, s);
    const y = terrain.deckAt(road, s);
    return [
      [x - tz * ROAD_HALF_WIDTH, y, z + tx * ROAD_HALF_WIDTH],
      [x + tz * ROAD_HALF_WIDTH, y, z - tx * ROAD_HALF_WIDTH],
    ] as const;
  });

/** Colours a point by height relative to the water level and the terrain scale, in the biome's palette. */
export const colourAt = (height: number, terrain: Terrain): Rgb => {
  const { waterLevel, cfg } = terrain;
  const { shore, low, high, rock, peak, bands } = profileOf(cfg.biome).palette;
  const [b0, b1, b2, b3] = bands;
  const range = Math.max(cfg.terrainScale * 1.3, 1);
  const t = (height - waterLevel) / range;
  if (t < b0) return shore;
  if (t < b1) return mix(shore, low, smoothstep(b0, b1, t));
  if (t < b2) return mix(low, high, smoothstep(b1, b2, t));
  if (t < b3) return mix(high, rock, smoothstep(b2, b3, t));
  return mix(rock, peak, smoothstep(b3, b3 + 0.15, t));
};
