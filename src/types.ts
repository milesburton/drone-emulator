export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export interface Config {
  readonly seed: number;
  readonly windX: number;
  readonly windZ: number;
  readonly terrainScale: number;
  readonly worldSize: number;
  readonly resolution: number;
  /** Noise-carved ponds and lakes. */
  readonly lakes: boolean;
  /** A winding river that the drone can follow. */
  readonly river: boolean;
  readonly roads: boolean;
}

export interface Cloud {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export type WeatherPhase = 'clear' | 'storm';

export interface Weather {
  readonly clouds: readonly Cloud[];
  readonly phase: WeatherPhase;
  readonly phaseLeft: number;
  /** Rain intensity, 0..1, eased towards the phase target. */
  readonly rain: number;
  /** Lightning flash brightness, 0..1, decaying. */
  readonly flash: number;
  readonly nextStrikeIn: number;
  readonly strike: Vec2 | null;
}

export interface Drone {
  readonly pos: Vec3;
  /** Index of the waypoint currently being flown to. */
  readonly wp: number;
  /** Direction of travel in radians on the ground plane, atan2(dz, dx). */
  readonly heading: number;
  /** Nose-up pitch in radians; eased towards what the climb rate calls for. */
  readonly pitch: number;
  /** Bank in radians, right wing down positive; follows the turn rate. */
  readonly roll: number;
}

export type Vec = readonly number[];
export type Mat = readonly (readonly number[])[];

/** EKF over [x, z, windBiasX, windBiasZ, pressure]. */
export interface EkfState {
  readonly x: Vec;
  readonly P: Mat;
}

export interface Snapshot {
  readonly time: number;
  /** State of the seeded RNG; every random draw returns the next state. */
  readonly rng: number;
  readonly config: Config;
  readonly waypoints: readonly Vec3[];
  readonly drone: Drone;
  readonly ekf: EkfState;
  readonly weather: Weather;
}
