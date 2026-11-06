import { FOOTPRINT } from './altitude';
import type { Config } from './types';

/**
 * The micro drone flown on the FPV track and the forest run: about 3 m across, the size of a real
 * racing quad. The survey drone of the sortie mode is 14 m (`FOOTPRINT` in altitude.ts).
 */
export const AIRFRAME_RADIUS = 1.4;
/** Vertical reach of the micro airframe about its centre: skids below, rotors above. */
export const AIRFRAME_REACH = 0.6;
/** Size of the micro drone as a fraction of the survey drone, for drawing it. */
export const MICRO_SCALE = (2 * AIRFRAME_RADIUS) / (2 * FOOTPRINT);

/** The footprint radius of the airframe flown in this mode. */
export const footprintFor = (cfg: Config): number =>
  cfg.mode === 'sortie' ? FOOTPRINT : AIRFRAME_RADIUS;
