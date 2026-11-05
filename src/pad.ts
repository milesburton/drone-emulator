import { ranges } from './rng';
import { distanceTo } from './routes';
import type { Terrain } from './terrain';
import type { Vec2, Vec3 } from './types';

/** Pad needs this much dry margin, and ground this flat, to be usable. */
const PAD_MIN_ABOVE_WATER = 3;
const PAD_PROBE = 12;
const PAD_RING_STEP = 20;
const PAD_RINGS = 30;
const PAD_SALT = 0x3c6ef372;

interface PadStandard {
  readonly slope: number;
  readonly river: number;
  readonly road: number;
}

/** Strictest first; hilly or wet seeds fall through to the looser ones. */
const PAD_STANDARDS: readonly PadStandard[] = [
  { slope: 1.5, river: 60, road: 60 },
  { slope: 4, river: 20, road: 25 },
  { slope: 12, river: 0, road: 0 },
];

const usablePad = (terrain: Terrain, x: number, z: number, standard: PadStandard): boolean => {
  const h = terrain.heightAt(x, z);
  const { river, roads } = terrain.routes;
  return (
    h > terrain.waterLevel + PAD_MIN_ABOVE_WATER &&
    [
      [PAD_PROBE, 0],
      [-PAD_PROBE, 0],
      [0, PAD_PROBE],
      [0, -PAD_PROBE],
    ].every(([dx, dz]) => Math.abs(terrain.heightAt(x + dx, z + dz) - h) <= standard.slope) &&
    (!river || distanceTo(river, x, z) > standard.river) &&
    roads.every((road) => distanceTo(road, x, z) > standard.road)
  );
};

/**
 * Launch pad: the nearest ground meeting the strictest standard any candidate meets, searched in
 * widening rings round a seed-chosen spot; failing all standards, the highest candidate.
 */
export const searchPad = (terrain: Terrain, seed: number): Vec3 => {
  const half = terrain.cfg.worldSize / 2;
  const [[cx, cz]] = ranges(seed ^ PAD_SALT, 2, -0.3 * half, 0.3 * half);
  const limit = 0.4 * terrain.cfg.worldSize;
  const candidates = Array.from({ length: PAD_RINGS + 1 }, (_, ring) => {
    const radius = ring * PAD_RING_STEP;
    const count = Math.max(1, ring * 8);
    return Array.from({ length: count }, (_, k): Vec2 => {
      const angle = (2 * Math.PI * k) / count;
      return [cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius];
    });
  })
    .flat()
    .filter(([px, pz]) => Math.abs(px) <= limit && Math.abs(pz) <= limit);
  const highest = candidates.reduce((best, c) =>
    terrain.heightAt(c[0], c[1]) > terrain.heightAt(best[0], best[1]) ? c : best,
  );
  const [x, z] =
    PAD_STANDARDS.map((standard) =>
      candidates.find(([px, pz]) => usablePad(terrain, px, pz, standard)),
    ).find((c) => c !== undefined) ?? highest;
  return [x, terrain.heightAt(x, z), z];
};
