import { describe, expect, it } from 'vitest';
import { disturbance, FULL_WIND, windStrength } from './sway';

const times = Array.from({ length: 400 }, (_, i) => i * 0.25);
const peak = (strength: number, pick: (d: ReturnType<typeof disturbance>) => number): number =>
  Math.max(...times.map((t) => Math.abs(pick(disturbance(t, strength)))));

describe('windStrength', () => {
  it('is 0 in still air and caps at 1', () => {
    expect(windStrength(0, 0, [0, 0])).toBe(0);
    expect(windStrength(FULL_WIND * 3, 0, [0, 0])).toBe(1);
  });

  it('adds the gust to the steady wind', () => {
    expect(windStrength(6, 0, [4, 0])).toBeCloseTo(0.5);
    expect(windStrength(6, 0, [-6, 0])).toBe(0);
  });
});

describe('disturbance', () => {
  it('is a pure function of time and strength', () => {
    expect(disturbance(12.3, 0.4)).toEqual(disturbance(12.3, 0.4));
  });

  it('is never perfectly still, even in calm air', () => {
    expect(peak(0, (d) => d.roll)).toBeGreaterThan(0.005);
  });

  it('grows with the wind but stays small enough to look corrected', () => {
    expect(peak(1, (d) => d.roll)).toBeGreaterThan(peak(0.2, (d) => d.roll));
    expect(peak(1, (d) => d.roll)).toBeLessThanOrEqual(0.12);
    expect(peak(1, (d) => d.pitch)).toBeLessThanOrEqual(0.12);
    expect(peak(1, (d) => d.offset[0])).toBeLessThanOrEqual(0.7);
  });

  it('moves on every axis', () => {
    const d = disturbance(5, 1);
    [d.roll, d.pitch, d.yaw, ...d.offset].forEach((v) => expect(v).not.toBe(0));
  });
});
