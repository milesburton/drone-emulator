import * as THREE from 'three';
import { flagSway } from './swayMaterial';

const CLOTH_WIDTH = 14;
const CLOTH_HEIGHT = 9;
const MIN_POLE = 12;
const CLOTH_SEGMENTS = 24;
const CHEQUER_COLUMNS = 6;
const CHEQUER_ROWS = 4;

/** Magenta cloth: nothing else in the scene is, least of all the yellow route line. */
const CHECKPOINT_COLOUR = '#e0218a';

const POLE = new THREE.MeshLambertMaterial({ color: 0xd8dade });

let chequers: THREE.CanvasTexture | null = null;
const numbered = new Map<number, THREE.CanvasTexture>();

/** White checkpoint number on magenta, built once per number and shared by later routes. */
const numberTexture = (n: number): THREE.CanvasTexture => {
  const cached = numbered.get(n);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 112;
  canvas.height = 72;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = CHECKPOINT_COLOUR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), canvas.width / 2, canvas.height / 2 + 3);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  numbered.set(n, texture);
  return texture;
};

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
 * The cloth subdivided along its length so it can ripple, with each vertex's distance from the
 * pole stored for the shader. The back face is turned in the geometry, not the mesh, so the shader
 * sees the same cloth-space vertices and both faces wave together.
 */
const clothGeometry = (back: boolean): THREE.PlaneGeometry => {
  const geometry = new THREE.PlaneGeometry(CLOTH_WIDTH, CLOTH_HEIGHT, CLOTH_SEGMENTS, 4);
  const x = geometry.getAttribute('position');
  const along = Array.from({ length: x.count }, (_, i) => x.getX(i) + CLOTH_WIDTH / 2);
  geometry.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  geometry.setAttribute(
    'aHoist',
    new THREE.Float32BufferAttribute(
      along.map((a) => a / CLOTH_WIDTH),
      1,
    ),
  );
  return back ? geometry.rotateY(Math.PI) : geometry;
};

/**
 * A flag on a pole standing on the ground with the cloth at `height` above it, where the route
 * passes: chequered for the finish, otherwise a magenta checkpoint carrying its number. The
 * cloth streams along local +x; turn the group about y to point it downwind.
 */
export const buildFlag = (height: number, checkpoint: number | 'finish'): THREE.Group => {
  const pole = Math.max(MIN_POLE, height);
  const group = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, pole, 8), POLE);
  mast.position.y = pole / 2;
  const material = new THREE.MeshBasicMaterial({
    map: checkpoint === 'finish' ? chequerTexture() : numberTexture(checkpoint),
  });
  flagSway(material);
  // One plane per face, so the number reads the right way round from either side.
  const cloth = new THREE.Group();
  cloth.add(
    new THREE.Mesh(clothGeometry(false), material),
    new THREE.Mesh(clothGeometry(true), material),
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
