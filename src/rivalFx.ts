import * as THREE from 'three';
import { buildOcto, buildQuad, type Model } from './craftFx';
import { hasImpacted } from './crash';
import { buildCrashFx, type CrashFx } from './crashFx';
import { colourOf } from './rivalColour';
import { gustAt } from './weather';
import type { Rival, Snapshot } from './types';
import type { Terrain } from './terrain';

const ROTOR_SPEED = 60;
const CHARRED = 0x1c1c1e;
const PAD_RADIUS = 11;
interface Entry {
  readonly id: number;
  readonly kind: Rival['kind'];
  readonly model: Model;
  readonly pad: THREE.Mesh;
  readonly crash: CrashFx;
}

export interface RivalFx {
  readonly group: THREE.Group;
  readonly update: (s: Snapshot, terrain: Terrain, scale: number) => void;
}

const buildEntry = (r: Rival): Entry => {
  const model = r.kind === 'octo' ? buildOcto() : buildQuad();
  const colour = colourOf(r.id);
  model.tint?.color.setHex(colour);
  model.tint?.emissive.setHex(colour).multiplyScalar(0.3);
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(PAD_RADIUS, 24).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x5a5a60 }),
  );
  return { id: r.id, kind: r.kind, model, pad, crash: buildCrashFx() };
};

/** The other pilots: a coloured quadcopter or octocopter each, with its pad and its own crash effects. */
export const buildRivalFx = (): RivalFx => {
  const group = new THREE.Group();
  let entries: readonly Entry[] = [];

  const rebuild = (rivals: readonly Rival[]): void => {
    group.clear();
    entries = rivals.map(buildEntry);
    entries.forEach((e) => group.add(e.pad, e.model.group, e.crash.group));
  };

  const update: RivalFx['update'] = (s, terrain, scale) => {
    const same =
      entries.length === s.rivals.length &&
      entries.every((e, i) => e.id === s.rivals[i].id && e.kind === s.rivals[i].kind);
    if (!same) rebuild(s.rivals);
    const gust = gustAt(s.time, s.weather.rain);
    s.rivals.forEach((r, i) => {
      const { model, pad, crash } = entries[i];
      const [x, y, z] = r.drone.pos;
      const down = r.drone.crash;
      pad.position.set(r.mission.home[0], r.mission.home[1] + 0.15, r.mission.home[2]);
      pad.scale.setScalar(scale);
      model.group.scale.setScalar(scale);
      model.group.position.set(x, y, z);
      // The models face +z; YXZ order applies roll, then pitch, then yaw. Three's +x rotation is nose-down.
      model.group.rotation.set(-r.drone.pitch, Math.PI / 2 - r.drone.heading, r.drone.roll, 'YXZ');
      const colour = colourOf(r.id);
      if (model.tint) {
        model.tint.color.setHex(hasImpacted(down) ? CHARRED : colour);
        model.tint.emissive.copy(model.tint.color).multiplyScalar(0.3);
      }
      model.spinners.forEach((spinner, k) => {
        if (!down) spinner.rotation.y = s.time * ROTOR_SPEED * (k % 2 === 0 ? 1 : -1);
        spinner.children.forEach((part, p) => {
          part.visible = p > 0 || !down || r.kind !== 'quad';
        });
        spinner.visible = !(k === 0 && hasImpacted(down));
      });
      crash.update(
        down?.since ?? null,
        [x, y, z],
        [s.config.windX + gust[0], s.config.windZ + gust[1]],
        terrain,
        scale,
        terrain.heightAt(x, z) <= terrain.waterLevel,
      );
    });
  };

  return { group, update };
};
