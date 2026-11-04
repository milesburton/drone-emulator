import type { Mat, Vec } from './types';

export const identity = (n: number): Mat =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

export const diag = (v: Vec): Mat => v.map((d, i) => v.map((_, j) => (i === j ? d : 0)));

export const transpose = (a: Mat): Mat => a[0].map((_, j) => a.map((r) => r[j]));

export const mul = (a: Mat, b: Mat): Mat =>
  a.map((r) => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));

export const mulVec = (a: Mat, v: Vec): Vec => a.map((r) => r.reduce((s, x, k) => s + x * v[k], 0));

export const add = (a: Mat, b: Mat): Mat => a.map((r, i) => r.map((v, j) => v + b[i][j]));

export const sub = (a: Mat, b: Mat): Mat => a.map((r, i) => r.map((v, j) => v - b[i][j]));

export const addVec = (a: Vec, b: Vec): Vec => a.map((v, i) => v + b[i]);

export const subVec = (a: Vec, b: Vec): Vec => a.map((v, i) => v - b[i]);

export const symmetrise = (a: Mat): Mat => {
  const t = transpose(a);
  return a.map((r, i) => r.map((v, j) => (v + t[i][j]) / 2));
};

export const trace = (a: Mat): number => a.reduce((s, r, i) => s + r[i], 0);

/** Gauss-Jordan inverse with partial pivoting. Throws on a singular matrix. */
export const inverse = (a: Mat): Mat => {
  const n = a.length;
  const id = identity(n);
  const augmented: Mat = a.map((r, i) => [...r, ...id[i]]);
  const reduced = augmented.reduce<Mat>((m, _, col) => {
    const pivotRow = m.reduce(
      (best, r, i) => (i >= col && Math.abs(r[col]) > Math.abs(m[best][col]) ? i : best),
      col,
    );
    const swapped = m.map((r, i) => (i === col ? m[pivotRow] : i === pivotRow ? m[col] : r));
    const pivot = swapped[col][col];
    if (Math.abs(pivot) < 1e-12) throw new Error('Matrix is singular');
    const normalised = swapped[col].map((v) => v / pivot);
    return swapped.map((r, i) =>
      i === col ? normalised : r.map((v, j) => v - r[col] * normalised[j]),
    );
  }, augmented);
  return reduced.map((r) => r.slice(n));
};
