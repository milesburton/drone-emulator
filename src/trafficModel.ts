import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_COLOURS, VEHICLE_KINDS, type Car, type Driver, type VehicleKind } from './traffic';

const tint = (geometry: THREE.BufferGeometry, colour: number): THREE.BufferGeometry => {
  const rgb = new THREE.Color(colour);
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const count = flat.getAttribute('position').count;
  flat.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [rgb.r, rgb.g, rgb.b]).flat(),
      3,
    ),
  );
  return flat;
};

const box = (w: number, h: number, l: number, x: number, y: number, z: number, colour: number) =>
  tint(new THREE.BoxGeometry(w, h, l).translate(x, y, z), colour);

interface Taper {
  /** Top face width and length as fractions of the bottom, and how far it slides along z. */
  readonly top: number;
  readonly topLength: number;
  readonly shift: number;
}

/** A box whose top face is narrower and shifted: a raked windscreen, a sloping bonnet or cab roof. */
const taper = (
  w: number,
  h: number,
  l: number,
  x: number,
  y: number,
  z: number,
  colour: number,
  { top, topLength, shift }: Taper,
): THREE.BufferGeometry => {
  const geometry = new THREE.BoxGeometry(w, h, l);
  const p = geometry.getAttribute('position');
  for (let i = 0; i < p.count; i += 1) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * top);
      p.setZ(i, p.getZ(i) * topLength + shift);
    }
  }
  geometry.computeVertexNormals();
  return tint(geometry.translate(x, y, z), colour);
};

const WHITE = 0xffffff;
const GLASS = 0x22303c;
const TYRE = 0x141414;
const HUB = 0x9aa0a8;
const DARK = 0x2a2a2e;
const HEADLIGHT = 0xfff4c2;
const TAILLIGHT = 0xc01818;

/** A tyre with a hub cap on each side; axis along x. */
const wheel = (x: number, y: number, z: number, radius: number, width: number) => {
  const side = Math.sign(x) || 1;
  return [
    tint(
      new THREE.CylinderGeometry(radius, radius, width, 14).rotateZ(Math.PI / 2).translate(x, y, z),
      TYRE,
    ),
    tint(
      new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.04, 10)
        .rotateZ(Math.PI / 2)
        .translate(x + side * 0.01, y, z),
      HUB,
    ),
  ];
};

const wheelSet = (track: number, radius: number, width: number, zs: readonly number[]) =>
  zs.flatMap((z) => [-1, 1].flatMap((side) => wheel((side * track) / 2, radius, z, radius, width)));

/** Head and tail lights on a flat nose and tail. */
const lights = (width: number, y: number, front: number, rear: number, size = 0.22) =>
  [-1, 1].flatMap((side) => [
    box(size * 1.6, size, 0.08, side * width * 0.36, y, front, HEADLIGHT),
    box(size * 1.6, size, 0.08, side * width * 0.36, y, rear, TAILLIGHT),
  ]);

const mirrors = (width: number, y: number, z: number) =>
  [-1, 1].map((side) => box(0.14, 0.2, 0.22, side * (width / 2 + 0.1), y, z, DARK));

interface Shape {
  /** Takes the per-instance paint. */
  readonly shell: THREE.BufferGeometry;
  /** Fixed colours: glass, wheels, trailers, lights. */
  readonly trim: THREE.BufferGeometry;
}

const raked = { top: 0.82, topLength: 0.62, shift: -0.25 } as const;

/** Every model is built facing +z with its origin on the ground, centred on its length. */
const SHAPES: Readonly<Record<VehicleKind, () => Shape>> = {
  car: () => ({
    shell: mergeGeometries([
      box(1.8, 0.62, 4.3, 0, 0.66, 0, WHITE),
      taper(1.76, 0.2, 4.2, 0, 1.07, 0, WHITE, { top: 0.96, topLength: 0.96, shift: 0 }),
      box(1.28, 0.06, 1.35, 0, 1.76, -0.3, WHITE),
    ]),
    trim: mergeGeometries([
      taper(1.64, 0.62, 2.5, 0, 1.45, -0.28, GLASS, raked),
      box(1.84, 0.2, 0.2, 0, 0.5, 2.15, DARK),
      box(1.84, 0.2, 0.2, 0, 0.5, -2.15, DARK),
      ...lights(1.8, 0.78, 2.16, -2.16),
      ...mirrors(1.8, 1.2, 0.55),
      ...wheelSet(1.74, 0.34, 0.24, [-1.35, 1.4]),
    ]),
  }),
  pickup: () => ({
    shell: mergeGeometries([
      box(2.0, 0.78, 5.4, 0, 0.95, 0, WHITE),
      taper(1.96, 0.24, 5.3, 0, 1.46, 0, WHITE, { top: 0.97, topLength: 0.97, shift: 0 }),
      box(1.7, 0.05, 1.15, 0, 2.15, 0.55, WHITE),
      box(0.12, 0.45, 2.3, -0.95, 1.7, -1.55, WHITE),
      box(0.12, 0.45, 2.3, 0.95, 1.7, -1.55, WHITE),
      box(2.0, 0.45, 0.12, 0, 1.7, -2.65, WHITE),
    ]),
    trim: mergeGeometries([
      taper(1.9, 0.68, 1.9, 0, 1.82, 0.6, GLASS, { top: 0.86, topLength: 0.6, shift: 0.1 }),
      box(1.7, 0.1, 2.2, 0, 1.45, -1.55, DARK),
      box(2.04, 0.22, 0.22, 0, 0.62, 2.7, DARK),
      box(2.04, 0.22, 0.22, 0, 0.62, -2.7, DARK),
      ...lights(2.0, 1.0, 2.71, -2.71, 0.26),
      ...mirrors(2.0, 1.55, 1.3),
      ...wheelSet(1.9, 0.44, 0.3, [-1.8, 1.8]),
    ]),
  }),
  van: () => ({
    shell: mergeGeometries([
      box(2.0, 1.85, 5.3, 0, 1.3, 0, WHITE),
      taper(2.0, 0.5, 1.4, 0, 2.48, 1.9, WHITE, { top: 0.92, topLength: 0.5, shift: -0.35 }),
    ]),
    trim: mergeGeometries([
      taper(1.86, 0.62, 0.6, 0, 1.95, 2.52, GLASS, { top: 0.9, topLength: 0.5, shift: -0.2 }),
      box(2.04, 0.1, 5.2, 0, 1.55, 0, DARK),
      box(2.04, 0.22, 0.22, 0, 0.55, 2.7, DARK),
      box(2.04, 0.22, 0.22, 0, 0.55, -2.7, DARK),
      ...lights(2.0, 0.95, 2.66, -2.66),
      ...mirrors(2.0, 1.85, 2.0),
      ...wheelSet(1.8, 0.4, 0.26, [-1.8, 1.75]),
    ]),
  }),
  truck: () => ({
    shell: mergeGeometries([
      taper(2.2, 1.9, 1.9, 0, 1.55, 3.0, WHITE, { top: 0.95, topLength: 0.7, shift: -0.15 }),
    ]),
    trim: mergeGeometries([
      taper(2.02, 0.7, 0.5, 0, 2.2, 3.8, GLASS, { top: 0.92, topLength: 0.6, shift: -0.15 }),
      box(2.5, 2.55, 5.6, 0, 2.25, -0.85, 0xe6e3d8),
      box(2.52, 0.12, 5.6, 0, 3.55, -0.85, 0xbdbab0),
      box(1.9, 0.35, 8.2, 0, 0.75, 0, DARK),
      box(2.3, 0.25, 0.25, 0, 0.55, -4.0, DARK),
      ...lights(2.2, 0.95, 3.97, -4.0, 0.24),
      ...mirrors(2.2, 2.2, 3.4).map((g) => g.scale(1.6, 1.4, 1)),
      ...wheelSet(2.0, 0.52, 0.32, [-2.8, -1.4, 3.0]),
    ]),
  }),
  semi: () => ({
    shell: mergeGeometries([
      taper(2.5, 2.3, 2.4, 0, 1.95, 6.8, WHITE, { top: 0.95, topLength: 0.72, shift: -0.2 }),
      box(2.2, 0.6, 0.9, 0, 3.35, 6.2, WHITE),
    ]),
    trim: mergeGeometries([
      taper(2.32, 0.72, 0.5, 0, 2.7, 7.6, GLASS, { top: 0.92, topLength: 0.6, shift: -0.15 }),
      box(2.55, 3.0, 11.8, 0, 2.55, -1.2, 0xdedede),
      box(2.57, 0.12, 11.8, 0, 4.1, -1.2, 0xb4b4b4),
      box(2.0, 0.4, 16.0, 0, 0.9, 0, DARK),
      box(2.4, 0.25, 0.25, 0, 0.6, -7.1, DARK),
      ...lights(2.5, 1.0, 8.0, -7.1, 0.26),
      ...mirrors(2.5, 2.6, 7.4).map((g) => g.scale(1.6, 1.4, 1)),
      ...wheelSet(2.1, 0.52, 0.34, [-6.0, -4.6, -3.2, 6.8, 5.5]),
    ]),
  }),
  bus: () => ({
    shell: mergeGeometries([
      box(2.5, 1.2, 11.0, 0, 1.15, 0, WHITE),
      box(2.5, 0.5, 11.0, 0, 3.0, 0, WHITE),
      taper(2.5, 0.1, 11.0, 0, 3.3, 0, WHITE, { top: 0.9, topLength: 0.98, shift: 0 }),
    ]),
    trim: mergeGeometries([
      box(2.54, 1.0, 9.8, 0, 2.25, -0.2, GLASS),
      taper(2.4, 1.05, 0.2, 0, 2.3, 5.55, GLASS, { top: 0.95, topLength: 1, shift: 0 }),
      box(2.4, 0.2, 0.2, 0, 0.7, 5.55, DARK),
      box(2.4, 0.2, 0.2, 0, 0.7, -5.55, DARK),
      ...lights(2.5, 1.05, 5.52, -5.52, 0.26),
      ...mirrors(2.5, 2.3, 5.2).map((g) => g.scale(1.6, 1.8, 1)),
      ...wheelSet(2.2, 0.52, 0.32, [-3.7, 3.7]),
    ]),
  }),
  motorcycle: () => ({
    shell: mergeGeometries([
      taper(0.4, 0.4, 0.8, 0, 0.95, 0.35, WHITE, { top: 0.8, topLength: 0.85, shift: 0 }),
      box(0.28, 0.14, 0.7, 0, 0.78, -0.45, WHITE),
    ]),
    trim: mergeGeometries([
      tint(
        new THREE.CylinderGeometry(0.34, 0.34, 0.14, 12)
          .rotateZ(Math.PI / 2)
          .translate(0, 0.34, 0.85),
        TYRE,
      ),
      tint(
        new THREE.CylinderGeometry(0.34, 0.34, 0.18, 12)
          .rotateZ(Math.PI / 2)
          .translate(0, 0.34, -0.8),
        TYRE,
      ),
      box(0.12, 0.7, 0.1, 0, 0.62, 0.85, 0x777777),
      box(0.45, 0.06, 0.06, 0, 1.2, 0.62, 0x222222),
      box(0.28, 0.3, 0.3, 0, 0.5, 0, 0x555a60),
      box(0.4, 0.62, 0.3, 0, 1.4, -0.2, 0x1d2a44),
      box(0.3, 0.5, 0.26, 0, 1.4, -0.12, 0x1d2a44),
      tint(new THREE.SphereGeometry(0.2, 10, 8).translate(0, 1.92, -0.05), 0xd8d8d8),
      box(0.14, 0.12, 0.06, 0, 1.0, 0.93, HEADLIGHT),
      box(0.12, 0.1, 0.06, 0, 0.9, -1.1, TAILLIGHT),
    ]),
  }),
  tractor: () => ({
    shell: mergeGeometries([
      taper(1.3, 0.8, 2.4, 0, 1.3, 1.1, WHITE, { top: 0.85, topLength: 0.8, shift: 0.1 }),
      box(1.5, 0.1, 1.5, 0, 3.05, -0.4, WHITE),
    ]),
    trim: mergeGeometries([
      box(1.4, 1.5, 1.4, 0, 2.3, -0.4, GLASS),
      box(1.2, 0.6, 1.4, 0, 1.0, -0.4, DARK),
      tint(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 6).translate(0.4, 2.2, 1.6), 0x333333),
      ...wheel(-1.0, 0.9, -0.8, 0.9, 0.55),
      ...wheel(1.0, 0.9, -0.8, 0.9, 0.55),
      ...wheel(-0.75, 0.45, 1.9, 0.45, 0.3),
      ...wheel(0.75, 0.45, 1.9, 0.45, 0.3),
      box(0.4, 0.2, 0.06, 0, 1.2, 2.32, HEADLIGHT),
    ]),
  }),
};

export interface Traffic {
  readonly group: THREE.Group;
  readonly update: (cars: readonly Car[]) => void;
}

/** Two instanced meshes per kind carry every vehicle: 16 draw calls however busy the roads are. */
export const buildTraffic = (drivers: readonly Driver[]): Traffic => {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const fleets = VEHICLE_KINDS.map((kind) => {
    const capacity = drivers.filter((d) => d.kind === kind).length;
    const { shell, trim } = SHAPES[kind]();
    const meshes = [shell, trim].map((geometry) => {
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(capacity, 1));
      mesh.count = capacity;
      mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    });
    return { kind, shell: meshes[0], dark: meshes[1] };
  });
  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();
  const update = (cars: readonly Car[]): void => {
    fleets.forEach(({ kind, shell, dark }) => {
      cars
        .filter((car) => car.kind === kind)
        .forEach((car, i) => {
          dummy.position.set(car.x, car.y, car.z);
          dummy.rotation.set(0, car.yaw, 0);
          dummy.updateMatrix();
          shell.setMatrixAt(i, dummy.matrix);
          dark.setMatrixAt(i, dummy.matrix);
          shell.setColorAt(i, colour.setHex(CAR_COLOURS[car.paint]));
          dark.setColorAt(i, colour.setHex(WHITE));
        });
      [shell, dark].forEach((mesh) => {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
    });
  };
  return { group, update };
};
