import { characterOf, type MapCharacter } from './character';
import type { Config } from './types';

export type Biome = 'valley' | 'desert' | 'mountain';

export const BIOMES: readonly Biome[] = ['valley', 'desert', 'mountain'];

type Rgb = readonly [number, number, number];

/** Ground colours by height band, lowest to highest. */
export interface Palette {
  readonly shore: Rgb;
  readonly low: Rgb;
  readonly high: Rgb;
  readonly rock: Rgb;
  readonly peak: Rgb;
  /** Where the bands change, as a fraction of the terrain scale above the water: shore, low, high, rock. */
  readonly bands: readonly [number, number, number, number];
}

export interface BiomeProfile {
  readonly label: string;
  readonly palette: Palette;
  /** Multiplies how many trees grow; 0 for none. */
  readonly treeDensity: number;
  /** Reshapes the seed's character so the biome keeps its look whatever the seed. */
  readonly shape: (c: MapCharacter) => MapCharacter;
}

const valley: BiomeProfile = {
  label: 'Valley',
  palette: {
    shore: [0.78, 0.72, 0.5],
    low: [0.22, 0.48, 0.18],
    high: [0.42, 0.55, 0.22],
    rock: [0.45, 0.42, 0.4],
    peak: [0.95, 0.96, 0.98],
    bands: [0.03, 0.12, 0.5, 0.7],
  },
  treeDensity: 1,
  shape: (c) => c,
};

/** Broad dunes, little water, sparse scrub, sand all the way up. */
const desert: BiomeProfile = {
  label: 'Desert',
  palette: {
    shore: [0.85, 0.76, 0.52],
    low: [0.82, 0.66, 0.4],
    high: [0.76, 0.55, 0.32],
    rock: [0.62, 0.4, 0.27],
    peak: [0.7, 0.5, 0.36],
    bands: [0.03, 0.2, 0.55, 0.8],
  },
  treeDensity: 0.06,
  shape: (c) => ({
    ...c,
    hillFrequency: c.hillFrequency * 0.6,
    relief: c.relief * 0.55,
    lakeWidth: c.lakeWidth * 0.35,
    waterFraction: Math.min(c.waterFraction, 0.26),
    riverHalfWidth: c.riverHalfWidth * 0.6,
  }),
};

/** High, ridged and rocky with snow on the tops; trees thin out early. */
const mountain: BiomeProfile = {
  label: 'Mountain',
  palette: {
    shore: [0.5, 0.48, 0.44],
    low: [0.26, 0.4, 0.2],
    high: [0.4, 0.4, 0.36],
    rock: [0.5, 0.48, 0.46],
    peak: [0.96, 0.97, 1],
    bands: [0.03, 0.1, 0.38, 0.55],
  },
  treeDensity: 0.5,
  shape: (c) => ({
    ...c,
    hillFrequency: c.hillFrequency * 1.25,
    relief: c.relief * 1.5,
  }),
};

const PROFILES: Readonly<Record<Biome, BiomeProfile>> = { valley, desert, mountain };

export const profileOf = (biome: Biome): BiomeProfile => PROFILES[biome];

/** The seed's character as the config's biome reshapes it; what terrain and routes build from. */
export const characterFor = (cfg: Config): MapCharacter =>
  profileOf(cfg.biome).shape(characterOf(cfg.seed));
