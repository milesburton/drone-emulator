# TODO (Miles, 2026-11-05)

1. Landing pad should not be directly below the start flag. Move the flag (not the waypoint) or the pad. The craft should visibly land and take off from the pad.
2. ~~Flight path not long enough~~: route budget raised to 70% charge (was 65%); sorties land ~10-16%. Aborted returns still land slightly above 10% (return estimate is conservative).
3. Hitting a mountain, another craft, or water = crashed. DONE for mountain + water (own "crashed" metric, 10 s wait, reset to pad); other-craft collision waits on item 6 (no other craft yet).
4. Add a crash animation.
5. Planes flying across and above the clouds, periodically leaving a random chemtrail.
6. PARTIAL (2026-11-05: 6 craft - quad, octo, RC plane - on circuits, collision = crash; no race layout yet). Multiple drones and RC planes around the area; different drone types (octocopters). Keep simple. Race layout later.
7. PLAN WRITTEN (FPV-TRACK-PLAN.md, awaiting Miles on scale/manual flying/mode). Plan (not build) a much smaller training/sports FPV track with obstacles to pass through or avoid.

## Miles, 2026-11-06

8. Wind lines should be a single continuous line throughout the map, with smooth curves like a flowing wave. The idea is to show how the terrain affects local weather conditions (as Flight Simulator does). NOT STARTED: queued behind the micro-drone rescale.
9. Splash when the drone crashes into water. DONE (crashFx.ts: jet, ring, droplets), not browser-checked.
10. Micro drone (about 3 m, real FPV scale) in FPV track and Forest run; obstacles shrunk to match. DONE (tests and sweeps; not browser-checked).
11. Tunnels the pilot must fly through (Forest run). DONE (out and back through each; not browser-checked).
