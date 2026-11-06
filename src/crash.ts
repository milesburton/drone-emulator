import { FOOTPRINT, groundBeneath } from './altitude';
import type { Terrain } from './terrain';
import type { Crash, Drone, Vec2, Vec3 } from './types';

export const GRAVITY = 9.81;
/** Fastest a dead drone falls, m/s; the airframe is draggy. */
export const TERMINAL_SPEED = 45;
/** Per second, how fast forward momentum bleeds into the wind. */
const DRAG = 0.4;

/** A drone that has just lost power: it keeps its momentum, then tumbles. `rolls` are 0..1 draws. */
export const beginCrash = (velocity: Vec3, rolls: readonly [number, number, number]): Crash => ({
  vel: velocity,
  spin: [1.5 + rolls[0] * 3, (rolls[1] - 0.5) * 10, (rolls[2] - 0.5) * 5],
  since: null,
});

export interface Fall {
  readonly pos: Vec3;
  readonly pitch: number;
  readonly roll: number;
  readonly heading: number;
  readonly crash: Crash;
}

/** Attitude a wreck comes to rest in: on its back or its side, never neatly level. */
const restingRoll = (roll: number): number => Math.PI * Math.round(roll / Math.PI) + 0.45;

/**
 * One step of an unpowered fall: momentum fades into the wind, gravity pulls, the airframe
 * tumbles. The first step that reaches the terrain is the impact; after it nothing moves.
 */
export const fall = (
  drone: Drone,
  crash: Crash,
  terrain: Terrain,
  wind: Vec2,
  dt: number,
): Fall => {
  if (crash.since !== null) {
    return {
      pos: drone.pos,
      pitch: drone.pitch,
      roll: drone.roll,
      heading: drone.heading,
      crash: { ...crash, since: crash.since + dt },
    };
  }
  const k = 1 - Math.exp(-DRAG * dt);
  const vel: Vec3 = [
    crash.vel[0] + (wind[0] - crash.vel[0]) * k,
    Math.max(-TERMINAL_SPEED, crash.vel[1] - GRAVITY * dt),
    crash.vel[2] + (wind[1] - crash.vel[2]) * k,
  ];
  const nx = drone.pos[0] + vel[0] * dt;
  const nz = drone.pos[2] + vel[2] * dt;
  const ny = drone.pos[1] + vel[1] * dt;
  const ground = surfaceAt(terrain, nx, nz);
  const pitch = drone.pitch + crash.spin[0] * dt;
  const roll = drone.roll + crash.spin[1] * dt;
  const heading = drone.heading + crash.spin[2] * dt;
  return ny > ground
    ? { pos: [nx, ny, nz], pitch, roll, heading, crash: { ...crash, vel } }
    : {
        pos: [nx, ground, nz],
        pitch: 0.3,
        roll: restingRoll(roll),
        heading,
        crash: { ...crash, vel: [0, 0, 0], since: 0 },
      };
};

/** Highest thing underfoot: the land, or the water standing over it. A drone that touches either is down. */
export const surfaceAt = (terrain: Terrain, x: number, z: number): number =>
  Math.max(terrain.heightAt(x, z), terrain.waterLevel);

/** How far the skids hang below the centre of the airframe, metres. */
const SKID_DROP = 2;

/** True once any part of the airframe (the centre, a rotor tip or the skids) is at or below the land or water. */
export const hasHitTerrain = (pos: Vec3, terrain: Terrain, footprint = FOOTPRINT): boolean =>
  pos[1] - SKID_DROP * (footprint / FOOTPRINT) <=
  Math.max(
    terrain.waterLevel,
    groundBeneath(terrain, pos[0], pos[2], footprint),
    surfaceAt(terrain, pos[0], pos[2]),
  );

/** True once a crashing drone has reached the ground. */
export const hasImpacted = (crash: Crash | undefined): boolean =>
  crash !== undefined && crash.since !== null;
