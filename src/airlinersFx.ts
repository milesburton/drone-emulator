import * as THREE from 'three';
import { AIRLINER_COUNT, airlinerAt } from './airliners';

const PUFFS = 36;
const PUFF_MIN = 3;
const PUFF_MAX = 13;

const buildPlane = (): THREE.Group => {
  const body = new THREE.MeshLambertMaterial({ color: 0xf2f4f7 });
  const group = new THREE.Group();
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 34, 10), body);
  fuselage.rotation.z = Math.PI / 2;
  const wings = new THREE.Mesh(new THREE.BoxGeometry(8, 0.5, 36), body);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(5, 0.5, 12), body);
  tail.position.x = -15;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(5, 7, 0.5), body);
  fin.position.set(-15, 3.5, 0);
  group.add(fuselage, wings, tail, fin);
  return group;
};

export interface AirlinerFx {
  readonly group: THREE.Group;
  readonly update: (seed: number, time: number, extent: number) => void;
}

/** Airliners cruising above the clouds, each trailing a contrail of growing puffs on some passes. */
export const buildAirlinerFx = (): AirlinerFx => {
  const group = new THREE.Group();
  const puffMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    fog: false,
  });
  const planes = Array.from({ length: AIRLINER_COUNT }, () => {
    const plane = buildPlane();
    plane.visible = false;
    const trail = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), puffMaterial, PUFFS);
    trail.frustumCulled = false;
    trail.count = 0;
    group.add(plane, trail);
    return { plane, trail };
  });
  const matrix = new THREE.Matrix4();

  const update: AirlinerFx['update'] = (seed, time, extent) =>
    planes.forEach(({ plane, trail }, i) => {
      const flight = airlinerAt(seed, i, time, extent);
      plane.visible = flight !== null;
      trail.count = 0;
      if (!flight) return;
      plane.position.set(...flight.pos);
      plane.rotation.y = -flight.heading;
      if (!flight.trail) return;
      const [tail, head] = flight.trail;
      trail.count = PUFFS;
      for (let k = 0; k < PUFFS; k++) {
        // k = 0 is the oldest puff, at the far end of the trail; the newest sits just behind the plane.
        const f = k / (PUFFS - 1);
        const size = PUFF_MAX - (PUFF_MAX - PUFF_MIN) * f;
        matrix.makeScale(size, size * 0.8, size);
        matrix.setPosition(
          tail[0] + (head[0] - tail[0]) * f,
          tail[1] + (head[1] - tail[1]) * f - 1,
          tail[2] + (head[2] - tail[2]) * f,
        );
        trail.setMatrixAt(k, matrix);
      }
      trail.instanceMatrix.needsUpdate = true;
    });

  return { group, update };
};
