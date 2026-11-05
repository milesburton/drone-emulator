import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TREE_HEIGHT, type Tree, type TreeKind } from './trees';

const paint = (geometry: THREE.BufferGeometry, colour: number): THREE.BufferGeometry => {
  const rgb = new THREE.Color(colour);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [rgb.r, rgb.g, rgb.b]).flat(),
      3,
    ),
  );
  return geometry.index ? geometry.toNonIndexed() : geometry;
};

const trunk = (height: number, radius: number): THREE.BufferGeometry =>
  paint(
    new THREE.CylinderGeometry(radius * 0.7, radius, height, 6).translate(0, height / 2, 0),
    0x5a3d26,
  );

/** Stacked cones, wide at the bottom, like a spruce. */
const conifer = (): THREE.BufferGeometry =>
  mergeGeometries([
    trunk(TREE_HEIGHT * 0.25, 0.35),
    ...[0, 1, 2, 3].map((tier) =>
      paint(
        new THREE.ConeGeometry(2.6 - tier * 0.5, TREE_HEIGHT * 0.38, 8).translate(
          0,
          TREE_HEIGHT * (0.22 + tier * 0.2) + (TREE_HEIGHT * 0.38) / 2,
          0,
        ),
        tier % 2 ? 0x1f4d2b : 0x265c33,
      ),
    ),
  ]);

/** A clump of rounded blobs on a forked trunk, like an oak. */
const broadleaf = (): THREE.BufferGeometry =>
  mergeGeometries([
    trunk(TREE_HEIGHT * 0.45, 0.45),
    ...(
      [
        [0, 0.68, 0, 3.4],
        [1.7, 0.58, 0.6, 2.5],
        [-1.5, 0.6, -0.8, 2.6],
        [0.2, 0.84, 1.3, 2.3],
      ] as const
    ).map(([x, y, z, r], n) =>
      paint(
        new THREE.IcosahedronGeometry(r, 1).translate(x, TREE_HEIGHT * y, z),
        n % 2 ? 0x4f8a32 : 0x3f7a2b,
      ),
    ),
  ]);

const KINDS: Record<TreeKind, () => THREE.BufferGeometry> = { conifer, broadleaf };

/** One InstancedMesh per kind, so the whole forest costs two draw calls. */
export const buildForest = (trees: readonly Tree[]): THREE.Group => {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const dummy = new THREE.Object3D();
  (Object.keys(KINDS) as TreeKind[]).forEach((kind) => {
    const these = trees.filter((t) => t.kind === kind);
    const mesh = new THREE.InstancedMesh(KINDS[kind](), material, Math.max(these.length, 1));
    mesh.count = these.length;
    these.forEach((t, i) => {
      dummy.position.set(t.x, t.y - 0.3, t.z);
      dummy.rotation.set(0, t.yaw, 0);
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  });
  return group;
};
