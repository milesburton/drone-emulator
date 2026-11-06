import { BIOMES, profileOf, type Biome } from './biome';
import { createCluster } from './cluster';
import { readouts } from './hud';
import { createView } from './render';
import {
  applyConfig,
  createSnapshot,
  defaultConfig,
  drawSeed,
  followRiver,
  newMap,
  parseSeed,
  randomisePath,
  step,
  calmStorm,
  triggerStorm,
} from './sim';
import { decodeConfig, encodeConfig } from './shareLink';
import { createTerrain } from './terrain';
import type { Config, Mode } from './types';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const view = createView(byId<HTMLCanvasElement>('scene'));
const paintCluster = createCluster(byId('cluster'));

// The single owner of "current" state: the loop replaces these with new values.
// The page's address carries the settings (see shareLink.ts), so a copied link opens the same map and mode.
const initialConfig: Config = { ...defaultConfig, ...decodeConfig(window.location.hash) };
const model = (() => {
  const terrain = createTerrain(initialConfig);
  return { terrain, snapshot: createSnapshot(initialConfig, terrain) };
})();

const configure = (patch: Partial<Config>): void => {
  const [snapshot, terrain] = applyConfig(model.snapshot, model.terrain, patch);
  model.snapshot = snapshot;
  model.terrain = terrain;
};

const bindSlider = (id: string, key: keyof Config): void => {
  const input = byId<HTMLInputElement>(id);
  const label = byId(`${id}-value`);
  input.value = String(initialConfig[key]);
  label.textContent = input.value;
  input.addEventListener('input', () => {
    label.textContent = input.value;
    configure({ [key]: Number(input.value) });
  });
};

const riverPath = byId<HTMLButtonElement>('river-path');
bindSlider('windX', 'windX');
bindSlider('windZ', 'windZ');
bindSlider('terrainScale', 'terrainScale');

const bindToggle = (id: 'lakes' | 'river' | 'roads'): void => {
  const input = byId<HTMLInputElement>(id);
  input.checked = initialConfig[id];
  input.addEventListener('change', () => {
    configure({ [id]: input.checked });
    riverPath.disabled = !model.terrain.routes.river;
  });
};

const modeSelect = byId<HTMLSelectElement>('mode');
modeSelect.add(new Option('Sortie', 'sortie'));
modeSelect.add(new Option('FPV track', 'track'));
modeSelect.add(new Option('Forest run', 'run'));
modeSelect.value = initialConfig.mode;
modeSelect.addEventListener('change', () => {
  const mode = modeSelect.value as Mode;
  // A forest run is run in the forest biome; the biome select follows.
  configure(mode === 'run' ? { mode, biome: 'forest' } : { mode });
  biomeSelect.value = model.snapshot.config.biome;
  riverPath.disabled = !model.terrain.routes.river;
});

const biomeSelect = byId<HTMLSelectElement>('biome');
BIOMES.forEach((b) => biomeSelect.add(new Option(profileOf(b).label, b)));
biomeSelect.value = initialConfig.biome;
biomeSelect.addEventListener('change', () => {
  configure({ biome: biomeSelect.value as Biome });
  riverPath.disabled = !model.terrain.routes.river;
});

bindToggle('lakes');
bindToggle('river');
bindToggle('roads');

// Holding Shift is free look (Ctrl+W closes the tab and can't be blocked); letting go snaps back to the drone.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') view.setFreeLook(true);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') view.setFreeLook(false);
});
window.addEventListener('blur', () => view.setFreeLook(false));
// O toggles a camera high above the FPV track (track mode only).
let overview = false;
window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement && e.target.type === 'text';
  if (e.code !== 'KeyO' || typing || e.repeat) return;
  overview = !overview;
  view.setOverview(overview);
});

const seedInput = byId<HTMLInputElement>('seed');
const showSeed = (): void => {
  seedInput.value = String(model.snapshot.config.seed);
  riverPath.disabled = !model.terrain.routes.river;
};
const loadMap = (seed: number): void => {
  [model.snapshot, model.terrain] = newMap(model.snapshot, seed);
  showSeed();
};
showSeed();
byId('new-map').addEventListener('click', () => {
  const typed = parseSeed(seedInput.value);
  const [drawn, rng] = drawSeed(model.snapshot.rng);
  model.snapshot = { ...model.snapshot, rng };
  // A seed typed in the box that differs from the current map is loaded; otherwise roll a new one.
  loadMap(typed !== null && typed !== model.snapshot.config.seed ? typed : drawn);
});
seedInput.addEventListener('keydown', (e) => {
  const typed = parseSeed(seedInput.value);
  if (e.key === 'Enter' && typed !== null) loadMap(typed);
});

byId('random-path').addEventListener('click', () => {
  model.snapshot = randomisePath(model.snapshot, model.terrain);
});
riverPath.addEventListener('click', () => {
  model.snapshot = followRiver(model.snapshot, model.terrain);
});
// Weather also cycles on its own, so the box mirrors the live phase each frame.
const stormBox = byId<HTMLInputElement>('storm');
stormBox.addEventListener('change', () => {
  model.snapshot = stormBox.checked ? triggerStorm(model.snapshot) : calmStorm(model.snapshot);
});

window.addEventListener('resize', view.resize);
view.resize();

// Ground speed is measured from how far the drone moved, smoothed so the gauge does not flicker.
let lastPos: readonly [number, number] = [model.snapshot.drone.pos[0], model.snapshot.drone.pos[2]];
let groundSpeed = 0;

// Keep the address in step with the settings, writing only when it changes.
let shown = '';
const syncAddress = (): void => {
  const next = `#${encodeConfig(model.snapshot.config, defaultConfig)}`;
  if (next === shown) return;
  shown = next;
  window.history.replaceState(null, '', next);
};

const frame = (last: number) => (now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  model.snapshot = step(model.snapshot, model.terrain, dt);
  view.draw(model.snapshot, model.terrain);
  syncAddress();
  stormBox.checked = model.snapshot.weather.phase === 'storm';
  const [px, , pz] = model.snapshot.drone.pos;
  const moved = Math.hypot(px - lastPos[0], pz - lastPos[1]) / Math.max(dt, 1e-3);
  groundSpeed += (moved - groundSpeed) * Math.min(dt * 4, 1);
  lastPos = [px, pz];
  paintCluster(readouts(model.snapshot, model.terrain, groundSpeed));
  requestAnimationFrame(frame(now));
};
requestAnimationFrame((now) => requestAnimationFrame(frame(now)));
