import * as THREE from 'three';
import { animalAt, type Animal } from './animals';
import type { Run, RunTree } from './forestRun';
import type { Terrain } from './terrain';
import type { Tunnel } from './tunnels';
import { buildBranch } from './trackModel';

const BARK = new THREE.MeshLambertMaterial({ color: 0x4b3321 });
const CONIFER = new THREE.MeshLambertMaterial({ color: 0x1c4a2a });
const LEAF = new THREE.MeshLambertMaterial({ color: 0x2f6a30 });

/** A giant tree scaled to the airframe: a bare trunk to the crown, then needles or leaves above the flight band. */
export const buildRunTree = (t: RunTree): THREE.Group => {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(t.radius * 0.7, t.radius, t.height * 0.75, 7),
    BARK,
  );
  trunk.position.y = t.height * 0.375;
  group.add(trunk);
  const spread = 1.6 + t.radius * 2.4;
  if (t.species === 'conifer') {
    [0.42, 0.62, 0.8].forEach((from, i) => {
      const tier = new THREE.Mesh(
        new THREE.ConeGeometry(spread * (1 - i * 0.28), t.height * 0.36, 9),
        CONIFER,
      );
      tier.position.y = t.height * (from + 0.1);
      group.add(tier);
    });
  } else {
    const crown = new THREE.Mesh(new THREE.SphereGeometry(spread * 1.25, 10, 8), LEAF);
    crown.position.y = t.height * 0.8;
    crown.scale.y = 0.8;
    group.add(crown);
  }
  group.position.set(...t.pos);
  return group;
};

/** The goal: a pale pillar of light over a glowing disc, visible from across the forest. */
export const buildGoal = (goal: readonly [number, number, number]): THREE.Group => {
  const group = new THREE.Group();
  const glow = new THREE.MeshBasicMaterial({
    color: 0x4dffb4,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 120, 20, 1, true), glow);
  pillar.position.y = 60;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(9, 32), glow);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.6;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(9, 0.35, 6, 40),
    new THREE.MeshBasicMaterial({ color: 0xf5fff9 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 1;
  group.add(pillar, disc, ring);
  group.position.set(...goal);
  return group;
};

const TIMBER = new THREE.MeshLambertMaterial({ color: 0x6d4c2f, side: THREE.FrontSide });
const LINING = new THREE.MeshLambertMaterial({ color: 0x9c8a6c, side: THREE.BackSide });
const RIB = new THREE.MeshLambertMaterial({ color: 0x3e2c1b });
const MOUTH = new THREE.MeshBasicMaterial({ color: 0xffb02e });

/** A tunnel: a hollow tube with a lighter lining, ribs along it, and a glowing ring at each mouth. */
export const buildTunnel = (t: Tunnel): THREE.Group => {
  const group = new THREE.Group();
  // Cylinders stand along y; lay this one along +x, the direction of travel.
  const tube = (radius: number, material: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, t.length, 32, 1, true),
      material,
    );
    m.rotation.z = Math.PI / 2;
    m.position.x = t.length / 2;
    return m;
  };
  group.add(tube(t.outer, TIMBER), tube(t.inner, LINING));
  const ring = (x: number, tubeRadius: number, material: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry((t.inner + t.outer) / 2, tubeRadius, 8, 40),
      material,
    );
    m.rotation.y = Math.PI / 2;
    m.position.x = x;
    return m;
  };
  [0, t.length].forEach((x) => group.add(ring(x, 0.55, MOUTH)));
  Array.from({ length: 4 }, (_, i) => ((i + 1) * t.length) / 5).forEach((x) =>
    group.add(ring(x, 0.35, RIB)),
  );
  group.position.set(...t.entrance);
  group.rotation.y = -t.yaw;
  return group;
};

/** The whole run: every tree and limb in the forest, and the goal. */
export const buildRun = (run: Run): THREE.Group => {
  const group = new THREE.Group();
  run.trees.forEach((t) => group.add(buildRunTree(t)));
  run.branches.forEach((b) => group.add(buildBranch(b)));
  run.tunnels.forEach((t) => group.add(buildTunnel(t)));
  group.add(buildGoal(run.goal));
  return group;
};

const FUR = new THREE.MeshLambertMaterial({ color: 0x8a5a32 });
const FUR_DARK = new THREE.MeshLambertMaterial({ color: 0x5c3b21 });
const FEATHER = new THREE.MeshLambertMaterial({ color: 0x3a3226, side: THREE.DoubleSide });
const PALE = new THREE.MeshLambertMaterial({ color: 0xe9e2d0 });

const box = (w: number, h: number, d: number, m: THREE.Material): THREE.Mesh =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

/** A deer, nose along +x: body, neck and head, four legs and a pair of antlers. About 4 m long. */
const buildDeer = (): THREE.Group => {
  const deer = new THREE.Group();
  const body = box(3.2, 1.2, 1.1, FUR);
  body.position.y = 1.4;
  const neck = box(0.5, 1.3, 0.5, FUR);
  neck.position.set(1.7, 2.1, 0);
  neck.rotation.z = -0.5;
  const head = box(0.9, 0.5, 0.5, FUR_DARK);
  head.position.set(2.15, 2.8, 0);
  const antlers = [-0.2, 0.2].map((z) => {
    const a = box(0.12, 0.9, 0.12, PALE);
    a.position.set(2.0, 3.35, z);
    a.rotation.x = z * 2;
    return a;
  });
  const legs = [
    [1.1, 0.4],
    [1.1, -0.4],
    [-1.1, 0.4],
    [-1.1, -0.4],
  ].map(([x, z]) => {
    const leg = box(0.22, 1.4, 0.22, FUR_DARK);
    leg.position.set(x, 0.7, z);
    return leg;
  });
  deer.add(body, neck, head, ...antlers, ...legs);
  // The model is drawn about 4 m long; a deer is about 1.6 m.
  deer.scale.setScalar(0.4);
  return deer;
};

/** A bird of prey with its wings out, nose along +x. The wings are returned so they can be flapped. */
const buildBird = (): { readonly group: THREE.Group; readonly wings: readonly THREE.Mesh[] } => {
  const bird = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), FEATHER);
  body.scale.set(2.2, 0.8, 0.8);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), PALE);
  head.position.set(1.5, 0.15, 0);
  const wings = [-1, 1].map((side) => {
    const wing = box(1.4, 0.08, 3.2, FEATHER);
    wing.geometry.translate(0, 0, side * 1.6);
    return wing;
  });
  bird.add(body, head, ...wings);
  // Drawn with a 6 m span; a hawk's is about 1.4 m.
  bird.scale.setScalar(0.25);
  return { group: bird, wings };
};

export interface AnimalsView {
  readonly group: THREE.Group;
  /** Moves every animal to where it is at `time`, flapping the birds. */
  readonly update: (terrain: Terrain, time: number) => void;
}

/** One model per animal, created once and moved each frame. */
export const buildAnimals = (animals: readonly Animal[]): AnimalsView => {
  const group = new THREE.Group();
  const parts = animals.map((a) => {
    const built = a.kind === 'deer' ? { group: buildDeer(), wings: [] } : buildBird();
    group.add(built.group);
    return { animal: a, ...built };
  });
  return {
    group,
    update: (terrain, time) =>
      parts.forEach(({ animal, group: model, wings }, i) => {
        const state = animalAt(terrain, animal, time);
        model.position.set(...state.pos);
        // A deer's centre is its back; the model stands on the ground below it.
        if (animal.kind === 'deer') model.position.y -= animal.height;
        model.rotation.y = -state.heading;
        const flap = Math.sin(time * 9 + i) * 0.7;
        wings.forEach((w, k) => {
          w.rotation.x = (k === 0 ? 1 : -1) * flap;
        });
      }),
  };
};
