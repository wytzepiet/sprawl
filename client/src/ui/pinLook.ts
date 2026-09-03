import type { BuildingKind } from "../generated";

/**
 * What kind of building this is, as colour. The buildings themselves are
 * deliberately neutral, so this is the only place a kind is coloured. Shared by
 * the pins and the growth meter, so an icon means the same thing in both — chosen
 * mid-dark so a white glyph reads on it, and spread far enough apart in hue to
 * be told apart at a dot's size.
 */
export const PIN_COLORS: Record<BuildingKind, string> = {
  House: "#3F9B5A",
  Apartment: "#2E7D6F",
  Shop: "#2F7FD4",
  Office: "#5B57C8",
  Workshop: "#C97A1E",
  Factory: "#6B6F78",
  Restaurant: "#D9483B",
};

