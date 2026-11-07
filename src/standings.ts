import { colourOf } from './rivalColour';
import { STATUS_STYLE, statusOf } from './status';
import type { Agent, Snapshot } from './types';

export interface Standing {
  readonly name: string;
  /** Body colour as a CSS hex; the main drone shows its state colour instead. */
  readonly colour: string;
  readonly main: boolean;
  readonly status: string;
  readonly icon: string;
  readonly battery: number;
  /** Flights that ended well, ended in an abort, or ended in a crash. */
  readonly ok: number;
  readonly failed: number;
  readonly crashed: number;
  /** Laps (track) or runs (forest run) finished, and the best time of them. */
  readonly laps: number;
  readonly best: number | null;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

const standing = (s: Snapshot, a: Agent, name: string, colour: number, main: boolean): Standing => {
  const style = STATUS_STYLE[statusOf({ ...s, ...a, rivals: [] })];
  const m = a.mission;
  return {
    name,
    colour: hex(main ? style.colour : colour),
    main,
    status: style.label,
    icon: style.icon,
    battery: m.battery,
    ok: m.successes,
    failed: m.failures,
    crashed: m.crashed,
    laps: m.laps,
    best: m.bestLap,
  };
};

/**
 * Every pilot on the map, best first: in a track or run the fastest best time leads, otherwise
 * the most flights completed; fewer crashes break a tie.
 */
export const standings = (s: Snapshot): readonly Standing[] => {
  const rows = [
    standing(s, s, 'You', 0, true),
    ...s.rivals.map((r) => standing(s, r, `Rival ${r.id}`, colourOf(r.id), false)),
  ];
  const timed = s.config.mode !== 'sortie';
  const rank = (x: Standing): readonly number[] =>
    timed ? [x.best === null ? 1 : 0, x.best ?? 0, x.crashed] : [-x.ok, x.crashed, 0];
  return [...rows].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
};
