/** Pure mulberry32: maps a state to [value in 0..1, nextState]. */
export const next = (state: number): readonly [number, number] => {
  const s = (state + 0x6d2b79f5) | 0;
  const a = Math.imul(s ^ (s >>> 15), 1 | s);
  const b = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
  return [((b ^ (b >>> 14)) >>> 0) / 4294967296, s];
};

export const nextRange = (state: number, min: number, max: number): readonly [number, number] => {
  const [v, s] = next(state);
  return [min + v * (max - min), s];
};

/** Standard normal via Box-Muller. */
export const nextGaussian = (state: number): readonly [number, number] => {
  const [u1, s1] = next(state);
  const [u2, s2] = next(s1);
  return [Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2), s2];
};

export const gaussians = (state: number, count: number): readonly [readonly number[], number] =>
  Array.from({ length: count }).reduce<readonly [readonly number[], number]>(
    ([values, s]) => {
      const [v, s2] = nextGaussian(s);
      return [[...values, v], s2];
    },
    [[], state],
  );

export const ranges = (
  state: number,
  count: number,
  min: number,
  max: number,
): readonly [readonly number[], number] =>
  Array.from({ length: count }).reduce<readonly [readonly number[], number]>(
    ([values, s]) => {
      const [v, s2] = nextRange(s, min, max);
      return [[...values, v], s2];
    },
    [[], state],
  );

/**
 * Adapts a seed to the `() => number` source simplex-noise expects. The closure
 * owns its private counter; it is created fresh per seed so results are deterministic.
 */
export const toRandomFn = (seed: number): (() => number) => {
  const state = { value: seed };
  return () => {
    const [v, s] = next(state.value);
    state.value = s;
    return v;
  };
};
