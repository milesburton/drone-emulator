import { describe } from './hud';
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
  triggerStorm,
} from './sim';
import { createTerrain } from './terrain';
import type { Config } from './types';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const view = createView(byId<HTMLCanvasElement>('scene'));
const hud = byId('hud');

// The single owner of "current" state: the loop replaces these with new values.
const initialConfig: Config = {
  ...defaultConfig,
  seed: parseSeed(window.location.hash.replace(/^#seed=/, '')) ?? defaultConfig.seed,
};
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
  input.value = String(defaultConfig[key]);
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
  input.checked = defaultConfig[id];
  input.addEventListener('change', () => {
    configure({ [id]: input.checked });
    riverPath.disabled = !model.terrain.routes.river;
  });
};

bindToggle('lakes');
bindToggle('river');
bindToggle('roads');

const seedInput = byId<HTMLInputElement>('seed');
const showSeed = (): void => {
  seedInput.value = String(model.snapshot.config.seed);
  window.history.replaceState(null, '', `#seed=${model.snapshot.config.seed}`);
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
byId('storm').addEventListener('click', () => {
  model.snapshot = triggerStorm(model.snapshot);
});

window.addEventListener('resize', view.resize);
view.resize();

const frame = (last: number) => (now: number) => {
  const dt = Math.min((now - last) / 1000, 0.05);
  model.snapshot = step(model.snapshot, model.terrain, dt);
  view.draw(model.snapshot, model.terrain);
  hud.textContent = describe(model.snapshot);
  requestAnimationFrame(frame(now));
};
requestAnimationFrame((now) => requestAnimationFrame(frame(now)));
