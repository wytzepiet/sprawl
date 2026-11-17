import { hex } from "./rgb";

/** The colours of the land and the town. */
export const theme = {
  // A toy town on a bright day, as a painted map has it: fresh spring
  // grass, a clear turquoise sea, warm sand, and the trees the one dark,
  // still green note on the ground, so the buildings carry the colour.
  land: hex("#A6D65E"),
  water: hex("#5EC2C6"),
  beach: hex("#EDDAAA"),
  // The floor between the crowns: the wood's shade, the grass darker and
  // bending toward the crowns' teal, so a forest reads as one zoomed out
  // past its trees without standing stark against the open land.
  forest: hex("#5E9550"),
  // Clay showing through the turf: a soft ochre, warm against the sage,
  // where a clay pit can dig (`Deposit::Clay`).
  clay: hex("#DCC08E"),
  // Tree crowns, dark to light: deep leaf greens, the dark note, light
  // enough that a forest reads as a wood and not a hole.
  crowns: [hex("#2E6A45"), hex("#3B7E4B"), hex("#4E9353")],
  // Conifers, dark to light: darker and bluer than the broadleaves, as a
  // stand of spruce is beside an oak wood.
  conifers: [hex("#265C4A"), hex("#2D6852"), hex("#38755C")],
  // A field through its season: ploughed earth beside the beach, the
  // growing crop beside the grass, the ripe crop beside the highway's
  // yellow, the stubble between.
  earth: hex("#EBD3A8"),
  growing: hex("#B6DA74"),
  ripe: hex("#F2D680"),
  stubble: hex("#ECE3C4"),
  // A mountain: its snow, its bare rock; the cliffs the land stands on.
  mountain: hex("#F4F3F0"),
  rock: hex("#A6A39A"),
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
