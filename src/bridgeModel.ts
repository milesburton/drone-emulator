import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Terrain } from './terrain';
import type { Vec3 } from './types';

/** The deck counts as a bridge where the ground beneath it is at least this far down. */
const SPAN_GAP = 2;
const FASCIA_DEPTH = 1.2;
const PARAPET_HEIGHT = 0.9;
const PIER_EVERY = 4;
const PIER_LENGTH = 1.6;
const PIER_INSET = 0.8;

/** Whether the ribbon quad starting at pair `q` has air or water under it. */
const spans = (ribbon: readonly Vec3[], terrain: Terrain, q: number): boolean => {
  const [lx, ly, lz] = ribbon[2 * q];
  const [rx, , rz] = ribbon[2 * q + 1];
  return terrain.heightAt((lx + rx) / 2, (lz + rz) / 2) < ly - SPAN_GAP;
};

/**
 * Fascia and parapet along both edges of a road where it crosses water or a gully, with
 * piers down to the ground. Null when the road never leaves the ground.
 */
export const buildBridges = (ribbon: readonly Vec3[], terrain: Terrain): THREE.Mesh | null => {
  const limit = terrain.cfg.worldSize * 0.75;
  const pairs = ribbon.length / 2;
  const bridged = Array.from({ length: pairs - 1 }, (_, q) => q).filter(
    (q) =>
      Math.abs(ribbon[2 * q][0]) < limit &&
      Math.abs(ribbon[2 * q][2]) < limit &&
      spans(ribbon, terrain, q),
  );
  if (bridged.length === 0) return null;
  const walls = bridged.flatMap((q) =>
    ([0, 1] as const).flatMap((side) => {
      const [ax, ay, az] = ribbon[2 * q + side];
      const [bx, by, bz] = ribbon[2 * q + 2 + side];
      const lo = (y: number): number => y - FASCIA_DEPTH;
      const hi = (y: number): number => y + PARAPET_HEIGHT;
      return [
        ax,
        lo(ay),
        az,
        bx,
        lo(by),
        bz,
        bx,
        hi(by),
        bz,
        ax,
        lo(ay),
        az,
        bx,
        hi(by),
        bz,
        ax,
        hi(ay),
        az,
      ];
    }),
  );
  const wallGeometry = new THREE.BufferGeometry();
  wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(walls, 3));
  wallGeometry.computeVertexNormals();
  const piers = bridged
    .filter((q) => q % PIER_EVERY === 0)
    .map((q) => {
      const [lx, ly, lz] = ribbon[2 * q];
      const [rx, , rz] = ribbon[2 * q + 1];
      const cx = (lx + rx) / 2;
      const cz = (lz + rz) / 2;
      const ground = terrain.heightAt(cx, cz) - 1;
      const top = ly - FASCIA_DEPTH;
      const width = Math.hypot(rx - lx, rz - lz) - 2 * PIER_INSET;
      return new THREE.BoxGeometry(width, top - ground, PIER_LENGTH)
        .rotateY(-Math.atan2(rz - lz, rx - lx))
        .translate(cx, (top + ground) / 2, cz);
    });
  return new THREE.Mesh(
    mergeGeometries([
      wallGeometry.toNonIndexed(),
      ...piers.map((p) => p.toNonIndexed().deleteAttribute('uv')),
    ]),
    new THREE.MeshLambertMaterial({ color: 0x9a9a94, side: THREE.DoubleSide }),
  );
};
