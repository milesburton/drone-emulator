# FPV training track: plan (TODO item 7)

Status: **plan only, nothing built.** Written 2026-11-05.

## Goal

A second mode: a short closed circuit, far smaller than the sortie routes (those are about 9 km at
the 70% energy budget), with obstacles to fly **through** (gates, hoops, arches) and to **avoid**
(pylons, poles, flags, trees). Reuses the existing sim, crash pipeline and renderer.

## Scale: the decision that shapes everything

The airframe is about 14 m across, with a 7 m reach for collisions, and it cruises at 36 m/s. Real
FPV gates are about 1.5 m. We cannot shrink the course to real size without shrinking the drone.

| Option                              | Gate opening                     | Lap                   | Verdict                                                        |
| ----------------------------------- | -------------------------------- | --------------------- | -------------------------------------------------------------- |
| A. Scale the course to the drone    | 24 m (about 8 m clear each side) | 500-700 m, about 20 s | **Recommended**: no change to the drone or collision code      |
| B. Add a "micro" drone at 1/5 scale | 5 m                              | 150 m                 | Needs a second model, footprint, speed and camera scale; later |

Go with A. Also add a mode-specific speed (about 20 m/s) so corners are flyable at a 30 m turn radius.

## Design

1. **Mode.** `Config.mode: 'sortie' | 'track'` with a toggle in the panel. Track mode keeps seeded
   terrain but picks a flat, dry arena (extend `searchPad` to find a 400 x 300 m clear area; the
   Valley biome is the default). Sortie mode is untouched.
2. **Track generator** (`track.ts`, pure and seeded like `waypoints.ts`): a closed loop of 8-12
   gates along a smooth curve, then obstacles placed beside and across the line.
   ```
   Track  = { start: Vec3, gates: Gate[], obstacles: Obstacle[] }
   Gate   = { pos: Vec3, yaw: number, width: number, kind: 'gate' | 'hoop' | 'arch' | 'dive' }
   Obstacle = { pos: Vec3, kind: 'pylon' | 'pole' | 'flag' | 'tree', radius: number, height: number }
   ```
   Rules: minimum gate spacing at least 3x the turn radius; consecutive heading change under about 100 degrees;
   obstacles never inside a gate opening, and always on the racing line's side to be avoided.
3. **Route and altitude.** Waypoints become the gate centres, flown through `flightLine`. The
   terrain-following 40 m cruise and 15 m minimum clearance do not suit a track: make clearance a
   per-mode parameter (track: gates at 6-20 m, floor 5 m). Gate heights are explicit, which
   gives climbing and diving gates.
4. **Collision** (extends `crash.ts`, same `loseFlight` -> `crashed` flow):
   - Pylon/pole/tree: vertical cylinder against the 7 m footprint ring.
   - Gate: the frame's posts and top bar are boxes. Hit one and it is a crash. Passing through the
     opening is a clean pass.
   - Add `crashCause` (`terrain | water | craft | gate | obstacle`) so the HUD and stats can say what was hit.
5. **Scoring.** A gate pass is detected when the path segment between two ticks crosses the gate
   plane inside the opening. New `track` state on the snapshot: next gate index, gates passed and missed,
   lap, lap time, best lap. A missed gate (crossing the plane outside the opening, or skipping ahead) is
   counted but not a crash. A crash resets to the start after the existing 10 s wait.
6. **Pilots.** Phase 1 uses the autopilot with a skill parameter (lateral noise and look-ahead
   smoothing) so it sometimes clips things, which gives crash and miss statistics for free. Phase 3 puts
   several AI pilots on the course at once, which is the "race layout" from item 6. Manual
   keyboard flying does not exist today (WASD only moves the camera) and is out of scope; ask Miles.
7. **Rendering and HUD.** Gate model (frame with emissive trim, the next gate highlighted), striped
   pylons, a ghost line on the ground, lap and gate panel next to the existing cluster. Gate and
   obstacle meshes are instanced, built once per seed like the trees.

## Phases

| #   | Deliverable                                                                    | Verified by                                              |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 1   | `track.ts` generator, types, mode flag, arena search, unit tests               | determinism, spacing and heading rules over 200 seeds    |
| 2   | Gate and obstacle models; track drawn in the scene, with sortie mode unchanged | screenshot, no console errors                            |
| 3   | Autopilot flies the gates (per-mode clearance, speed) and lap timing           | headless sim: N laps complete, lap time stable           |
| 4   | Collision, gate pass/miss, `crashCause`, HUD readouts                          | tests with synthetic positions, as for the terrain fix   |
| 5   | Skill levels, then multiple pilots racing (ties to item 6)                     | statistics across seeds: crash rate rises as skill drops |

Each phase is its own commit with typecheck, lint and tests green.

## Risks

- **Footprint versus gate width.** A 24 m opening leaves about 8 m clear each side. Wind gusts
  and the EKF error (about 1.5 m) eat into that, so tune gate width against measured lateral error.
- **The autopilot's turn limit** (1.2 rad/s) caps how tight a course it can fly. The generator must use `TURN_RADIUS`.
- **Per-tick cost.** Every obstacle is tested every tick. Fine for under 50 obstacles; use a coarse grid if more.
- **Terrain flattening.** The arena must be flat enough for gates at 6 m; test it on the Mountain biome, where it may fail.

## Questions for Miles

1. Option A (scale the course up, recommended) or B (micro drone)?
2. Should this stay autopilot-only, or is manual FPV flying wanted? That is a large extra piece, with controls and a first-person camera.
3. Keep the sortie mode as it is, with track as a toggle (recommended), or replace it?
