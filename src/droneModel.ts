import * as THREE from 'three';

/**
 * A generic X-frame quadcopter in the style of a DJI Phantom / Mavic: central body, four
 * arms, a motor and spinning rotor on each, a nose camera on a gimbal and landing skids.
 * Faces +z (what `Object3D.lookAt` aims at the target); about 14 units across.
 */
export interface DroneModel {
  readonly group: THREE.Group;
  /** Rotor groups, front-left first, so alternate ones can spin in opposite directions. */
  readonly rotors: readonly THREE.Object3D[];
}

const ARM_REACH = 5.2;
const ROTOR_RADIUS = 3.2;

const BODY = new THREE.MeshLambertMaterial({ color: 0xe8eaed, emissive: 0x333333 });
const DARK = new THREE.MeshLambertMaterial({ color: 0x24262b });
const FRONT = new THREE.MeshLambertMaterial({ color: 0xff453a, emissive: 0x551510 });
const DISC = new THREE.MeshBasicMaterial({
  color: 0xcfd4da,
  transparent: true,
  opacity: 0.28,
  side: THREE.DoubleSide,
});

const at = <T extends THREE.Object3D>(obj: T, x: number, y: number, z: number): T => {
  obj.position.set(x, y, z);
  return obj;
};

const buildArm = (sx: number, sz: number): { arm: THREE.Group; rotor: THREE.Group } => {
  const arm = new THREE.Group();
  const length = Math.hypot(ARM_REACH, ARM_REACH);
  const strut = at(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, length), BODY), 0, 0, 0);
  strut.position.set((sx * ARM_REACH) / 2, 0, (sz * ARM_REACH) / 2);
  strut.rotation.y = Math.atan2(sx, sz);
  const motor = at(
    new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.1, 12), DARK),
    sx * ARM_REACH,
    0.2,
    sz * ARM_REACH,
  );
  const rotor = at(new THREE.Group(), sx * ARM_REACH, 0.95, sz * ARM_REACH);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(ROTOR_RADIUS, 24).rotateX(-Math.PI / 2),
    DISC,
  );
  const blade = new THREE.Mesh(new THREE.BoxGeometry(ROTOR_RADIUS * 2, 0.08, 0.35), DARK);
  rotor.add(disc, blade);
  arm.add(strut, motor, rotor);
  return { arm, rotor };
};

export const buildDrone = (): DroneModel => {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 4.6), BODY);
  const canopy = at(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 3), DARK), 0, 0.9, -0.2);
  const nose = at(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.6), FRONT), 0, 0.1, 2.4);
  const gimbal = at(new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 8), DARK), 0, -1.1, 1.9);
  const lens = at(new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), FRONT), 0, -1.1, 2.6);

  // The red nose and camera lens make the heading readable from a distance.
  const corners = [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ] as const;
  const built = corners.map(([sx, sz]) => buildArm(sx, sz));
  const skids = [-1, 1].map((side) =>
    at(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 5), DARK), side * 1.9, -2.1, 0),
  );
  const legs = [-1, 1].flatMap((side) =>
    [-1.4, 1.4].map((z) =>
      at(new THREE.Mesh(new THREE.BoxGeometry(0.25, 1.8, 0.25), DARK), side * 1.9, -1.2, z),
    ),
  );

  group.add(body, canopy, nose, gimbal, lens, ...skids, ...legs, ...built.map(({ arm }) => arm));
  return { group, rotors: built.map(({ rotor }) => rotor) };
};
