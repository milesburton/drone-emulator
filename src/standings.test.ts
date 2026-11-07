import { describe, expect, it } from 'vitest';
import { createSnapshot, defaultConfig } from './sim';
import { standings } from './standings';
import { createTerrain } from './terrain';

describe('standings', () => {
  const cfg = { ...defaultConfig, rivals: 3 };
  const s = createSnapshot(cfg, createTerrain(cfg));

  it('lists the main drone and every rival once', () => {
    const rows = standings(s);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.main)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.name)).size).toBe(4);
  });

  it('puts the pilot with the most completed flights first in a sortie', () => {
    const better = {
      ...s,
      rivals: s.rivals.map((r, i) =>
        i === 1 ? { ...r, mission: { ...r.mission, successes: 5 } } : r,
      ),
    };
    expect(standings(better)[0].name).toBe('Rival 2');
  });

  it('ranks the fastest best time first on a track or run, untimed pilots last', () => {
    const timed = {
      ...s,
      config: { ...s.config, mode: 'run' as const },
      mission: { ...s.mission, bestLap: 30 },
      rivals: s.rivals.map((r, i) =>
        i === 0 ? { ...r, mission: { ...r.mission, bestLap: 20 } } : r,
      ),
    };
    const rows = standings(timed);
    expect(rows[0].name).toBe('Rival 1');
    expect(rows[1].name).toBe('You');
    expect(rows[3].best).toBeNull();
  });
});
