import { Box, Text, Icon } from "~ui";
import { createEffect, createRoot, createSignal, For } from "solid-js";
import { priority, setPriority, setTool, tool } from "./buildMode";
import { BAD, Info, Press } from "./kit";

/** The road tools, the roads tab: a road is a street with priority. */
export const ROAD_KINDS = [
  { id: "Street", label: "Street", about: "Two ways, a lane each. Laid at once, on a stone a tile from the nearest depot; with none in stock, the world sends it express, at twice the ferry's price.", color: "#8FA39A", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM10.75 2h2.5v4.5h-2.5zM10.75 9.75h2.5v4.5h-2.5zM10.75 17.5h2.5V22h-2.5z" },
  { id: "OneWay", label: "One-way", about: "One lane, the way you drag it. A stone a tile.", color: "#7A8F86", glyph: "M3 2h2.5v20H3zM18.5 2H21v20h-2.5zM12 3l5.5 6.5h-4V21h-3V9.5h-4z" },
  { id: "Road", label: "Road", about: "A street with priority: whoever joins or crosses it gives way. A stone a tile.", color: "#E0B443", glyph: "M2 2h2v20H2zM20 2h2v20h-2zM7.5 2h2.2v4.5H7.5zM7.5 9.75h2.2v4.5H7.5zM7.5 17.5h2.2V22H7.5zM14.3 2h2.2v4.5h-2.2zM14.3 9.75h2.2v4.5h-2.2zM14.3 17.5h2.2V22h-2.2z" },
  {
    id: "Demolish",
    label: "Demolish",
    about: "Tap a road to take it up, drag along one to cut it. To take a building down, press and hold it.",
    color: BAD,
    glyph: "M3.5 16.5h11a2.25 2.25 0 0 1 0 4.5h-11a2.25 2.25 0 0 1 0-4.5zM5 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM9 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM13 17.75a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM4 12h11v3.5H4zM5.5 6.5h5l1.2 4.5H5.5zM6.7 7.7h3l.6 2.3H6.7zM15.5 13h2.5v1.5h-2.5zM18.5 10l3-1v12.5h-3z",
  },
] as const;
export type RoadKind = (typeof ROAD_KINDS)[number]["id"];
export const road = (k: RoadKind) => ROAD_KINDS.find((r) => r.id === k)!;
export const DEMOLISH = road("Demolish").glyph;

/** What is in hand of the road tools, if any. */
export const inHand = (): RoadKind | null => {
  const t = tool();
  return t === "Street" && priority() ? "Road" : t === "Street" || t === "OneWay" || t === "Demolish" ? t : null;
};
export const take = (k: RoadKind) => (setPriority(k === "Road"), setTool(k === "Road" ? "Street" : k));

/** The tool last taken: R's again. */
export const lastRoad = createRoot(() => {
  const [last, setLast] = createSignal<RoadKind>("Street");
  createEffect(() => {
    const k = inHand();
    if (k) setLast(k);
  });
  return last;
});

/** The roads tab, all head: the road tools in a row, the one in hand
 *  in its colour, each with an i for its page. */
export function RoadsHead(props: { info: (k: RoadKind) => void }) {
  return (
    <Box dir="row" gap={6} pad={{ x: 12, top: 14, bottom: 12 }}>
      <For each={[...ROAD_KINDS]}>
        {(r) => {
          const on = () => inHand() === r.id;
          return (
            <Press grow={1} h={60} round={16} gap={4} align="center" justify="center" fill={on() ? r.color : "ink/0.05"} onTap={() => (on() ? setTool(null) : take(r.id))}>
              <Icon d={r.glyph} size={20} ink={on() ? "white" : r.id === "Demolish" ? r.color : "ink/0.72"} />
              <Box dir="row" align="center" gap={4}>
                <Text size={12.5} weight={600} ink={on() ? "white" : "ink/0.72"}>{r.label}</Text>
                <Info onTap={() => props.info(r.id)} />
              </Box>
            </Press>
          );
        }}
      </For>
    </Box>
  );
}
