import { BIOMES, type Biome } from './biome';
import { MAX_SEED, parseSeed } from './sim';
import type { Config, Mode, PathChoice } from './types';

const MODES: readonly Mode[] = ['sortie', 'track', 'run'];

/** Slider limits, matching the controls in the page. */
const WIND: readonly [number, number] = [-20, 20];
const SCALE: readonly [number, number] = [10, 150];
const RIVALS: readonly [number, number] = [0, 7];

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
export interface LinkExtras {
  /** A storm is under way. */
  readonly storm?: boolean;
  /** A hand-picked sortie route. */
  readonly path?: PathChoice;
  /** Seconds the simulation has been running; opening the link fast-forwards to here. */
  readonly elapsed?: number;
}

export const encodeConfig = (cfg: Config, defaults: Config, extras: LinkExtras = {}): string => {
  const parts: readonly (readonly [string, string] | null)[] = [
    ['seed', String(cfg.seed)],
    cfg.mode !== defaults.mode ? ['mode', cfg.mode] : null,
    cfg.biome !== defaults.biome ? ['biome', cfg.biome] : null,
    cfg.windX !== defaults.windX || cfg.windZ !== defaults.windZ
      ? ['wind', `${cfg.windX},${cfg.windZ}`]
      : null,
    cfg.terrainScale !== defaults.terrainScale ? ['scale', String(cfg.terrainScale)] : null,
    cfg.rivals !== defaults.rivals ? ['rivals', String(cfg.rivals)] : null,
    cfg.lakes !== defaults.lakes ? ['lakes', cfg.lakes ? '1' : '0'] : null,
    cfg.river !== defaults.river ? ['river', cfg.river ? '1' : '0'] : null,
    cfg.roads !== defaults.roads ? ['roads', cfg.roads ? '1' : '0'] : null,
    cfg.traffic !== defaults.traffic ? ['traffic', cfg.traffic ? '1' : '0'] : null,
    extras.storm ? ['storm', '1'] : null,
    extras.path !== undefined ? ['path', String(extras.path)] : null,
    extras.elapsed !== undefined && extras.elapsed >= 1
      ? ['t', String(Math.floor(extras.elapsed))]
      : null,
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
  const rivals = whole(params.get('rivals'));
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
    ['rivals', rivals !== null ? clamp(RIVALS, rivals) : undefined],
    ['lakes', flag('lakes')],
    ['river', flag('river')],
    ['roads', flag('roads')],
    ['traffic', flag('traffic')],
  ];
  return Object.fromEntries(pairs.filter(([, v]) => v !== undefined)) as Partial<Config>;
};

/** Whether the link asks for a storm to be under way when the page opens. */
export const decodeStorm = (fragment: string): boolean =>
  new URLSearchParams(fragment.replace(/^#/, '')).get('storm') === '1';

/** The hand-picked sortie route named by the link, if any. */
export const decodePath = (fragment: string): PathChoice | undefined => {
  const text = new URLSearchParams(fragment.replace(/^#/, '')).get('path');
  if (text === 'river') return 'river';
  const n = parseSeed(text ?? '');
  return n === null ? undefined : n;
};

/** Longest stretch a link may fast-forward, seconds; keeps opening one from taking minutes. */
export const MAX_ELAPSED = 300;

/** How many seconds into the run the link was taken, whole seconds within `MAX_ELAPSED`; 0 when absent or malformed. */
export const decodeElapsed = (fragment: string): number => {
  const n = whole(new URLSearchParams(fragment.replace(/^#/, '')).get('t'));
  return n === null ? 0 : clamp([0, MAX_ELAPSED], n);
};
