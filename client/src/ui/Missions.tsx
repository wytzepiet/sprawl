import { createEffect, Index, Show } from "solid-js";
import { eachEntity, groundOf } from "../state/gameObjects";
import { eye } from "../engine/OrthoCamera";
import { CHUNK_SIZE, CHUNK_SKIRT, CHUNK_STRIDE, TYPE_BY_BYTE } from "../engine/objects/terrainGeometry";
import { clockAt, sea, until } from "../state/sea";
import { missions } from "../state/missions";
import { crest } from "../flat/crest";
import { hold, setTool } from "./buildMode";
import { track } from "./Shipments";
import { setPicking, setSpread } from "../state/deals";
import { Btn, StepBar } from "./kit";
import { BLUEPRINTS } from "../blueprints";
import type { BuildingKind, Mission, Step, TerrainType } from "../generated";
import type { Neighbour } from "../generated/Neighbour";

/** Where a kind is built: the harbour on the coast, the quarry at the
 *  mountain's foot, the sawmill at the forest's edge. */
export const GROUND: Partial<Record<BuildingKind, TerrainType>> = { Harbour: "Sea", Quarry: "Mountain", Sawmill: "Forest" };

/** The camera to the nearest ground of a type it has, stopping a few
 *  tiles short so its edge fills the view: the town opens inland. */
export function toward(ground: TerrainType) {
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

/** A mission's key as a name: an order's is its number. */
const keyOf = (m: Mission) => (typeof m.key === "object" ? `order ${m.key.Order}` : m.key);

/** The missions the feed shows: the opening while it runs, else the
 *  town's own, open and just finished. A mayor's letter is a deal. */
export const shownMissions = () => {
  const opening = missions().find((m) => m.key === "Opening" && m.finished === null);
  return opening ? [opening] : missions().filter((m) => m.from === null);
};
export const missionKey = (m: Mission) => `mission:${keyOf(m)}`;

/**
 * A mission as a card of the feed (docs/missions.md), pinned while it is
 * open: its title, the step at hand, a bar of its steps and what it pays.
 * Opened, the step at hand spelled out, with the button that does it,
 * where one helps. The server reads every step and pays the reward; a
 * step done fills the bar; a reward drips into the purse.
 */
export function MissionCard(props: { m: Mission; open: boolean; onTap: () => void }) {
  const at = () => props.m.steps.findIndex((s) => !s.done);
  const step = () => props.m.steps[at()];
  const done = () => props.m.steps.filter((s) => s.done).length;
  const color = () => (props.m.finished !== null ? "#57A773" : "#7B77E0");
  return (
    <div>
      <button class="block w-full px-3 pb-3 pt-2.5 text-left cursor-pointer" onClick={props.onTap}>
        <div class="flex items-center gap-2.5">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-white" style={{ background: color() }}>
            <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M5 3h2v18H5zM7 4h11l-2.5 4L18 12H7z" /></svg>
          </span>
          <div class="min-w-0 flex-1 leading-tight">
            <div class="truncate text-[14.5px] font-semibold">{props.m.title}</div>
            <div class="soft mt-0.5 truncate text-[12.5px]">{step()?.title ?? "Done"}</div>
          </div>
          <Reward m={props.m} />
        </div>
        <div class="mt-2"><StepBar steps={props.m.steps.length} at={done() - 1} color={color()} /></div>
      </button>
      <Show when={props.open && step()}>
        {(s) => (
          <div class="appear soft flex flex-col items-start gap-2 px-3 pb-3 text-[12.5px] leading-snug [&_p]:m-0">
            <Index each={s().text.split("\n\n")}>{(p) => <p>{p()}</p>}</Index>
            <Act step={s()} m={props.m} />
          </div>
        )}
      </Show>
    </div>
  );
}

/** A town's crest, drawn by the one function that draws a mayor. */
export function Crest(props: { n: Neighbour; size: number }) {
  let c!: HTMLCanvasElement;
  // Drawn once it is on the page: a canvas drawn before has no font yet.
  createEffect(() => {
    const k = devicePixelRatio || 1;
    c.width = c.height = Math.round(props.size * k);
    crest(c.getContext("2d")!, props.n, c.width / 2, c.height / 2, c.width / 2 - k);
  });
  return <canvas ref={c} class="shrink-0" style={{ width: `${props.size}px`, height: `${props.size}px` }} />;
}

/** What finishing pays; landed, once it is finished. An order's coins
 *  come a box at a time as each sails, and standing with the last; one
 *  given up on pays no more. */
function Reward(props: { m: Mission }) {
  const coins = () => (props.m.reward.kind === "Coins" ? props.m.reward.data : props.m.reward.data.coins);
  const lapsed = () => props.m.finished !== null && props.m.steps.some((s) => !s.done);
  return (
    <Show when={props.m.finished !== null} fallback={<span class="soft text-xs font-semibold tabular-nums">+{coins()}</span>}>
      <Show when={!lapsed()} fallback={<span class="soft text-[11px] font-semibold">lapsed</span>}>
        <span class="appear rounded-full px-2 py-0.5 text-[11px] font-bold text-white tabular-nums" style={{ background: "#57A773" }}>
          +{coins()} coins{props.m.reward.kind === "Order" ? `, +${props.m.reward.data.standing} standing` : ""}
        </span>
      </Show>
    </Show>
  );
}

/** What the step at hand offers to do: a tool to take, a lorry to ride
 *  with, a new deal to make. */
function Act(props: { step: Step; m: Mission }) {
  const g = () => props.step.goal;
  const depot = () => props.step.at;
  const gift = () => sea.shipments.filter((s) => s.order === 0);
  const parked = () => gift().filter((s) => s.leg === "Parked");
  const next = () => gift().find((s) => s.eta !== null);
  const ride = () => {
    const d = depot();
    if (d === null) return;
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
      return <Btn onClick={() => (go(), hold(kind))}>Take the {BLUEPRINTS[kind].label.toLowerCase()}</Btn>;
    }
    case "Joined":
      return <Btn onClick={() => setTool("Street")}>Take the street</Btn>;
    case "Fetched":
      return (
        <Show
          when={parked().length > 0}
          fallback={<Show when={next()}>{(s) => <p>The first ferry is in at {clockAt(s().eta!)}, <b class="tabular-nums">{until(s().eta!)}</b> from now.</p>}</Show>}
        >
          <p>{parked().length === 1 ? "A box is" : `${parked().length} boxes are`} in the trailer park.</p>
          <Btn big onClick={ride} color={BLUEPRINTS.Depot.color} disabled={depot() === null}>Ride with the lorry</Btn>
        </Show>
      );
    case "Settled":
      return <Btn onClick={() => hold("House")}>Take a house</Btn>;
    case "Booked":
    case "Pinned":
    case "Sold":
      return <Btn big onClick={() => (goal.kind === "Pinned" ? setSpread(true) : setPicking(goal.kind === "Sold"))} color={BLUEPRINTS.Harbour.color}>{goal.kind === "Pinned" ? "Open the deals" : "A new deal"}</Btn>;
  }
  }}</>;
}
