/** Body colours, one per rival, none of which is a status colour of the main drone. */
export const RIVAL_COLOURS: readonly number[] = [
  0xff6fae, 0x2dd4bf, 0xfacc15, 0xa3e635, 0x22d3ee, 0xa78bfa, 0xf1f5f9, 0xfb7185,
];

export const colourOf = (id: number): number => RIVAL_COLOURS[(id - 1) % RIVAL_COLOURS.length];
