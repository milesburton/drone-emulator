import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_COLOURS, type Car } from './traffic';

const box = (w: number, h: number, l: number, x: number, y: number, z: number, colour: number) => {
  const geometry = new THREE.BoxGeometry(w, h, l).translate(x, y, z).toNonIndexed();
  const rgb = new THREE.Color(colour);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [rgb.r, rgb.g, rgb.b]).flat(),
      3,
    ),
  );
  return geometry;
};

/** Painted shell, tinted per instance. About 4.2 m long, facing +z. */
const body = (): THREE.BufferGeometry =>
  mergeGeometries([
    box(1.8, 0.7, 4.2, 0, 0.7, 0, 0xffffff),
    box(1.6, 0.6, 2.2, 0, 1.3, -0.2, 0xffffff),
  ]);

/** Windows and wheels stay dark whatever the paint. */
const trim = (): THREE.BufferGeometry =>
  mergeGeometries([
    box(1.62, 0.4, 2.0, 0, 1.3, -0.2, 0x1b2630),
    ...([-1, 1] as const).flatMap((side) =>
      ([-1.4, 1.4] as const).map((z) => box(0.3, 0.7, 0.7, side * 0.9, 0.35, z, 0x111111)),
    ),
  ]);

export interface Traffic {
  readonly group: THREE.Group;
  readonly update: (cars: readonly Car[]) => void;
}

/** Two instanced meshes carry every car: 2 draw calls however busy the roads are. */
export const buildTraffic = (capacity: number): Traffic => {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const shell = new THREE.InstancedMesh(body(), material, Math.max(capacity, 1));
  const dark = new THREE.InstancedMesh(trim(), material, Math.max(capacity, 1));
  [shell, dark].forEach((mesh) => {
    mesh.count = capacity;
    mesh.frustumCulled = false;
    group.add(mesh);
  });
  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();
  const update = (cars: readonly Car[]): void => {
    cars.forEach((car, i) => {
      dummy.position.set(car.x, car.y, car.z);
      dummy.rotation.set(0, car.yaw, 0);
      dummy.updateMatrix();
      shell.setMatrixAt(i, dummy.matrix);
      dark.setMatrixAt(i, dummy.matrix);
      shell.setColorAt(i, colour.setHex(CAR_COLOURS[car.paint]));
      dark.setColorAt(i, colour.setHex(0xffffff));
    });
    [shell, dark].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  };
  return { group, update };
};
