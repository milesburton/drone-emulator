import { describe, expect, it } from 'vitest';
import { AIRLINER_COUNT, TRAIL_LENGTH, airlinerAt } from './airliners';

const times = Array.from({ length: 1500 }, (_, i) => i * 0.8);

describe('airliners', () => {
  it('is deterministic', () => {
    expect(airlinerAt(5, 1, 123.4, 1000)).toEqual(airlinerAt(5, 1, 123.4, 1000));
  });

  it('flies above the clouds and across the map, with gaps when nobody is overhead', () => {
    const seen = times.map((t) => airlinerAt(9, 0, t, 1000));
    const up = seen.filter((a) => a !== null);
    expect(up.length).toBeGreaterThan(50);
    expect(seen.some((a) => a === null)).toBe(true);
    up.forEach((a) => expect(a.pos[1]).toBeGreaterThan(300));
    expect(Math.min(...up.map((a) => Math.hypot(a.pos[0], a.pos[2])))).toBeLessThan(700);
  });

  it('leaves a contrail on some passes only, never longer than the limit', () => {
    const trails = times.flatMap((t) =>
      Array.from({ length: AIRLINER_COUNT }, (_, i) => airlinerAt(3, i, t, 1000)?.trail ?? null),
    );
    expect(trails.some((t) => t !== null)).toBe(true);
    expect(trails.some((t) => t === null)).toBe(true);
    trails.forEach((t) => {
      if (t)
        expect(Math.hypot(t[1][0] - t[0][0], t[1][2] - t[0][2])).toBeLessThanOrEqual(
          TRAIL_LENGTH + 1e-6,
        );
    });
  });
});
