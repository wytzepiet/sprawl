/** @jsxImportSource ~ui */
import { For, Show } from "solid-js";
import { town } from "../state/town";
import { useGame } from "../state/gameObjects";
import { BLUEPRINTS } from "../blueprints";
import { road } from "./Roads";
import { Pop, Press, wide } from "./kit";
import type { Offer } from "../generated";

/** A card's face: its colour, glyph, name and how many. */
const face = (o: Offer) =>
  o.type === "Roads"
    ? { color: road("Street").color, glyph: road("Street").glyph, label: "Roads", n: `+${o.data}` }
    : { color: BLUEPRINTS[o.data[0]].color, glyph: BLUEPRINTS[o.data[0]].glyph, label: BLUEPRINTS[o.data[0]].label, n: o.data[1] > 1 ? `×${o.data[1]}` : "" };

/**
 * The pick: every few people who move in, the town offers a few cards,
 * and the mayor takes one. The game runs on while it waits.
 */
export default function Pick() {
  const { send } = useGame();
  return (
    <Show when={town().offer.length}>
      <box at={{ left: 0, right: 0, bottom: wide() ? 120 : 112 }} align="center">
        <Pop>
          <glass layer="pick" round={26} pad={{ x: 12, top: 10, bottom: 12 }} gap={8} align="center">
            <text size={13} weight={600} soft>{`${town().people} people live here. Pick one`}</text>
            <box dir="row" gap={8}>
              <For each={town().offer}>
                {(o, i) => (
                  <Press w={96} pad={{ top: 12, bottom: 10 }} gap={6} round={18} fill="ink/0.05" align="center" onTap={() => send({ type: "Pick", data: i() })}>
                    <box w={48} h={48} round={14} fill={face(o).color} align="center" justify="center">
                      <icon d={face(o).glyph} size={26} ink="white" />
                    </box>
                    <text size={13} weight={600} lines={1}>{face(o).label}</text>
                    <text serif size={13} soft>{face(o).n}</text>
                  </Press>
                )}
              </For>
            </box>
          </glass>
        </Pop>
      </box>
    </Show>
  );
}
