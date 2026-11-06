import type { Terrain } from './terrain';
import type { Vec3 } from './types';

/** Wind speed in metres per second. */
export const windSpeed = (windX: number, windZ: number): number => Math.hypot(windX, windZ);

/** One line of flow: smooth points through the map, each with how fast the air moves there relative to the open wind. */
export interface Streamline {
  readonly points: readonly Vec3[];
  /** Local speed over the open-air speed: below 1 where the terrain blocks the wind, above 1 where it squeezes over a crest. */
  readonly speeds: readonly number[];
}

/** Lines stop this far (as a fraction of the world size) either side of the centre. */
const EXTENT = 0.6;
/** Gap between neighbouring lines where they start, metres. */
const SPACING = 36;
/** Distance between points along a line, metres. */
export const STREAM_STEP = 8;
const MAX_POINTS = 420;
/** Height of the lines above the ground, metres. */
const ABOVE_GROUND = 7;
/** Distance over which the terrain's slope and crest height are measured; large, so the flow is smooth. */
const SCALE = 28;
/** How strongly a slope turns the wind aside, and how much a crest speeds it up. */
const BLOCKING = 2.2;
const SPEED_UP = 0.55;
/** Smoothing passes over a finished line, so it flows like a wave rather than following every bump. */
const SMOOTHING = 16;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The wind at (x, z) once the terrain has acted on it: wind blowing into a slope is turned aside
 * along the contours (more the steeper the slope), and air over a crest, higher than the land
 * round about, runs faster. Returns the wind vector; its length over the open speed is the
 * local speed ratio.
 */
export const flowAt = (
  terrain: Terrain,
  windX: number,
  windZ: number,
  x: number,
  z: number,
): readonly [number, number] => {
  const h = terrain.heightAt;
  const gx = (h(x + SCALE, z) - h(x - SCALE, z)) / (2 * SCALE);
  const gz = (h(x, z + SCALE) - h(x, z - SCALE)) / (2 * SCALE);
  const steep = Math.hypot(gx, gz);
  const into = windX * gx + windZ * gz;
  // The part of the wind that runs into the hill is mostly turned aside; none is lost going downhill.
  const blocked = steep > 1e-6 && into > 0;
  const turned = blocked ? (BLOCKING * steep) / (1 + BLOCKING * steep) : 0;
  const bx = blocked ? windX - (turned * into * gx) / (steep * steep) : windX;
  const bz = blocked ? windZ - (turned * into * gz) / (steep * steep) : windZ;
  // Crest height against the land a little way round, as a share of the relief.
  const around =
    (h(x + 2 * SCALE, z) + h(x - 2 * SCALE, z) + h(x, z + 2 * SCALE) + h(x, z - 2 * SCALE)) / 4;
  const crest = clamp((h(x, z) - around) / (terrain.cfg.terrainScale * 0.6), -0.5, 1);
  const factor = 1 + SPEED_UP * Math.max(crest, 0) + 0.25 * Math.min(crest, 0);
  return [bx * factor, bz * factor];
};

/** Moves each interior point to the average of itself and its neighbours; the ends stay put. */
const relax = (points: readonly Vec3[]): readonly Vec3[] =>
  points.map((p, i) =>
    i === 0 || i === points.length - 1
      ? p
      : ([
          (points[i - 1][0] + 2 * p[0] + points[i + 1][0]) / 4,
          (points[i - 1][1] + 2 * p[1] + points[i + 1][1]) / 4,
          (points[i - 1][2] + 2 * p[2] + points[i + 1][2]) / 4,
        ] as const),
  );

/** Traces one line from `start` downwind until it leaves the map, as ground-plane points. */
const trace = (
  terrain: Terrain,
  windX: number,
  windZ: number,
  start: readonly [number, number],
  limit: number,
): readonly (readonly [number, number, number])[] => {
  const open = windSpeed(windX, windZ);
  const grow = (
    acc: readonly (readonly [number, number, number])[],
  ): readonly (readonly [number, number, number])[] => {
    const [x, z] = acc[acc.length - 1];
    if (acc.length >= MAX_POINTS || Math.abs(x) > limit || Math.abs(z) > limit) return acc;
    // Midpoint step along the local flow direction, so the line is a smooth curve through the field.
    const [ax, az] = flowAt(terrain, windX, windZ, x, z);
    const speedA = Math.hypot(ax, az);
    if (speedA < 0.05 * open) return acc;
    const [mx, mz] = [x + (ax / speedA) * (STREAM_STEP / 2), z + (az / speedA) * (STREAM_STEP / 2)];
    const [bx, bz] = flowAt(terrain, windX, windZ, mx, mz);
    const speedB = Math.hypot(bx, bz);
    if (speedB < 0.05 * open) return acc;
    const next: readonly [number, number, number] = [
      x + (bx / speedB) * STREAM_STEP,
      z + (bz / speedB) * STREAM_STEP,
      speedB / open,
    ];
    return grow([...acc, next]);
  };
  return grow([[start[0], start[1], 1]]);
};

/**
 * Continuous streamlines across the whole map, bent by the terrain the way a flight simulator
 * draws wind: from the upwind edge, one line every `SPACING` metres, each traced through the flow
 * field to the downwind edge and smoothed. Pure in the terrain and the open wind.
 */
export const buildStreamlines = (
  terrain: Terrain,
  windX: number,
  windZ: number,
): readonly Streamline[] => {
  const open = windSpeed(windX, windZ);
  if (open < 0.3) return [];
  const limit = terrain.cfg.worldSize * EXTENT;
  const [ux, uz] = [-windX / open, -windZ / open];
  const [px, pz] = [-uz, ux];
  const count = Math.floor((2 * limit) / SPACING);
  return Array.from({ length: count + 1 }, (_, k) => (k - count / 2) * SPACING).flatMap(
    (across): readonly Streamline[] => {
      const start: readonly [number, number] = [
        clamp(ux * limit + px * across, -limit, limit),
        clamp(uz * limit + pz * across, -limit, limit),
      ];
      const flat = trace(terrain, windX, windZ, start, limit);
      if (flat.length < 8) return [];
      const lifted = flat.map(([x, z]): Vec3 => [
        x,
        Math.max(terrain.heightAt(x, z), terrain.waterLevel) + ABOVE_GROUND,
        z,
      ]);
      const smooth = Array.from({ length: SMOOTHING }).reduce<readonly Vec3[]>(
        (pts) => relax(pts),
        lifted,
      );
      return [{ points: smooth, speeds: flat.map(([, , s]) => s) }];
    },
  );
};
