/** @jsxImportSource ~ui */
import { createSignal, For, Index, Show } from "solid-js";
import { BLUEPRINTS, GOODS, KINDS, plot, TABS } from "../blueprints";
import { LETTERS } from "../engine/town/grid";
import { planSvg } from "../../scripts/planDraw";
import { held, hold } from "./buildMode";
import { selected } from "../state/selection";
import { Appear, view, wide } from "./kit";
import type { BuildingKind, Good } from "../generated";

/** The build menu, open or not. */
const [menuOpen, setMenuOpen] = createSignal(false);
export { menuOpen, setMenuOpen };

/** A picture's side, a cell's least width and the room between cells. */
const PIC = 76;
const CELL = 96;
const GAP = 6;

/** A shape of a picture: its outline, its colour, and its line's width if it is drawn as a line. */
interface Shape {
  d: string;
  ink: string;
  stroke?: number;
}

/** An SVG of the plan's (`scripts/planDraw.ts`) as the shapes the GPU
 *  draws: each rect, circle, line and path one, its transform worked in. */
function shapesOf(svg: string): Shape[] {
  const out: Shape[] = [];
  for (const [, tag, body] of svg.matchAll(/<(rect|circle|line|path)\b([^>]*)\/?>/g)) {
    const a = (k: string) => body.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
    const n = (k: string) => Number(a(k) ?? 0);
    const share = a("fill-opacity") ?? a("opacity");
    const ink = (c: string | undefined) => c && c !== "none" && `${c}${share ? `/${share}` : ""}`;
    // translate(x y) rotate(deg), all the plan uses.
    const [tx, ty] = (a("transform")?.match(/translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/)?.slice(1).map(Number) ?? [0, 0]) as number[];
    const turn = ((Number(a("transform")?.match(/rotate\(([-\d.e]+)\)/)?.[1] ?? 0)) * Math.PI) / 180;
    const p = (x: number, y: number) => `${(tx + x * Math.cos(turn) - y * Math.sin(turn)).toFixed(3)} ${(ty + x * Math.sin(turn) + y * Math.cos(turn)).toFixed(3)}`;
    let d = "";
    if (tag === "rect") {
      const [x, y, w, h] = [n("x"), n("y"), n("width"), n("height")];
      d = `M${p(x, y)}L${p(x + w, y)}L${p(x + w, y + h)}L${p(x, y + h)}Z`;
    } else if (tag === "circle") {
      const [x, y, r] = [n("cx"), n("cy"), n("r")];
      d = `M${p(x - r, y)}A${r} ${r} 0 1 0 ${p(x + r, y)}A${r} ${r} 0 1 0 ${p(x - r, y)}Z`;
    } else if (tag === "line") d = `M${p(n("x1"), n("y1"))}L${p(n("x2"), n("y2"))}`;
    else if (!tx && !turn) d = a("d") ?? "";
    if (!d) continue;
    const fill = ink(a("fill") ?? (tag === "line" ? "none" : "#000"));
    const line = ink(a("stroke"));
    if (fill) out.push({ d, ink: fill });
    if (line) out.push({ d, ink: line, stroke: n("stroke-width") || 1 });
  }
  return out;
}

/** Each kind as the town grid draws it, its plot on a street, the sea
 *  behind a harbour: a picture made once, from the same code as the map
 *  (`scripts/planDraw.ts`), in shapes, with the corner of the map it
 *  shows. A kind with no letter in a fixture, none. */
const pictures = new Map<BuildingKind, { shapes: Shape[]; x: number; y: number; side: number } | null>();
function picture(kind: BuildingKind) {
  if (pictures.has(kind)) return pictures.get(kind)!;
  const letter = Object.entries(LETTERS).find(([, k]) => k === kind)?.[0];
  let pic = null;
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
    pic = { shapes: shapesOf(planSvg(rows.join("\n"), { px: 18, crop: [5, 0, 5 + side, side] })), x: 5, y: 0, side };
  }
  pictures.set(kind, pic);
  return pic;
}

const materials = (kind: BuildingKind) => Object.entries(BLUEPRINTS[kind].materials) as [Good, number][];

/** Where the menu lies: over the dock, right of a card while one is
 *  open on a wide screen, as wide as it may be up to its most. */
const band = () => {
  const left = selected() !== null && wide() ? 360 : 16;
  const w = Math.min(720, view().w - left - 16);
  return { left: left + (view().w - left - 16 - w) / 2, w, bottom: wide() ? 104 : 150 };
};

/**
 * The build menu: every kind of building, a picture of it as it stands,
 * its name and what it is built of. Press on one and drag it onto the
 * map: the menu goes, and where it was a place to let it go and put it
 * back. A tap takes it up to place with a click.
 */
export default function BuildMenu() {
  const kinds = TABS.flatMap((t) => KINDS.filter((k) => BLUEPRINTS[k].tab === t));
  const take = (kind: BuildingKind) => (hold(kind), setMenuOpen(false));
  const across = () => Math.max(1, Math.floor((band().w - 24 + GAP) / (CELL + GAP)));
  const cell = () => Math.floor((band().w - 24 - GAP * (across() - 1)) / across());
  const [tall, setTall] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const room = () => Math.max(120, view().h - 200);
  const roll = (by: number) => setScroll(Math.max(0, Math.min(tall() - room(), scroll() + by)));
  const [over, setOver] = createSignal(false);
  return (
    <>
      <Show when={menuOpen()}>
        <glass layer="menu" at={{ left: band().left, bottom: band().bottom }} w={band().w} h={Math.min(tall(), room())} round={26} clip onScroll={roll}>
          <Appear>
            <box y={-scroll()} pad={12} dir="row" wrap gap={GAP} onSize={(_, h) => setTall(h)}>
            <For each={kinds}>
              {(kind) => (
                <box w={cell()} pad={{ x: 6, top: 6, bottom: 8 }} gap={4} align="center" round={18} fill="ink/0.04" onTap={() => take(kind)} onDrag={() => take(kind)}>
                  <Picture kind={kind} />
                  <text size={13} weight={600} lines={1}>{BLUEPRINTS[kind].label}</text>
                  <box dir="row" align="center" gap={6}>
                    <Show when={materials(kind).length} fallback={<text serif size={12} soft>at once</text>}>
                      <For each={materials(kind)}>
                        {([g, n]) => (
                          <box dir="row" align="center" gap={2}>
                            <icon d={GOODS[g].glyph} size={12} ink="ink/0.6" />
                            <text serif size={12} soft>{n}</text>
                          </box>
                        )}
                      </For>
                    </Show>
                  </box>
                </box>
              )}
            </For>
            </box>
          </Appear>
        </glass>
      </Show>
      {/* Where the menu was, while a building is in hand: let go here to
          put it back. */}
      <Show when={held()}>
        <glass
          layer="menu"
          at={{ left: band().left + Math.max(0, (band().w - 420) / 2), bottom: band().bottom }}
          w={Math.min(420, band().w)}
          h={84}
          round={26}
          align="center"
          justify="center"
          onHover={setOver}
          onDrop={() => (setOver(false), hold(null))}
          onTap={() => hold(null)}
        >
          <box at={{ left: 6, top: 6 }} w={Math.min(420, band().w) - 12} h={72} round={20} stroke={[2, over() ? "#D9483B" : "ink/0.2"]} />
          <text size={13} weight={600} ink={over() ? "#D9483B" : "ink/0.6"}>Drop here to put it back · Esc</text>
        </glass>
      </Show>
    </>
  );
}

/** A kind's picture, cut to its rounded square; with none, its glyph on its colour. */
function Picture(props: { kind: BuildingKind }) {
  const pic = picture(props.kind);
  const unit = pic ? PIC / pic.side : 0;
  const reach = pic ? Math.max(pic.x, pic.y) + pic.side : 0;
  return (
    <box w={PIC} h={PIC} round={12} clip fill={BLUEPRINTS[props.kind].color} align="center" justify="center">
      <Show when={pic} fallback={<icon d={BLUEPRINTS[props.kind].glyph} size={40} ink="white" />}>
        {(p) => (
          <Index each={p().shapes}>
            {(s) => <icon at={{ left: -p().x * unit, top: -p().y * unit }} d={s().d} view={reach} size={reach * unit} stroke={s().stroke} ink={s().ink} />}
          </Index>
        )}
      </Show>
    </box>
  );
}
