import {
  add,
  addVec,
  diag,
  identity,
  inverse,
  mul,
  mulVec,
  sub,
  subVec,
  symmetrise,
  transpose,
} from './matrix';
import type { EkfState, Mat, Vec, Vec2 } from './types';

/**
 * Five-state estimator over [x, z, windBiasX, windBiasZ, pressure].
 *
 * The commanded air velocity is a known control input, so ground velocity is
 * `airVelocity + windBias`. The filter has to infer the wind bias from GPS position
 * and barometer readings. The models here are linear, which makes this the
 * degenerate case of an EKF (Jacobians are constant); the structure is the same.
 */
export const STATE_SIZE = 5;

/** GPS x, GPS z, barometer. */
export const MEASUREMENT_MATRIX: Mat = [
  [1, 0, 0, 0, 0],
  [0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1],
];

export const initEkf = (x: Vec, variances: Vec): EkfState => ({ x, P: diag(variances) });

const transition = (dt: number): Mat =>
  identity(STATE_SIZE).map((row, i) =>
    row.map((v, j) => ((i === 0 && j === 2) || (i === 1 && j === 3) ? dt : v)),
  );

export const predict = (
  ekf: EkfState,
  airVelocity: Vec2,
  dt: number,
  processVariance: Vec,
): EkfState => {
  const F = transition(dt);
  const control: Vec = [airVelocity[0] * dt, airVelocity[1] * dt, 0, 0, 0];
  const Q = diag(processVariance.map((q) => q * dt));
  return {
    x: addVec(mulVec(F, ekf.x), control),
    P: symmetrise(add(mul(mul(F, ekf.P), transpose(F)), Q)),
  };
};

export const update = (
  ekf: EkfState,
  measurement: Vec,
  H: Mat,
  measurementVariance: Vec,
): EkfState => {
  const Ht = transpose(H);
  const S = add(mul(mul(H, ekf.P), Ht), diag(measurementVariance));
  const K = mul(mul(ekf.P, Ht), inverse(S));
  const innovation = subVec(measurement, mulVec(H, ekf.x));
  return {
    x: addVec(ekf.x, mulVec(K, innovation)),
    P: symmetrise(mul(sub(identity(STATE_SIZE), mul(K, H)), ekf.P)),
  };
};

export const positionOf = (ekf: EkfState): Vec2 => [ekf.x[0], ekf.x[1]];
export const windBiasOf = (ekf: EkfState): Vec2 => [ekf.x[2], ekf.x[3]];
export const pressureOf = (ekf: EkfState): number => ekf.x[4];
