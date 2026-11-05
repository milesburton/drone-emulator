import * as THREE from 'three';

const CLOTH_WIDTH = 14;
const CLOTH_HEIGHT = 9;
const MIN_POLE = 12;
const CHEQUER_COLUMNS = 6;
const CHEQUER_ROWS = 4;

const POLE = new THREE.MeshLambertMaterial({ color: 0xd8dade });

let chequers: THREE.CanvasTexture | null = null;

/** Black and white chequerboard, built once and shared by every finish flag. */
const chequerTexture = (): THREE.CanvasTexture => {
  if (chequers) return chequers;
  const cell = 16;
  const canvas = document.createElement('canvas');
  canvas.width = CHEQUER_COLUMNS * cell;
  canvas.height = CHEQUER_ROWS * cell;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    for (let row = 0; row < CHEQUER_ROWS; row++) {
      for (let col = 0; col < CHEQUER_COLUMNS; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#111111' : '#f5f5f5';
        ctx.fillRect(col * cell, row * cell, cell, cell);
      }
    }
  }
  chequers = new THREE.CanvasTexture(canvas);
  chequers.magFilter = THREE.NearestFilter;
  chequers.colorSpace = THREE.SRGBColorSpace;
  return chequers;
};

/**
 * A flag on a pole standing on the ground with the cloth at `height` above it, where the route
 * passes. The cloth streams along local +x; turn the group about y to point it downwind.
 */
export const buildFlag = (height: number, finish: boolean): THREE.Group => {
  const pole = Math.max(MIN_POLE, height);
  const group = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, pole, 8), POLE);
  mast.position.y = pole / 2;
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(CLOTH_WIDTH, CLOTH_HEIGHT),
    new THREE.MeshBasicMaterial(
      finish
        ? { map: chequerTexture(), side: THREE.DoubleSide }
        : { color: 0xffd60a, side: THREE.DoubleSide },
    ),
  );
  cloth.position.set(CLOTH_WIDTH / 2 + 0.4, pole - CLOTH_HEIGHT / 2, 0);
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), POLE);
  finial.position.y = pole + 0.6;
  group.add(mast, cloth, finial);
  return group;
};

/** Turns a flag to stream with the wind; left as it was when the air is still. */
export const faceDownwind = (flag: THREE.Object3D, windX: number, windZ: number): void => {
  if (Math.hypot(windX, windZ) < 0.1) return;
  flag.rotation.y = -Math.atan2(windZ, windX);
};
