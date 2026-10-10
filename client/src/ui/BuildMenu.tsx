import { createSignal, For, Show } from "solid-js";
import { BLUEPRINTS, BuildingIcon, GoodIcon, GOODS, KINDS, plot, TABS } from "../blueprints";
import { LETTERS } from "../engine/town/grid";
import { planSvg } from "../../scripts/planDraw";
import { held, hold, overCancel, setOverCancel } from "./buildMode";
import type { BuildingKind, Good } from "../generated";

/** The build menu, open or not. */
const [menuOpen, setMenuOpen] = createSignal(false);
export { menuOpen, setMenuOpen };

/** What the card says of a kind beyond its size. */
const ABOUT: Partial<Record<BuildingKind, string>> = {
  Harbour: "The door: the ferry berths at its back, so it stands on the coast with open sea straight out behind it. Comes with its street, and stands at once.",
  Depot: "Keeps the town's goods. Its lorry fetches boxes from the harbour; its vans take materials to sites. The first stands at once.",
  Quarry: "Breaks stone out of the mountain beside it: build it at the mountain's foot.",
  Sawmill: "Fells and saws the woods round it: build it in the forest.",
  Farm: "Grows crates on the open grass round it, which its tractor ploughs.",
};

/** Each kind as the town grid draws it, its plot on a street, the sea
 *  behind a harbour: a picture made once, from the same code as the map
 *  (`scripts/planDraw.ts`). A kind with no letter in a fixture, its glyph. */
const pictures = new Map<BuildingKind, string | null>();
function picture(kind: BuildingKind): string | null {
  if (pictures.has(kind)) return pictures.get(kind)!;
  const letter = Object.entries(LETTERS).find(([, k]) => k === kind)?.[0];
  let svg: string | null = null;
  if (letter) {
    // A square at most five tiles across: the plot, its yard to the
    // street along the bottom, which runs on past the picture's edges,
    // grass round it; a harbour's sea behind. Five tiles in from the
    // fixture's corner, so no fifth tile's number is written on it.
    const [w, d] = plot(kind, 2).size;
    const side = Math.min(5, Math.max(w + 2, d + 1, 3));
    const left = 5 + Math.floor((side - w) / 2);
    const row = (mid: string) => ".".repeat(left) + mid + ".".repeat(16 - left - mid.length);
    const behind = (BLUEPRINTS[kind].quay ? "≈" : ".").repeat(16);
    const rows = [...Array.from({ length: side - 1 - d }, () => behind), ...Array.from({ length: d }, () => row(letter.repeat(w))), "=".repeat(16), ".".repeat(16)];
    svg = planSvg(rows.join("\n"), { px: 18, crop: [5, 0, 5 + side, side] }).replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"');
  }
  pictures.set(kind, svg);
  return svg;
}

const materials = (kind: BuildingKind) => Object.entries(BLUEPRINTS[kind].materials) as [Good, number][];

/**
 * The build menu: every kind of building, a picture of it as it stands,
 * its name and what it is built of. Press on one and drag it onto the
 * map: the menu goes, and where it was a place to let it go and put it
 * back. A tap takes it up to place with a click.
 */
export function BuildMenu() {
  const kinds = () => TABS.flatMap((t) => KINDS.filter((k) => BLUEPRINTS[k].tab === t));
  const press = (kind: BuildingKind, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const from = [e.clientX, e.clientY];
    el.setPointerCapture(e.pointerId);
    const take = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", take);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      hold(kind);
      setMenuOpen(false);
    };
    // Dragged out: the map has the pointer from here.
    const move = (m: PointerEvent) => Math.hypot(m.clientX - from[0], m.clientY - from[1]) > 6 && take();
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", take);
  };
  return (
    <>
      <Show when={menuOpen()}>
        <div data-menu data-glass="dock" class="appear fixed bottom-[104px] left-1/2 z-40 -translate-x-1/2 rounded-[26px] p-3 select-none" style={{ width: "min(720px, calc(100vw - 32px))" }}>
          <div class="grid gap-1.5" style={{ "grid-template-columns": "repeat(auto-fill, minmax(104px, 1fr))" }}>
            <For each={kinds()}>
              {(kind) => (
                <button
                  class="press flex flex-col items-center gap-1 rounded-[18px] p-1.5 pb-2 cursor-grab active:cursor-grabbing touch-none"
                  style={{ background: "rgb(var(--ink) / 0.04)" }}
                  title={[`${plot(kind, 0).size.join("×")} tiles.`, ABOUT[kind]].filter(Boolean).join(" ")}
                  onPointerDown={(e) => press(kind, e)}
                >
                  <span class="block h-[76px] w-[76px] overflow-hidden rounded-[12px]" style={{ background: BLUEPRINTS[kind].color }}>
                    {picture(kind) ? <span class="block h-full w-full" innerHTML={picture(kind)!} /> : <BuildingIcon kind={kind} class="m-auto mt-[18px] text-white" width="40" height="40" />}
                  </span>
                  <span class="ink text-[13px] font-semibold leading-tight">{BLUEPRINTS[kind].label}</span>
                  <span class="soft inline-flex items-center gap-1.5 text-[12px] serif italic">
                    <Show when={materials(kind).length} fallback="at once">
                      <For each={materials(kind)}>{([g, n]) => <span class="inline-flex items-center gap-0.5" title={`${n} ${GOODS[g].label}`}><GoodIcon good={g} width="12" height="12" />{n}</span>}</For>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      {/* Where the menu was, while a building is in hand: let go here to
          put it back. */}
      <Show when={held()}>
        <div
          data-glass="dock"
          class="appear fixed bottom-[104px] left-1/2 z-40 grid h-[84px] -translate-x-1/2 place-items-center rounded-[26px] border-2 border-dashed text-[13px] font-semibold uppercase tracking-wide select-none"
          style={{ width: "min(420px, calc(100vw - 32px))", "border-color": overCancel() ? "#D9483B" : "rgb(var(--ink) / 0.2)", color: overCancel() ? "#D9483B" : undefined }}
          classList={{ soft: !overCancel() }}
          onPointerEnter={() => setOverCancel(true)}
          onPointerLeave={() => setOverCancel(false)}
          onPointerUp={() => (setOverCancel(false), hold(null))}
        >
          Drop here to put it back · Esc
        </div>
      </Show>
    </>
  );
}
