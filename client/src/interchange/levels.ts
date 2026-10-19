/**
 * The levels, read from their text (`server/levels/*.txt`, `level.rs`):
 * what the client needs to list them, place them on the map and draw
 * their thumbnails, without running them.
 */
export interface LevelText {
  name: string;
  title: string;
  notes: string[];
  text: string;
  /** Where it lies on the map of levels, column and row. */
  at: [number, number];
  /** Its map, a row of characters each, top row first. */
  rows: string[];
}

export const LEVELS: LevelText[] = Object.entries(
  import.meta.glob<string>("../../../server/levels/*.txt", { query: "?raw", import: "default", eager: true }),
)
  .map(([path, text]) => {
    const lines = text.split("\n");
    const notes = lines.filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s*/, ""));
    const at = lines.find((l) => l.startsWith("@at "))?.split(/\s+/).slice(1, 3).map(Number) ?? [0, 0];
    const rows = lines.filter((l) => l.trim() && !/^[#@%]/.test(l)).map((l) => l.replace(/\s/g, ""));
    return { name: path.split("/").pop()!.replace(/\.txt$/, ""), title: notes[0] ?? "", notes: notes.slice(1), text, at: [at[0], at[1]] as [number, number], rows };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/** The levels beside one on the map: a step along a row or a column. */
export const neighbours = (l: LevelText) => LEVELS.filter((o) => Math.abs(o.at[0] - l.at[0]) + Math.abs(o.at[1] - l.at[1]) === 1);
