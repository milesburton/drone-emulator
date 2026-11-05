import type { Snapshot, Vec3 } from './types';

export type DroneStatus =
  'ready' | 'onCourse' | 'offCourse' | 'returning' | 'success' | 'failed' | 'lost';

/** Metres from the planned leg beyond which the drone counts as off course. */
export const OFF_COURSE_DISTANCE = 40;

export const STATUS_STYLE: Readonly<
  Record<DroneStatus, { label: string; icon: string; colour: number }>
> = {
  ready: { label: 'Ready', icon: '⏻', colour: 0xe8eaed },
  onCourse: { label: 'On course', icon: '➤', colour: 0x0a84ff },
  offCourse: { label: 'Off course', icon: '⚠', colour: 0xff9f0a },
  returning: { label: 'Returning home', icon: '↩', colour: 0xbf5af2 },
  success: { label: 'Success', icon: '✔', colour: 0x30d158 },
  failed: { label: 'Aborted, landed', icon: '✖', colour: 0xffd60a },
  lost: { label: 'Lost', icon: '⛔', colour: 0xff453a },
};

/** Horizontal distance from `p` to the segment `a`..`b`. */
export const crossTrack = (p: Vec3, a: Vec3, b: Vec3): number => {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const length2 = abx * abx + abz * abz;
  const t =
    length2 < 1e-9
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / length2));
  return Math.hypot(p[0] - (a[0] + abx * t), p[2] - (a[2] + abz * t));
};

/** What the drone is doing, for the colour of its body and the HUD badge. */
export const statusOf = (s: Snapshot): DroneStatus => {
  const { phase, outcome } = s.mission;
  switch (phase) {
    case 'lost':
      return 'lost';
    case 'returning':
      return 'returning';
    case 'grounded':
      return outcome === 'success'
        ? 'success'
        : outcome === 'failed'
          ? 'failed'
          : outcome === 'lost'
            ? 'lost'
            : 'ready';
    case 'takeoff':
      return 'onCourse';
    case 'landing':
      return s.mission.aborted ? 'returning' : 'onCourse';
    case 'cruise': {
      const n = s.waypoints.length;
      const from = s.waypoints[(s.drone.wp + n - 1) % n];
      const to = s.waypoints[s.drone.wp];
      return crossTrack(s.drone.pos, from, to) > OFF_COURSE_DISTANCE ? 'offCourse' : 'onCourse';
    }
  }
};
