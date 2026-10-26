import { hex } from "./rgb";

/** The colours of the land and the town. */
export const theme = {
  // After a Scottish coast from the air, made light: sage pasture, a
  // slate-teal sea, pale taupe sand, off-white roads, and the trees the one
  // dark note on the ground, so the buildings carry the colour.
  land: hex("#74A060"),
  water: hex("#76AAB2"),
  beach: hex("#E2DCCF"),
  // The floor between the crowns: the wood's shade, of the crowns' teal
  // greens, darker than them as the ground under a canopy is, so a forest
  // reads as one even zoomed out past its trees.
  forest: hex("#4A6461"),
  // Tree crowns, dark to light: deep teal-greens, the dark note, light
  // enough that a forest reads as a wood and not a hole.
  crowns: [hex("#325E57"), hex("#3F705E"), hex("#52846A")],
  // Conifers, dark to light: darker and bluer than the broadleaves, as a
  // stand of spruce is beside an oak wood.
  conifers: [hex("#2A554B"), hex("#325F53"), hex("#3D6B5C")],
  // A field through its season: ploughed earth beside the beach, the
  // growing crop beside the grass, the ripe crop beside the highway's
  // yellow, the stubble between.
  earth: hex("#EBD3A8"),
  growing: hex("#B5D594"),
  ripe: hex("#F2D680"),
  stubble: hex("#ECE3C4"),
  // A mountain: its snow, its bare rock; the cliffs the land stands on.
  mountain: hex("#F4F3F0"),
  rock: hex("#A89C8A"),
  // A yard, a car park or a pavement: a worn, warm stone grey, light
  // beside the asphalt.
  paved: hex("#ADA596"),
  // Asphalt: a dark, matte grey.
  road: hex("#585C61"),
  // A road, as against a street: the map's yellow for a through route,
  // muted.
  highway: hex("#D6B55E"),
};

export type Theme = typeof theme;

/** As `scripts/planDraw.ts` reads it: `bun run plan --at` carries that
 *  to commits from before the palette was one constant. */
export const themes = { light: theme };
