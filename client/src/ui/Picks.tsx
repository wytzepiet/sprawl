import { Box, Ink, Icon, Text } from "~ui";
import { For, Show } from "solid-js";
import { eachEntity, useGame } from "../state/gameObjects";
import { town } from "../state/town";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { ROAD_KINDS } from "./Roads";
import { Pop, Press, view, ROUND } from "./kit";
import type { Building, Good, Offer, Unlock } from "../generated";

/** The road tool each unlock opens, for its card's look. */
const TOOL: Record<Unlock, { id: string; label: string; about: string }> = {
  Priority: { id: "Road", label: "Main roads", about: "Streets that meet one give way" },
  Lights: { id: "Light", label: "Traffic lights", about: "Junctions take turns" },
  OneWay: { id: "OneWay", label: "One-way streets", about: "One lane, the way you drag it" },
  Wide: { id: "Wide", label: "Two lanes", about: "One way, two lanes side by side" },
  Overpass: { id: "Street", label: "Bridges", about: "Roads over roads and water" },
};
const road = (id: string) => ROAD_KINDS.find((r) => r.id === id) ?? ROAD_KINDS[0];

/** The houses waiting on a good now, or growing with it. */
function waiting(good: Good): number {
  let n = 0;
  eachEntity((e) => {
    const h = e.object.kind === "Building" ? (e.object.data as Building).home : null;
    if (h && (h.wants.some((w) => w.good === good) || (h.growing?.[good] && h.growing[good]!.level < h.growing[good]!.cap))) n++;
  });
  return n;
}

/** What a card answers in the town as it stands, if anything: the
 *  houses it would feed. */
function need(o: Offer): string | null {
  if (o.kind === "Building") {
    const makes = BLUEPRINTS[o.data[0]].makes;
    const n = makes ? waiting(makes) : 0;
    return n ? `${n} ${n === 1 ? "house wants" : "houses want"} ${GOODS[makes!].label.toLowerCase()}` : null;
  }
  if (o.kind === "Roads") return town().roads < 10 ? `${town().roads} left` : null;
  return null;
}

/** A card's look: its colour, glyph, name and what it does. */
function look(o: Offer): { color: string; glyph: string; label: string; about: string } {
  switch (o.kind) {
    case "Building": {
      const [kind, n] = o.data;
      const b = BLUEPRINTS[kind];
      return { color: b.color, glyph: b.glyph, label: n > 1 ? `${n} × ${b.label}` : b.label, about: b.about.split(". ")[0] };
    }
    case "Roads":
      return { color: road("Street").color, glyph: road("Street").glyph, label: `${o.data} road`, about: "Tiles of street to lay" };
    case "Tool": {
      const t = TOOL[o.data];
      return { color: road(t.id).color, glyph: road(t.id).glyph, label: t.label, about: t.about };
    }
  }
}

/**
 * The pick: when enough people have moved in, the town offers two or three
 * things to build with, and the game waits while the mayor chooses one,
 * as a card game deals a hand. The card the town most needs is always
 * among them.
 */
export default function Picks() {
  const { send } = useGame();
  const narrow = () => view().w < 560;
  return (
    <Show when={town().offer.length > 0}>
      <Box at={{ left: 0, right: 0, top: 0, bottom: 0 }} fill="#00000033" align="center" justify="end" pad={{ bottom: 96 }}>
        <Pop>
          <Ink layer="pick" round={ROUND} pad={{ x: 18, top: 18, bottom: 18 }} gap={14} w={narrow() ? view().w - 32 : undefined}>
            <Box gap={3}>
              <Text size={19} weight={700}>The town is growing</Text>
              <Text size={13.5} soft>{town().people} people. Pick one to build with.</Text>
            </Box>
            <Box dir={narrow() ? "col" : "row"} gap={10}>
              <For each={town().offer}>
                {(o, i) => {
                  const l = look(o);
                  return (
                    <Press w={narrow() ? undefined : 168} round={22} pad={14} gap={10} fill="ink/0.07" onTap={() => send({ type: "Pick", data: i() })} dir={narrow() ? "row" : "col"} align={narrow() ? "center" : "start"}>
                      <Box w={56} h={56} round={16} fill={l.color} align="center" justify="center">
                        <Icon d={l.glyph} size={30} ink="white" />
                      </Box>
                      <Box gap={3} grow={narrow() ? 1 : undefined}>
                        <Text size={15} weight={700}>{l.label}</Text>
                        <Text size={12.5} soft lead={1.35}>{l.about}</Text>
                        <Show when={need(o)}>{(w) => <Text size={12.5} weight={600} ink="#FF453A">{w()}</Text>}</Show>
                      </Box>
                    </Press>
                  );
                }}
              </For>
            </Box>
          </Ink>
        </Pop>
      </Box>
    </Show>
  );
}
