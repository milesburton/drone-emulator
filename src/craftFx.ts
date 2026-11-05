import * as THREE from 'three';
import { CRAFT_COUNT, CRAFT_KINDS, fleetAt, type CraftKind } from './craft';
import { buildDrone } from './droneModel';
import type { Terrain } from './terrain';

const ROTOR_SPEED = 60;
const DARK = new THREE.MeshLambertMaterial({ color: 0x24262b });

interface Model {
  readonly group: THREE.Group;
  /** Spinning parts; alternate ones turn opposite ways. */
  readonly spinners: readonly THREE.Object3D[];
}

const paint = (hex: number): THREE.MeshLambertMaterial =>
  new THREE.MeshLambertMaterial({
    color: hex,
    emissive: new THREE.Color(hex).multiplyScalar(0.25),
  });

/** The standard quadcopter, recoloured so it reads as a different craft from the mission drone. */
const buildQuad = (): Model => {
  const { group, rotors, tint } = buildDrone();
  tint.color.setHex(0xf2a33a);
  tint.emissive.setHex(0x4a3010);
  return { group, spinners: rotors };
};

/** Eight arms round a flat hub, a rotor on each. Faces +z. */
const buildOcto = (): Model => {
  const group = new THREE.Group();
  const frame = paint(0x3a8f6b);
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 1.4, 8), frame));
  const camera = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), DARK);
  camera.position.set(0, -1.3, 1.2);
  group.add(camera);
  const spinners = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * 7.5;
    const z = Math.sin(a) * 7.5;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.4, 0.6), frame);
    arm.position.set(x / 2, 0, z / 2);
    arm.rotation.y = -a;
    const rotor = new THREE.Group();
    rotor.position.set(x, 0.8, z);
    rotor.add(
      new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.9, 8), DARK),
      new THREE.Mesh(new THREE.BoxGeometry(5, 0.08, 0.35), DARK),
    );
    group.add(arm, rotor);
    return rotor;
  });
  return { group, spinners };
};

/** A high-wing RC trainer with a nose propeller. Faces +z. */
const buildPlane = (): Model => {
  const group = new THREE.Group();
  const skin = paint(0xe5483f);
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 12), skin);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(18, 0.35, 3.2), paint(0xf4f4f0));
  wing.position.set(0, 1, 0.5);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 2), skin);
  tail.position.set(0, 0.3, -5.2);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 2), skin);
  fin.position.set(0, 1.5, -5.2);
  const prop = new THREE.Group();
  prop.position.set(0, 0, 6.3);
  prop.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, 0.2), DARK));
  group.add(fuselage, wing, tail, fin, prop);
  return { group, spinners: [prop] };
};

const BUILDERS: Readonly<Record<CraftKind, () => Model>> = {
  quad: buildQuad,
  octo: buildOcto,
  plane: buildPlane,
};

export interface CraftFx {
  readonly group: THREE.Group;
  readonly update: (seed: number, time: number, terrain: Terrain) => void;
}

/** The other aircraft in the area, each flying its own circuit. */
export const buildCraftFx = (): CraftFx => {
  const group = new THREE.Group();
  const models = Array.from({ length: CRAFT_COUNT }, (_, i) => BUILDERS[CRAFT_KINDS[i]]());
  models.forEach((m) => group.add(m.group));

  const update: CraftFx['update'] = (seed, time, terrain) =>
    fleetAt(seed, time, terrain).forEach((craft, i) => {
      const { group: g, spinners } = models[i];
      g.position.set(...craft.pos);
      // The models face +z; YXZ order applies roll, then yaw.
      g.rotation.set(0, Math.PI / 2 - craft.heading, craft.roll, 'YXZ');
      spinners.forEach((s, k) => {
        s.rotation[craft.kind === 'plane' ? 'z' : 'y'] =
          time * ROTOR_SPEED * (k % 2 === 0 ? 1 : -1);
      });
    });

  return { group, update };
};
