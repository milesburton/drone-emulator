import * as THREE from 'three';
import { FRAME as GATE_FRAME } from './gates';
import type { Arena } from './terrain';
import { FENCE_HEIGHT } from './terrain';
import type { Branch } from './forestRun';
import type { Gate, Obstacle, SkyObstacle, Track } from './track';

const trim = (hex: number): THREE.MeshLambertMaterial =>
  new THREE.MeshLambertMaterial({
    color: hex,
    emissive: new THREE.Color(hex).multiplyScalar(0.45),
  });

const FRAME = GATE_FRAME;
const FOOT = 4;
const COLOURS = { gate: 0xff8a00, hoop: 0x20c4ff, arch: 0xb06cff, dive: 0xff2d7a, start: 0x30d158 };

const post = (x: number, top: number, bottom: number, material: THREE.Material): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(FRAME, top - bottom, FRAME), material);
  m.position.set(x, (top + bottom) / 2, 0);
  return m;
};

/**
 * One gate, with its origin at the centre of the opening and the opening facing +z (the way the
 * drone must fly). `drop` is how far the legs reach down to the ground, plus some for slopes.
 */
export const buildGate = (gate: Gate, ground: number, first: boolean): THREE.Group => {
  const group = new THREE.Group();
  const drop = gate.pos[1] - ground + FOOT;
  const half = gate.width / 2;
  const material = trim(first ? COLOURS.start : COLOURS[gate.kind]);
  switch (gate.kind) {
    case 'gate':
    case 'dive': {
      const top = gate.kind === 'dive' ? half * 1.6 : half;
      group.add(
        post(-half - FRAME / 2, top, -drop, material),
        post(half + FRAME / 2, top, -drop, material),
      );
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(gate.width + FRAME * 2, FRAME, FRAME),
        material,
      );
      bar.position.y = top;
      group.add(bar);
      if (gate.kind === 'dive') {
        // A lower bar marks the bottom of the opening that has to be cleared.
        const sill = bar.clone();
        sill.position.y = -half;
        group.add(sill);
      }
      break;
    }
    case 'hoop': {
      group.add(new THREE.Mesh(new THREE.TorusGeometry(half, 0.7, 8, 40), material));
      group.add(post(0, -half, -drop, material));
      break;
    }
    case 'arch': {
      group.add(
        post(-half, 0, -drop, material),
        post(half, 0, -drop, material),
        new THREE.Mesh(new THREE.TorusGeometry(half, 0.7, 8, 28, Math.PI), material),
      );
      break;
    }
  }
  group.position.set(...gate.pos);
  // The models face +z; this is the same turn the drone model gets from its heading.
  group.rotation.y = Math.PI / 2 - gate.yaw;
  return group;
};

const STRIPES = 5;
const RED = new THREE.MeshLambertMaterial({ color: 0xd8372f });
const WHITE = new THREE.MeshLambertMaterial({ color: 0xf2f2ee });

/** An obstacle seated on the ground at its own origin. */
export const buildObstacle = (o: Obstacle): THREE.Group => {
  const group = new THREE.Group();
  switch (o.kind) {
    case 'pylon': {
      const h = o.height / STRIPES;
      Array.from({ length: STRIPES }, (_, i) => {
        const seg = new THREE.Mesh(
          new THREE.CylinderGeometry(o.radius * 0.8, o.radius, h, 10),
          i % 2 ? WHITE : RED,
        );
        seg.position.y = h * (i + 0.5);
        group.add(seg);
      });
      break;
    }
    case 'pole': {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(o.radius, o.radius, o.height, 6),
        WHITE,
      );
      pole.position.y = o.height / 2;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(o.radius * 2, 8, 6), RED);
      cap.position.y = o.height;
      group.add(pole, cap);
      break;
    }
    case 'flag': {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(o.radius * 0.4, o.radius * 0.4, o.height, 6),
        WHITE,
      );
      pole.position.y = o.height / 2;
      const cloth = new THREE.Mesh(
        new THREE.PlaneGeometry(o.radius * 5, o.radius * 3),
        new THREE.MeshLambertMaterial({ color: 0xffd60a, side: THREE.DoubleSide }),
      );
      cloth.position.set(o.radius * 2.5, o.height - o.radius * 1.5, 0);
      group.add(pole, cloth);
      break;
    }
    case 'tree': {
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(o.radius * 0.25, o.radius * 0.35, o.height * 0.3, 6),
        new THREE.MeshLambertMaterial({ color: 0x5a3d26 }),
      );
      trunk.position.y = o.height * 0.15;
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(o.radius, o.height * 0.8, 8),
        new THREE.MeshLambertMaterial({ color: 0x1f5a30 }),
      );
      crown.position.y = o.height * 0.6;
      group.add(trunk, crown);
      break;
    }
  }
  group.position.set(...o.pos);
  return group;
};

/** A balloon (banded sphere with a basket) or a blimp (flattened hull with fins and a gondola), centred on its own origin. */
export const buildSky = (o: SkyObstacle): THREE.Group => {
  const group = new THREE.Group();
  const r = o.radius;
  if (o.kind === 'balloon') {
    const envelope = new THREE.Mesh(
      new THREE.SphereGeometry(r, 16, 12),
      new THREE.MeshLambertMaterial({ color: 0xe8453c }),
    );
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.002, r * 1.002, r * 0.35, 16, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xf5f1e6, side: THREE.DoubleSide }),
    );
    const basket = new THREE.Mesh(
      new THREE.BoxGeometry(r * 0.35, r * 0.25, r * 0.35),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
    );
    basket.position.y = -r * 1.25;
    group.add(envelope, band, basket);
  } else {
    const hull = new THREE.Mesh(
      new THREE.SphereGeometry(r, 18, 12),
      new THREE.MeshLambertMaterial({ color: 0xc9ced6 }),
    );
    // The hull sits inside the collision sphere, so what you see is never softer than what you hit.
    hull.scale.set(1, 0.5, 0.5);
    const gondola = new THREE.Mesh(
      new THREE.BoxGeometry(r * 0.7, r * 0.22, r * 0.25),
      new THREE.MeshLambertMaterial({ color: 0x3a3f48 }),
    );
    gondola.position.y = -r * 0.62;
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(r * 0.5, r * 0.7, r * 0.05),
      new THREE.MeshLambertMaterial({ color: 0xd8372f }),
    );
    fin.position.set(-r * 0.9, 0, 0);
    const fin2 = fin.clone();
    fin2.rotation.x = Math.PI / 2;
    group.add(hull, gondola, fin, fin2);
  }
  group.position.set(...o.pos);
  return group;
};

/** A limb: a bark-brown cylinder from the trunk to its tip, with a tuft of leaves at the end. In world coordinates. */
export const buildBranch = (b: Branch): THREE.Group => {
  const group = new THREE.Group();
  const from = new THREE.Vector3(...b.from);
  const to = new THREE.Vector3(...b.to);
  const length = from.distanceTo(to);
  const limb = new THREE.Mesh(
    new THREE.CylinderGeometry(b.radius * 0.5, b.radius, length, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a3d26 }),
  );
  limb.position.copy(from).lerp(to, 0.5);
  limb.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  const tuft = new THREE.Mesh(
    new THREE.SphereGeometry(b.radius * 3, 8, 6),
    new THREE.MeshLambertMaterial({ color: 0x2c6b34 }),
  );
  tuft.position.copy(to);
  group.add(limb, tuft);
  return group;
};

/** The whole track: every gate and obstacle, and a faint line through the gates in flying order. */
/** A mesh fence round the arena: posts, rails and a faint netting, standing on the arena floor. */
export const buildFence = (arena: Arena): THREE.Group => {
  const group = new THREE.Group();
  const [cx, cy, cz] = arena.centre;
  const net = new THREE.Mesh(
    new THREE.CylinderGeometry(arena.radius, arena.radius, FENCE_HEIGHT, 128, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xdfe8f0,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  net.position.set(cx, cy + FENCE_HEIGHT / 2, cz);
  group.add(net);
  const metal = new THREE.MeshLambertMaterial({ color: 0x8a949e });
  [0.02, 0.5, 1].forEach((f) => {
    const rail = new THREE.Mesh(new THREE.TorusGeometry(arena.radius, 0.5, 6, 160), metal);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(cx, cy + f * FENCE_HEIGHT, cz);
    group.add(rail);
  });
  const count = 96;
  const posts = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.4, FENCE_HEIGHT, 1.4),
    metal,
    count,
  );
  const m = new THREE.Matrix4();
  Array.from({ length: count }).forEach((_, i) => {
    const a = (i / count) * Math.PI * 2;
    posts.setMatrixAt(
      i,
      m.makeTranslation(
        cx + Math.cos(a) * arena.radius,
        cy + FENCE_HEIGHT / 2,
        cz + Math.sin(a) * arena.radius,
      ),
    );
  });
  group.add(posts);
  return group;
};

export const buildTrack = (
  track: Track,
  groundAt: (x: number, z: number) => number,
  arena: Arena | null = null,
): THREE.Group => {
  const group = new THREE.Group();
  if (arena) group.add(buildFence(arena));
  track.gates.forEach((g, i) => group.add(buildGate(g, groundAt(g.pos[0], g.pos[2]), i === 0)));
  track.obstacles.forEach((o) => group.add(buildObstacle(o)));
  track.sky.forEach((o) => group.add(buildSky(o)));
  const loop = [...track.gates, track.gates[0]].map((g) => new THREE.Vector3(...g.pos));
  group.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(loop),
      new THREE.LineBasicMaterial({ color: 0x20c4ff, transparent: true, opacity: 0.5 }),
    ),
  );
  return group;
};
