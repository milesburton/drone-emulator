import { BIOMES, type Biome } from './biome';
import { MAX_SEED, parseSeed } from './sim';
import type { Config, Mode } from './types';

const MODES: readonly Mode[] = ['sortie', 'track', 'run'];

/** Slider limits, matching the controls in the page. */
const WIND: readonly [number, number] = [-20, 20];
const SCALE: readonly [number, number] = [10, 150];

const clamp = ([lo, hi]: readonly [number, number], n: number): number =>
  Math.min(hi, Math.max(lo, n));

const whole = (text: string | null): number | null => {
  if (text === null || text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * The settings a person can change, as a short URL fragment (`seed=7&mode=run&wind=6,-3`).
 * Only what differs from `defaults` is written, so the common case stays short.
 */
export const encodeConfig = (cfg: Config, defaults: Config, storm = false): string => {
  const parts: readonly (readonly [string, string] | null)[] = [
    ['seed', String(cfg.seed)],
    cfg.mode !== defaults.mode ? ['mode', cfg.mode] : null,
    cfg.biome !== defaults.biome ? ['biome', cfg.biome] : null,
    cfg.windX !== defaults.windX || cfg.windZ !== defaults.windZ
      ? ['wind', `${cfg.windX},${cfg.windZ}`]
      : null,
    cfg.terrainScale !== defaults.terrainScale ? ['scale', String(cfg.terrainScale)] : null,
    cfg.lakes !== defaults.lakes ? ['lakes', cfg.lakes ? '1' : '0'] : null,
    cfg.river !== defaults.river ? ['river', cfg.river ? '1' : '0'] : null,
    cfg.roads !== defaults.roads ? ['roads', cfg.roads ? '1' : '0'] : null,
    storm ? ['storm', '1'] : null,
  ];
  return parts
    .flatMap((p) => (p ? [p] : []))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
};

/**
 * Reads a fragment (with or without the leading `#`) back into settings. Anything missing,
 * malformed or out of range is left out, so a hand-edited or old link still opens.
 */
export const decodeConfig = (fragment: string): Partial<Config> => {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const seed = parseSeed(params.get('seed') ?? '');
  const mode = params.get('mode');
  const biome = params.get('biome');
  const [wx, wz] = (params.get('wind') ?? '').split(',').map((v) => whole(v));
  const scale = whole(params.get('scale'));
  const flag = (k: string): boolean | undefined => {
    const v = params.get(k);
    return v === '1' ? true : v === '0' ? false : undefined;
  };
  const pairs: readonly (readonly [keyof Config, unknown])[] = [
    ['seed', seed !== null && seed <= MAX_SEED ? seed : undefined],
    ['mode', MODES.includes(mode as Mode) ? (mode as Mode) : undefined],
    ['biome', BIOMES.includes(biome as Biome) ? (biome as Biome) : undefined],
    [
      'windX',
      wx !== null && wx !== undefined && wz !== null && wz !== undefined
        ? clamp(WIND, wx)
        : undefined,
    ],
    [
      'windZ',
      wx !== null && wx !== undefined && wz !== null && wz !== undefined
        ? clamp(WIND, wz)
        : undefined,
    ],
    ['terrainScale', scale !== null ? clamp(SCALE, scale) : undefined],
    ['lakes', flag('lakes')],
    ['river', flag('river')],
    ['roads', flag('roads')],
  ];
  return Object.fromEntries(pairs.filter(([, v]) => v !== undefined)) as Partial<Config>;
};

/** Whether the link asks for a storm to be under way when the page opens. */
export const decodeStorm = (fragment: string): boolean =>
  new URLSearchParams(fragment.replace(/^#/, '')).get('storm') === '1';
