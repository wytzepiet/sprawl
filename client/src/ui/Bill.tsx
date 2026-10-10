import { For, onCleanup, Show } from "solid-js";
import { useGame } from "../state/gameObjects";
import { done, mine, myMarks } from "../state/drafts";
import { clockAt, landsAt, plural, sea } from "../state/sea";
import { tool } from "./buildMode";
import { BLUEPRINTS, GOODS, GoodIcon } from "../blueprints";
import { coins } from "./kit";
import type { BuildingKind, Line } from "../generated";

/**
 * The draft's bill, over the toolbar, from the moment anything is drafted
 * (docs/game.md §Drafts): what is drawn, each material it takes against
 * what the town has, short in red with the order for it one tap away, and
 * Build, which commits the lot. Enter builds, Ctrl or Cmd Z takes back the
 * last stroke, Esc with nothing in hand drops the draft.
 */
export default function Bill(props: { hidden: boolean }) {
  const { send } = useGame();
  const commit = () => {
    done("commit");
    send({ type: "Commit" });
  };
  const undo = () => {
    done("other");
    send({ type: "Undo" });
  };
  const discard = () => {
    done("other");
    send({ type: "Discard" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (!mine() || (e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
    if (e.key === "Enter") commit();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") undo();
    // Esc first puts down what is in hand (the toolbar's), and only then
    // drops the draft.
    else if (e.key === "Escape" && tool() === null) discard();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey, { capture: true });
  onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }));

  /** What is drawn, in words: "3 houses, a depot, 12 road, 1 to come down". */
  const what = () => {
    const marks = myMarks().filter((m) => !m.stuck);
    const tiles = new Map<string, Set<string>>();
    let down = 0;
    for (const { step } of marks) {
      const { tool, from, to } = step;
      if (tool === "Demolish") down++;
      else if (typeof tool !== "string") (tiles.get(tool.Building) ?? tiles.set(tool.Building, new Set()).get(tool.Building)!).add(`${to.x},${to.y}`);
      else for (const t of [from, to]) (tiles.get("road") ?? tiles.set("road", new Set()).get("road")!).add(`${t.x},${t.y}`);
    }
    const words = [...tiles].map(([k, ts]) => {
      if (k === "road") return `${ts.size} road`;
      const { label, size } = BLUEPRINTS[k as BuildingKind];
      return size[0] * size[1] === 1 ? plural(ts.size, label.toLowerCase(), `${label.toLowerCase()}s`) : `a ${label.toLowerCase()}`;
    });
    if (down) words.push(`${down} to come down`);
    return words.join(", ") || "Nothing that fits";
  };
  const stuck = () => myMarks().filter((m) => m.stuck).length;
  const short = (l: Line) => Math.max(0, Math.ceil(l.takes - l.have));
  const order = () => mine()?.bill.filter((l) => l.boxes > 0) ?? [];
  const sailing = () => sea.sailings[0];
  const buy = () => {
    const depot = mine()?.depot;
    if (depot === null || depot === undefined) return;
    for (const l of order()) send({ type: "Order", data: { depot, good: l.good, boxes: l.boxes } });
  };

  return (
    <Show when={mine()}>
      <div
        class="appear absolute left-1/2 bottom-[72px] flex h-[56px] -translate-x-1/2 items-center gap-1.5 pl-2 pr-1.5 transition-opacity duration-200"
        classList={{ "opacity-0 pointer-events-none": props.hidden }}
      >
        <div data-glass={props.hidden ? undefined : "bill"} class="pointer-events-none absolute inset-0 rounded-[28px]" />
        <button class="press soft relative grid h-9 w-9 place-items-center rounded-full cursor-pointer text-lg" title="Drop the draft (Esc)" onClick={discard} aria-label="Discard">
          ×
        </button>
        <button class="press soft relative grid h-9 w-9 place-items-center rounded-full cursor-pointer" title="Take back the last stroke (Ctrl Z)" onClick={undo} aria-label="Undo">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></svg>
        </button>
        <div class="ink relative min-w-0 px-1.5 leading-tight whitespace-nowrap">
          <div class="text-[13.5px] font-semibold">{what()}</div>
          <div class="mt-0.5 flex items-center gap-2 text-[12px]">
            <For each={mine()?.bill ?? []} fallback={<span class="soft">costs nothing</span>}>
              {(l) => (
                <span class="inline-flex items-center gap-1" title={`${Math.floor(l.have)} in the depots or on the way`}>
                  <GoodIcon good={l.good} width="12" height="12" style={{ color: GOODS[l.good].color }} />
                  <span class="tabular-nums">{l.takes}</span>
                  <span class="soft">{GOODS[l.good].label.toLowerCase()}</span>
                  <Show when={short(l) > 0} fallback={<span class="soft">· in stock</span>}>
                    <span class="font-semibold" style={{ color: "#D9483B" }}>· {short(l)} short</span>
                  </Show>
                </span>
              )}
            </For>
            <Show when={stuck() > 0}>
              <span class="font-semibold" style={{ color: "#C77A12" }}>{plural(stuck(), "step no longer fits", "steps no longer fit")}</span>
            </Show>
          </div>
        </div>
        <Show when={order().length > 0 && mine()?.depot !== null && sailing()}>
          <button
            class="press relative inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold cursor-pointer whitespace-nowrap"
            style={{ border: `1.5px solid ${GOODS[order()[0].good].color}`, color: GOODS[order()[0].good].color }}
            title={`On the next ferry: lands ${clockAt(landsAt(sailing()!))}`}
            onClick={buy}
          >
            Order {plural(order().reduce((n, l) => n + l.boxes, 0), "box", "boxes")}
            <span class="soft font-normal tabular-nums">{coins(-order().reduce((c, l) => c + l.coins, 0))}</span>
          </button>
        </Show>
        <button
          class="press relative inline-flex h-11 items-center gap-2 rounded-full px-5 text-[15px] font-semibold text-white cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
          style={{ "background-color": "#2F7BF0" }}
          title="Build it all (Enter)"
          onClick={commit}
        >
          Build
          <span class="text-[11px] font-normal opacity-75">⏎</span>
        </button>
      </div>
    </Show>
  );
}
