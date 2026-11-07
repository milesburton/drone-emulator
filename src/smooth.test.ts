import { describe, expect, it } from 'vitest';
import { approach, smoothClimb, turnSmoothly } from './smooth';

describe('smooth', () => {
  it('approach never overshoots its step', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(0, 2, 3)).toBe(2);
    expect(approach(0, -10, 3)).toBe(-3);
  });

  it('ramps vertical speed instead of jumping', () => {
    expect(smoothClimb(0, 15, 0.05)).toBeLessThan(15);
    expect(smoothClimb(0, 15, 0.05)).toBeGreaterThan(0);
  });

  it('turns with bounded yaw acceleration and settles on the target without overshoot', () => {
    let state = { heading: 0, rate: 0 };
    let previous = 0;
    let peak = 0;
    let overshoot = 0;
    for (let i = 0; i < 400; i++) {
      state = turnSmoothly(state.heading, state.rate, 1.5, 1.2, 0.05);
      expect(Math.abs(state.rate - previous)).toBeLessThanOrEqual(1.2 * 2.2 * 0.05 + 1e-9);
      previous = state.rate;
      peak = Math.max(peak, Math.abs(state.rate));
      overshoot = Math.max(overshoot, state.heading - 1.5);
    }
    expect(peak).toBeLessThanOrEqual(1.2 + 1e-9);
    expect(overshoot).toBeLessThan(0.05);
    expect(state.heading).toBeCloseTo(1.5, 2);
  });
});
