import { describe as suite, expect, it } from 'vitest';
import { bearingOf, pointOf, readouts } from './hud';
import { createSnapshot, defaultConfig } from './sim';
import { createTerrain } from './terrain';

const terrain = createTerrain(defaultConfig);
const fresh = () => createSnapshot(defaultConfig, terrain);

suite('compass', () => {
  it('reads bearings clockwise from north, with north as -z and east as +x', () => {
    expect(bearingOf(0, -1)).toBeCloseTo(0);
    expect(bearingOf(1, 0)).toBeCloseTo(90);
    expect(bearingOf(0, 1)).toBeCloseTo(180);
    expect(bearingOf(-1, 0)).toBeCloseTo(270);
  });

  it('names the eight points and wraps around', () => {
    expect(pointOf(0)).toBe('N');
    expect(pointOf(44)).toBe('NE');
    expect(pointOf(225)).toBe('SW');
    expect(pointOf(359)).toBe('N');
    expect(pointOf(-90)).toBe('W');
  });
});

suite('readouts', () => {
  it('reports the wind arrow downwind and the name upwind', () => {
    const snapshot = fresh();
    const r = readouts(snapshot, terrain, 0);
    // Default wind is +6 x, -3 z: blowing towards the north-east, so it comes from the south-west.
    expect(r.wind.speed).toBeCloseTo(Math.hypot(6, 3), 5);
    expect(r.wind.toward).toBeCloseTo(bearingOf(6, -3), 5);
    expect(r.wind.fromPoint).toBe('SW');
    expect(Math.abs(r.wind.from - r.wind.toward)).toBeCloseTo(180, 5);
  });

  it('summarises the flight', () => {
    const r = readouts(fresh(), terrain, 3.4);
    expect(r.waypoint).toBe('2/6');
    expect(r.weather).toContain('clear');
    expect(r.groundSpeed).toBe(3.4);
    expect(r.battery).toBeGreaterThan(0);
    // On the pad the drone is on the ground, whatever height the ground is.
    expect(r.altitude).toBeLessThan(2);
    expect(r.status.colour).toMatch(/^#[0-9a-f]{6}$/);
  });
});
