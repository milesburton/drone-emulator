import * as THREE from 'three';
import { GRAVITY, surfaceAt } from './crash';
import { next } from './rng';
import type { Terrain } from './terrain';
import type { Vec2, Vec3 } from './types';

const DEBRIS = 16;
const PUFFS = 9;
const FIREBALL_TIME = 1.4;
const PUFF_LIFE = 4;
const PUFF_GAP = 0.5;
const DROPS = 28;
/** How long the splash ring and jet last after a water impact, seconds. */
const SPLASH_TIME = 2.2;

const draws = (count: number, seed: number): readonly number[] =>
  Array.from({ length: count }).reduce<{ values: readonly number[]; state: number }>(
    ({ values, state }) => {
      const [v, s] = next(state);
      return { values: [...values, v], state: s };
    },
    { values: [], state: seed },
  ).values;

export interface CrashFx {
  readonly group: THREE.Group;
  /**
   * Draws the effects for `since` seconds after an impact at `at`; null hides them. `scale` is the
   * size of the drone relative to the survey drone the effects were drawn for, and `water` swaps the
   * fireball and smoke for a splash.
   */
  readonly update: (
    since: number | null,
    at: Vec3,
    wind: Vec2,
    terrain: Terrain,
    scale?: number,
    water?: boolean,
  ) => void;
}

/**
 * Fireball, flying debris and a column of smoke (or, in water, a jet, ring and droplets), all worked out from the time since impact alone, so
 * there is no particle state to keep and the same moment always looks the same.
 */
export const buildCrashFx = (): CrashFx => {
  const group = new THREE.Group();
  group.visible = false;

  const fire = new THREE.MeshBasicMaterial({
    color: 0xff7a18,
    transparent: true,
    depthWrite: false,
  });
  const core = new THREE.MeshBasicMaterial({
    color: 0xffe08a,
    transparent: true,
    depthWrite: false,
  });
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const fireball = new THREE.Mesh(sphere, fire);
  const flash = new THREE.Mesh(sphere, core);
  group.add(fireball, flash);

  const shard = new THREE.BoxGeometry(1, 1, 1);
  const shardMaterial = new THREE.MeshLambertMaterial({ color: 0x24262b });
  const r = draws(DEBRIS * 6, 4242);
  const pieces = Array.from({ length: DEBRIS }, (_, i) => {
    const angle = r[i * 6] * Math.PI * 2;
    const speed = 6 + r[i * 6 + 1] * 18;
    return {
      mesh: new THREE.Mesh(shard, shardMaterial),
      vel: [Math.cos(angle) * speed, 9 + r[i * 6 + 2] * 16, Math.sin(angle) * speed] as Vec3,
      spin: [r[i * 6 + 3] * 14, r[i * 6 + 4] * 14, r[i * 6 + 5] * 14] as Vec3,
      size: [0.3 + r[i * 6 + 3] * 1.4, 0.2 + r[i * 6 + 4] * 0.5, 0.4 + r[i * 6 + 5] * 1.3] as Vec3,
    };
  });
  pieces.forEach(({ mesh, size }) => {
    mesh.scale.set(...size);
    group.add(mesh);
  });

  const smoke = Array.from({ length: PUFFS }, () => {
    const material = new THREE.MeshBasicMaterial({
      color: 0x2b2b2e,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(sphere, material);
    group.add(mesh);
    return { mesh, material };
  });

  // The splash: a rising jet, an expanding ring on the surface, and droplets thrown up and out.
  const spray = new THREE.MeshBasicMaterial({
    color: 0xd6ecff,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1, 1, 14, 1, true), spray);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2), spray);
  const sr = draws(DROPS * 3, 777);
  const drops = Array.from({ length: DROPS }, (_, i) => {
    const angle = sr[i * 3] * Math.PI * 2;
    const out = 1 + sr[i * 3 + 1] * 6;
    return {
      mesh: new THREE.Mesh(sphere, spray),
      vel: [Math.cos(angle) * out, 5 + sr[i * 3 + 2] * 9, Math.sin(angle) * out] as Vec3,
      size: 0.18 + sr[i * 3 + 1] * 0.3,
    };
  });
  group.add(jet, ring, ...drops.map((d) => d.mesh));

  const update: CrashFx['update'] = (since, at, wind, terrain, scale = 1, water = false) => {
    group.visible = since !== null;
    if (since === null) return;
    const [x, y, z] = at;

    jet.visible = water;
    ring.visible = water;
    drops.forEach(({ mesh }) => {
      mesh.visible = water;
    });
    fire.visible = !water;
    if (water) {
      const surface = surfaceAt(terrain, x, z);
      const life = Math.min(1, since / SPLASH_TIME);
      // The jet shoots up in the first moments and collapses.
      const rise = Math.sin(Math.min(1, since / 0.9) * Math.PI);
      jet.position.set(x, surface + (rise * 5 * scale) / 2, z);
      jet.scale.set(
        scale * (1 + 0.6 * life),
        Math.max(0.01, rise * 5 * scale),
        scale * (1 + 0.6 * life),
      );
      ring.position.set(x, surface + 0.05, z);
      ring.scale.setScalar(scale * (1.5 + 14 * (1 - (1 - life) ** 2)));
      spray.opacity = 0.8 * (1 - life);
      drops.forEach(({ mesh, vel, size }) => {
        const t = Math.min(since, (2 * vel[1] * scale) / GRAVITY);
        mesh.position.set(
          x + vel[0] * scale * t,
          Math.max(surface, surface + vel[1] * scale * t - 0.5 * GRAVITY * t * t),
          z + vel[2] * scale * t,
        );
        mesh.scale.setScalar(size * scale);
      });
      fireball.visible = false;
      flash.visible = false;
      pieces.forEach(({ mesh }) => {
        mesh.visible = false;
      });
      smoke.forEach(({ mesh }) => {
        mesh.visible = false;
      });
      return;
    }
    pieces.forEach(({ mesh }) => {
      mesh.visible = true;
    });

    const burn = Math.min(1, since / FIREBALL_TIME);
    const ease = 1 - (1 - burn) ** 3;
    fireball.visible = burn < 1;
    fireball.position.set(x, y + 2 * scale, z);
    fireball.scale.setScalar((3 + 13 * ease) * scale);
    fire.opacity = 0.9 * (1 - burn);
    flash.visible = burn < 0.45;
    flash.position.copy(fireball.position);
    flash.scale.setScalar((2 + 8 * ease) * scale);
    core.opacity = 1 - burn / 0.45;

    pieces.forEach(({ mesh, vel, spin, size }) => {
      // Each piece flies until it would be back at the impact height, then lies where it landed.
      const t = Math.min(since, (2 * vel[1] * scale) / GRAVITY);
      const px = x + vel[0] * scale * t;
      const pz = z + vel[2] * scale * t;
      const py = Math.max(
        y + vel[1] * scale * t - 0.5 * GRAVITY * t * t,
        surfaceAt(terrain, px, pz) + 0.2 * scale,
      );
      mesh.position.set(px, py, pz);
      mesh.scale.set(...(size.map((v) => v * scale) as unknown as Vec3));
      mesh.rotation.set(spin[0] * t, spin[1] * t, spin[2] * t);
    });

    smoke.forEach(({ mesh, material }, i) => {
      const age = since - 0.3 - i * PUFF_GAP;
      const a = age < 0 ? -1 : age % PUFF_LIFE;
      mesh.visible = a >= 0;
      if (a < 0) return;
      const life = a / PUFF_LIFE;
      mesh.position.set(
        x + wind[0] * a * 0.6 * scale,
        y + (2 + a * 5) * scale,
        z + wind[1] * a * 0.6 * scale,
      );
      mesh.scale.setScalar((2 + a * 2.5) * scale);
      material.opacity = 0.6 * (1 - life) * Math.min(1, a * 2);
    });
  };

  return { group, update };
};
