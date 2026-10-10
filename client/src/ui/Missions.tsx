import { createEffect, createSignal, Index, Show } from "solid-js";
import { eachEntity, groundOf, useGame } from "../state/gameObjects";
import { eye } from "../engine/OrthoCamera";
import { CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, TYPE_BY_BYTE } from "../engine/objects/terrainGeometry";
import { clockAt, sea, until } from "../state/sea";
import { missions } from "../state/missions";
import { setTool } from "./buildMode";
import { select, selected } from "../state/selection";
import { track } from "./Shipments";
import { Btn } from "./kit";
import { myMarks } from "../state/drafts";
import { BLUEPRINTS, GOODS } from "../blueprints";
import type { BuildingKind, Key, Mission, Step, TerrainType } from "../generated";

/** Folded to its pill: the card above it keeps clear of it while it is not. */
const FOLDED = "sprawl.missions.folded";
const [folded, setFolded] = createSignal((() => {
  try {
    return localStorage.getItem(FOLDED) === "1";
  } catch {
    return false;
  }
})());
const fold = (f: boolean) => {
  setFolded(f);
  try {
    localStorage.setItem(FOLDED, f ? "1" : "0");
  } catch {
    // A private window keeps nothing; the fold still holds for the visit.
  }
};
const [up, setUp] = createSignal(false);
export { up as missionsUp };

/** Where a kind is built: the harbour on the coast, the quarry at the
 *  mountain's foot, the sawmill at the forest's edge. */
const GROUND: Partial<Record<BuildingKind, TerrainType>> = { Harbour: "Sea", Quarry: "Mountain", Sawmill: "Forest" };

/** The camera to the nearest ground of a type it has, stopping a few
 *  tiles short so its edge fills the view: the town opens inland. */
function toward(ground: TerrainType) {
  const sea = (x: number, y: number) => {
    const [cx, cy] = [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
    const tiles = groundOf(cx, cy);
    return !!tiles && TYPE_BY_BYTE[tiles[(y - cy * CHUNK_SIZE + CHUNK_SKIRT) * CHUNK_STRIDE + x - cx * CHUNK_SIZE + CHUNK_SKIRT]] === ground;
  };
  const [x0, y0] = [Math.round(eye.x), Math.round(eye.y)];
  for (let r = 1; r < 96; r++)
    for (let d = -r; d <= r; d++)
      for (const [x, y] of [[x0 + d, y0 - r], [x0 + d, y0 + r], [x0 - r, y0 + d], [x0 + r, y0 + d]])
        if (sea(x, y)) return eye.go(x0 + ((x - x0) * (r - 4)) / r, y0 + ((y - y0) * (r - 4)) / r);
}

/**
 * The town's missions (docs/missions.md), in a pane of glass in the
 * corner: the opening pinned while it runs, then every open mission and
 * those just finished. The server reads every step and pays the reward;
 * this only shows them, the step at hand with what to do and, where one
 * helps, the button that does it. A step done ticks itself; a reward
 * drips into the purse. Folded to a pill with a tap, never in the way.
 */
export default function Missions() {
  const opening = () => missions().find((m) => m.key === "Opening" && m.finished === null);
  const list = () => (opening() ? [opening()!] : missions());
  const open = () => list().filter((m) => m.finished === null).length;
  /** The mission whose step at hand is spelled out: the one tapped, or the first open. */
  const [chosen, setChosen] = createSignal<Key | null>(null);
  const focus = () => list().find((m) => m.key === chosen() && m.finished === null) ?? list().find((m) => m.finished === null);
  /** With a card open, only the step at hand: the card has the room. */
  const brief = () => selected() !== null;
  createEffect(() => setUp(list().length > 0 && !folded()));

  return (
    <Show when={list().length > 0}>
      <Show
        when={!folded()}
        fallback={
          <button data-glass="guide" class="ink press fixed bottom-7 left-6 z-30 flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold cursor-pointer select-none" onClick={() => fold(false)} title="Show the missions">
            <span class="serif text-[17px] font-normal">{opening() ? "The opening" : "Missions"}</span>
            <span class="soft text-xs tabular-nums">{opening() ? `${done(opening()!)} of ${opening()!.steps.length}` : open()}</span>
          </button>
        }
      >
        <div data-glass="guide" class="ink fixed bottom-7 left-6 z-30 w-[300px] rounded-[22px] px-4 pt-3 pb-3.5 text-sm select-none">
          <div class="flex items-baseline gap-2">
            <span class="serif text-[19px]">{opening() ? "The opening" : "Missions"}</span>
            <span class="soft text-xs tabular-nums">{opening() ? `${done(opening()!)} of ${opening()!.steps.length}` : ""}</span>
            <span class="flex-1" />
            <Show when={opening()}>{(m) => <Reward m={m()} />}</Show>
            <button class="soft press px-1 text-lg leading-none cursor-pointer" onClick={() => fold(true)} title="Fold the missions away">×</button>
          </div>
          <Index each={list()}>
            {(m) => (
              <div class="mt-1.5">
                <Show when={!opening()}>
                  <button class="flex w-full items-baseline gap-2 text-left cursor-pointer" classList={{ hidden: brief() && m() !== focus() }} onClick={() => setChosen(m().key)}>
                    <span class="font-semibold" classList={{ "opacity-60": m().finished !== null }}>{m().title}</span>
                    <span class="flex-1" />
                    <Reward m={m()} />
                  </button>
                </Show>
                <Steps m={m()} open={m() === focus()} brief={brief()} />
              </div>
            )}
          </Index>
        </div>
      </Show>
    </Show>
  );
}

const done = (m: Mission) => m.steps.filter((s) => s.done).length;

/** What finishing pays; landed, once it is finished. */
function Reward(props: { m: Mission }) {
  const coins = () => props.m.reward.data;
  return (
    <Show when={props.m.finished !== null} fallback={<span class="soft text-xs font-semibold tabular-nums">+{coins()}</span>}>
      <span class="appear rounded-full px-2 py-0.5 text-[11px] font-bold text-white tabular-nums" style={{ background: "#57A773" }}>+{coins()} coins</span>
    </Show>
  );
}

/** A mission's steps, each ticked as the server finds it done, and the
 *  step at hand spelled out with its button. */
function Steps(props: { m: Mission; open: boolean; brief: boolean }) {
  const at = () => props.m.steps.findIndex((s) => !s.done);
  const many = () => props.m.steps.length > 1;
  return (
    <ol class="mt-1">
      <Index each={props.m.steps}>
        {(s, i) => (
          <li classList={{ "py-1": !props.brief || i === at(), hidden: (props.brief && (i !== at() || !props.open)) || (!many() && !props.open && s().done) }}>
            <div class="flex items-center gap-2" classList={{ "opacity-45": i > at() && at() >= 0 }}>
              <span
                class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-colors duration-500"
                style={s().done ? { background: "#57A773", color: "white" } : i === at() ? { background: "rgb(var(--ink))", color: "rgb(var(--glass))" } : { border: "1.5px solid rgb(var(--ink) / 0.3)" }}
              >
                <Show when={s().done} fallback={many() ? i + 1 : ""}>
                  <svg class="tick" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                </Show>
              </span>
              <span class="font-semibold" classList={{ "line-through decoration-1 opacity-60": s().done }}>{s().title}</span>
            </div>
            <Show when={props.open && i === at() && !props.brief}>
              <div class="appear soft ml-7 mt-1 flex flex-col items-start gap-2 text-[12.5px] leading-snug [&_p]:m-0">
                <Index each={s().text.split("\n\n")}>{(p) => <p>{p()}</p>}</Index>
                <Act step={s()} />
              </div>
            </Show>
          </li>
        )}
      </Index>
    </ol>
  );
}

/** What the step at hand offers to do: a tool to take, a lorry to send,
 *  a switch on the depot it names. */
function Act(props: { step: Step }) {
  const { send } = useGame();
  const g = () => props.step.goal;
  const depot = () => props.step.at;
  /** Said under a step while something of it is drawn and not built. */
  const drafted = () => (
    <Show when={myMarks().length > 0}>
      <p>
        Drawn in blue, it is only a draft: <b>Build</b>, by the toolbar, or Enter, makes it real.
      </p>
    </Show>
  );
  /** The depot's card, open on what the step changed there. */
  const on = (message: Parameters<typeof send>[0]) => () => {
    send(message);
    if (depot() !== null) select(depot());
  };
  const gift = () => sea.shipments.filter((s) => s.order === 0);
  const parked = () => gift().filter((s) => s.leg === "Parked");
  const next = () => gift().find((s) => s.eta !== null);
  const fetch1 = () => {
    const d = depot();
    if (d === null) return;
    send({ type: "Send", data: { depot: d } });
    // Ride with the depot's lorry to the park, and home with the box.
    let lorry: number | null = null;
    eachEntity((e) => {
      if (e.object.kind === "Car" && e.object.data.role === "Truck" && e.object.data.owner === d) lorry = e.id;
    });
    const box = parked()[0];
    if (box) track(box.trailer, lorry);
  };
  return <>{() => {
  const goal = g();
  switch (goal.kind) {
    case "Stands": {
      const kind = goal.data;
      const go = () => GROUND[kind] && toward(GROUND[kind]);
      return (
        <>
          <Btn onClick={() => (go(), setTool({ Building: kind }))}>Take the {BLUEPRINTS[kind].label.toLowerCase()}</Btn>
          {drafted()}
        </>
      );
    }
    case "Joined":
      return (
        <>
          <Btn onClick={() => setTool("Street")}>Take the street</Btn>
          {drafted()}
        </>
      );
    case "Fetched":
      return (
        <Show
          when={parked().length > 0}
          fallback={<Show when={next()}>{(s) => <p>The first ferry is in at {clockAt(s().eta!)}, <b class="tabular-nums">{until(s().eta!)}</b> from now.</p>}</Show>}
        >
          <p>{parked().length === 1 ? "A box is" : `${parked().length} boxes are`} in the trailer park.</p>
          <Btn big onClick={fetch1} color={BLUEPRINTS.Depot.color} disabled={depot() === null}>Send the lorry</Btn>
        </Show>
      );
    case "Settled":
      return (
        <>
          <Btn onClick={() => setTool({ Building: "House" })}>Take a house</Btn>
          {drafted()}
        </>
      );
    case "Standing":
      return <Btn big onClick={on({ type: "Standing", data: { depot: depot()!, on: true } })} color={BLUEPRINTS.Depot.color} disabled={depot() === null}>Give it standing orders</Btn>;
    case "Keeps": {
      const box = GOODS[goal.data].box;
      return <Btn big onClick={on({ type: "SetRule", data: { depot: depot()!, good: goal.data, rule: { keep: box, fill: 2 * box, sell: null } } })} color={BLUEPRINTS.Depot.color} disabled={depot() === null}>Keep {box} {GOODS[goal.data].label}</Btn>;
    }
    case "Sold":
      return <Btn big onClick={on({ type: "Sell", data: { depot: depot()!, good: "Crates" } })} color={BLUEPRINTS.Depot.color} disabled={depot() === null}>Sell a box of crates</Btn>;
  }
  }}</>;
}
