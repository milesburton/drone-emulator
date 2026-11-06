import type { Biome } from './biome';
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

/** Long cross-country sorties, or laps of a small gate-and-obstacle track. */
export type Mode = 'sortie' | 'track';

export interface Config {
  readonly mode: Mode;
  readonly seed: number;
  readonly biome: Biome;
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
  /** Present from the moment power is lost until the wreck is collected. */
  readonly crash?: Crash;
}

/** An unpowered drone falling, tumbling and (once down) lying wrecked. */
export interface Crash {
  /** Velocity over the ground, m/s. */
  readonly vel: Vec3;
  /** Tumble rates in rad/s: pitch, roll, yaw. */
  readonly spin: Vec3;
  /** Seconds since impact; null while still in the air. */
  readonly since: number | null;
}

export type Phase = 'grounded' | 'takeoff' | 'cruise' | 'returning' | 'landing' | 'lost';

/** How the last flight ended. */
/** What brought a drone down. */
export type CrashCause = 'terrain' | 'water' | 'craft' | 'gate' | 'obstacle' | 'fence' | 'power';

export type Outcome = 'success' | 'failed' | 'lost' | 'crashed';

/** Why a flight was abandoned; only the cheap cases are told apart so far. */
export type FailureReason = 'battery' | 'wind' | 'rain' | 'distance' | 'unknown';

/** Everything about the current sortie: where the pad is, how much battery is left, how it is going. */
export interface Mission {
  readonly phase: Phase;
  /** Launch pad, on the ground. The route starts and ends here. */
  readonly home: Vec3;
  /** Charge remaining, 0..1. */
  readonly battery: number;
  /** Seconds left on the pad before the next takeoff. */
  readonly groundLeft: number;
  /** True once the flight has turned back; the landing then counts as a failure. */
  readonly aborted: boolean;
  /** Failed attempts on the current route. */
  readonly attempt: number;
  /** Metres flown this flight, and in total. */
  readonly trip: number;
  readonly totalTrip: number;
  readonly successes: number;
  readonly failures: number;
  /** Crashes that began with a flat battery: the drone could neither get home nor reach its target. A subset of `crashed`. */
  readonly lost: number;
  /** Flights that ended in a crash: terrain, water, another craft, or an unpowered fall. Outranks `lost`. */
  readonly crashed: number;
  /** What brought the drone down while in the 'lost' phase; null otherwise. */
  readonly downBy: 'power' | 'impact' | null;
  /** How the last flight ended; cleared at takeoff. */
  readonly outcome: Outcome | null;
  readonly lastFailure: FailureReason | null;
  /** Track mode: laps completed in total, when the current lap began (null before the first start/finish), and the last and best lap times in seconds. */
  readonly laps: number;
  readonly lapStart: number | null;
  readonly lastLap: number | null;
  readonly bestLap: number | null;
  /** Track mode: gates flown through the opening, and gates crossed outside it. */
  readonly passed: number;
  readonly missed: number;
  /** What brought the drone down last time; null until the first crash. */
  readonly crashCause: CrashCause | null;
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
  readonly mission: Mission;
}
