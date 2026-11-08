import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { colourAt } from './terrain';
import type { Terrain } from './terrain';
import { GRASS_HEIGHT, type Tuft } from './grass';

const BLADES = 3;
const BASE_SHADE = 0.55;

/** Three thin leaning blades fanned round the centre; dark at the root, bright at the tip. */
const tuftGeometry = (): THREE.BufferGeometry =>
  mergeGeometries(
    Array.from({ length: BLADES }, (_, n) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [-0.16, 0, 0, 0.16, 0, 0, 0.04, GRASS_HEIGHT, 0.12 * (n % 2 ? 1 : -1)],
          3,
        ),
      );
      g.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(
          [BASE_SHADE, BASE_SHADE, BASE_SHADE, BASE_SHADE, BASE_SHADE, BASE_SHADE, 1.1, 1.1, 1.1],
          3,
        ),
      );
      g.rotateY((n * Math.PI) / BLADES);
      g.computeVertexNormals();
      return g;
    }),
  );

/** All the grass in one InstancedMesh, coloured from the ground beneath each tuft. */
export const buildGrass = (tufts: readonly Tuft[], terrain: Terrain): THREE.Group => {
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(tuftGeometry(), material, Math.max(tufts.length, 1));
  mesh.count = tufts.length;
  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();
  tufts.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.05, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const [r, g, b] = colourAt(t.y, terrain);
    // Push the ground colour towards green so grass reads as grass on sandy shores too.
    mesh.setColorAt(
      i,
      colour.setRGB(r * 0.8 * t.tone, Math.max(g, r * 0.9) * 1.1 * t.tone, b * 0.7 * t.tone),
    );
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  group.add(mesh);
  return group;
};
