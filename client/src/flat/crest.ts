import type { Neighbour } from "../generated";

/**
 * A town beyond the edge, drawn: its crest, the town's initials on a disc
 * of its colour, rimmed in glass white. The one place a mayor is drawn,
 * on a card, a pin at the map's edge or a box marked for them; a portrait
 * would replace it here (docs/shelved.md §Faces). Upright, in
 * whatever pixels `g` is set to: the minimap's, a script's, a card's.
 */
export function crest(g: CanvasRenderingContext2D, n: Pick<Neighbour, "town" | "colour">, x: number, y: number, r: number) {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, 2 * Math.PI);
  g.fillStyle = n.colour;
  g.fill();
  g.lineWidth = Math.max(1, r / 6);
  g.strokeStyle = "rgba(255,255,255,0.92)";
  g.stroke();
  const initials = n.town.split(" ").map((w) => w[0]).join("");
  g.font = `bold ${Math.round(r * (initials.length > 1 ? 0.85 : 1.1))}px serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#fff";
  g.fillText(initials, x, y + r * 0.06);
  g.restore();
}
