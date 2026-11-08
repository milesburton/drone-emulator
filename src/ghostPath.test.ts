import { describe, expect, it } from 'vitest';
import { ghostPath, GHOST_AIR_SPEED, GHOST_ARRIVAL, GHOST_TURN_RATE } from './ghostPath';
import { AIR_SPEED, ARRIVAL_RADIUS, createSnapshot, defaultConfig, MAX_TURN_RATE } from './sim';
import { createTerrain } from './terrain';

describe('ghostPath', () => {
  it('uses the same flight constants as the autopilot', () => {
    expect(GHOST_AIR_SPEED).toBe(AIR_SPEED);
    expect(GHOST_TURN_RATE).toBe(MAX_TURN_RATE);
    expect(GHOST_ARRIVAL).toBe(ARRIVAL_RADIUS);
  });

  it.each([7, 42, 1337])('passes within the arrival radius of every flag (seed %i)', (seed) => {
    const cfg = { ...defaultConfig, seed, rivals: 0 };
    const terrain = createTerrain(cfg);
    const { waypoints } = createSnapshot(cfg, terrain);
    const path = ghostPath(waypoints, terrain, cfg);
    waypoints.slice(1).forEach(([wx, , wz]) => {
      const nearest = Math.min(...path.map(([x, , z]) => Math.hypot(x - wx, z - wz)));
      expect(nearest).toBeLessThan(GHOST_ARRIVAL + 15);
    });
    const [hx, , hz] = waypoints[0];
    const [lx, , lz] = path[path.length - 1];
    expect(Math.hypot(lx - hx, lz - hz)).toBeLessThan(GHOST_ARRIVAL + 15);
    path.forEach(([x, y, z]) => expect(y).toBeGreaterThan(terrain.heightAt(x, z)));
  });
});
