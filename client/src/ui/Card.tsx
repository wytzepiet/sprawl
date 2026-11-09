import { Box, Ink, Text, Icon, type BoxProps } from "~ui";
import { For, Show, createEffect, createRoot, createSignal } from "solid-js";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { select } from "../state/selection";
import { selected } from "../state/selection";
import { eachEntity, getEntity, reached } from "../state/gameObjects";
import { now, town } from "../state/town";
import { useGame } from "../state/gameObjects";
import { LORRY_COLOR } from "./Picks";
import { BAD, Bar, GOOD, Press, Row, Section, Ticks, ROUND } from "./kit";
import { PATIENCE_MS } from "../generated/rows";
import type { JSX } from "solid-js";
import type { Building, Car, CarRole, Good, Stock } from "../generated";

const CLOSE = "M6 6l12 12M18 6L6 18";

createRoot(() => {
  // `#1234` in the address is a card to open on arrival.
  const fromHash = () => {
    const id = Number(location.hash.slice(1));
    if (id) select(id);
  };
  fromHash();
  window.addEventListener("hashchange", fromHash);
});

/** What is selected, as the client has it now: read again four times a second. */
const thing = () => {
  now();
  const id = selected();
  const e = id === null ? undefined : getEntity(id);
  if (!e) return null;
  if (e.object.kind === "Building") return { kind: "building" as const, b: e.object.data as Building };
  if (e.object.kind === "Car") return { kind: "car" as const, c: e.object.data as Car };
  return null;
};

const ROLE: Record<CarRole, string> = { Private: "Car", Truck: "Lorry", Van: "Van", Tractor: "Tractor", Ferry: "Ferry" };

/** The card's head: the thing's name, and what it is doing. */
export function InspectHead() {
  return (
    <Show when={thing()}>
      {(t) => {
        const head = () => {
          const x = t();
          if (x.kind === "car") {
            const owner = getEntity(x.c.owner);
            const of = owner?.object.kind === "Building" ? BLUEPRINTS[(owner.object.data as Building).kind].label : null;
            return { title: of ? `${of}'s ${ROLE[x.c.role].toLowerCase()}` : ROLE[x.c.role], sub: x.c.trip ? "on the road" : "parked" };
          }
          const bp = BLUEPRINTS[x.b.kind];
          const h = x.b.home;
          const idle = bp.seats > 0 && x.b.present === 0;
          // A want nobody is out for leads: why not, the oldest first.
          const stuck = h?.wants.filter((w) => w.by === null).sort((a, b) => a.since - b.since)[0];
          return {
            title: h ? `${["", "Cottage", "House", "Townhouse", "Apartment"][h.level] ?? bp.label}` : bp.label,
            sub: stuck ? `${GOODS[stuck.good].label}: ${why(x.b, selected()!, stuck.good)}` : h ? (h.wants.length ? "what it wants is on its way" : "content") : idle ? "nobody at work" : bp.makes ? `makes ${GOODS[bp.makes].label.toLowerCase()}` : undefined,
            alarm: !!stuck || idle,
            icon: (
              <Box w={36} h={36} round={18} fill={bp.color} align="center" justify="center">
                <Icon d={bp.glyph} size={19} ink="white" />
              </Box>
            ),
          };
        };
        return <Header title={head().title} sub={head().sub} alarm={(head() as { alarm?: boolean }).alarm} icon={(head() as { icon?: JSX.Element }).icon} />;
      }}
    </Show>
  );
}

/** Its lines: a house's wants and growth, a maker's crew and yard, a shop's shelves. */
export function InspectBody() {
  return (
    <Show when={thing()?.kind === "building" && thing()}>
      {(t) => <BuildingLines b={(t() as { b: Building }).b} id={selected()!} />}
    </Show>
  );
}

/** How far a family drives to a shop (`town::homes::REACH`). */
const REACH = 26;

/** Why a want is not met yet, as near as the client can tell: the link
 *  in the chain that is missing, so the mayor knows what to build. */
export function why(home: Building, homeId: number, good: Good): string {
  const entry = getEntity(homeId);
  if (!entry || !reached(entry)) return "no road to the house";
  const at = home.tiles[0];
  let shop: Building | null = null, best = Infinity, maker = false, crewed = false;
  eachEntity((e) => {
    if (e.object.kind !== "Building") return;
    const b = e.object.data as Building;
    if (BLUEPRINTS[b.kind].makes === good) [maker, crewed] = [true, crewed || b.present > 0];
    if (b.kind !== "Shop" || !reached(e)) return;
    const d = Math.max(Math.abs(b.tiles[0].x - at.x), Math.abs(b.tiles[0].y - at.y));
    if (d <= REACH && d < best) [shop, best] = [b, d];
  });
  const name = GOODS[good].label.toLowerCase();
  if (!shop) return "no shop within reach";
  if (!maker) return `nobody makes ${name}`;
  if (((shop as Building).stocks[good]?.level ?? 0) < 1) return crewed ? `the shop is out of ${name}` : `nobody at work making ${name}`;
  return "on the shelf: the car goes soon";
}

const stocks = (s: { [key in Good]?: Stock }) => Object.entries(s) as [Good, Stock][];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function BuildingLines(props: { b: Building; id: number }) {
  const bp = () => BLUEPRINTS[props.b.kind];
  return (
    <>
      <Show when={props.b.home}>
        {(h) => (
          <>
            <Show when={h().wants.length > 0}>
              <Section title="Wants">
                <For each={h().wants}>
                  {(w) => {
                    const left = () => 1 - Math.min(1, (now() - w.since) / PATIENCE_MS);
                    return (
                      <Box gap={2}>
                        <Row label={GOODS[w.good].label}>
                          <Bar value={left()} color={left() < 0.3 ? BAD : GOOD} />
                        </Row>
                        <Text size={13} weight={600} ink={w.by !== null ? GOOD : BAD}>{w.by !== null ? "On its way" : cap(why(props.b, props.id, w.good))}</Text>
                      </Box>
                    );
                  }}
                </For>
              </Section>
            </Show>
            <Show when={h().growing}>
              {(g) => (
                <Section title="Growing">
                  <For each={stocks(g())}>{([good, s]) => <Row label={GOODS[good].label}><Bar value={s.level / Math.max(1, s.cap)} color={GOODS[good].color} /></Row>}</For>
                </Section>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={bp().seats > 0}>
        <Section title="Crew">
          <Row label={`${props.b.present} of ${bp().seats} at work`}>
            <Ticks n={props.b.present} of={bp().seats} color={GOODS[bp().makes ?? "Logs"]?.color ?? GOOD} w={Math.min(120, bp().seats * 18)} />
          </Row>
          <Row label="Next crate">
            <Bar value={props.b.work} w={120} color={GOODS[bp().makes ?? "Logs"]?.color} />
          </Row>
        </Section>
      </Show>
      <Show when={bp().lorries > 0}>
        <Lorries id={props.id} docks={bp().docks} />
      </Show>
      <Show when={!props.b.home && stocks(props.b.stocks).length > 0}>
        <Section title={bp().seats > 0 ? "Yard" : "Shelves"}>
          <For each={stocks(props.b.stocks)}>
            {([good, s]) => (
              <Row label={GOODS[good].label}>
                <Ticks n={s.level} of={s.cap} color={GOODS[good].color} />
                <Text num size={13} ink={s.level < 1 ? BAD : undefined} soft={s.level >= 1}>{`${Math.floor(s.level)} / ${s.cap}`}</Text>
              </Row>
            )}
          </For>
        </Section>
      </Show>
    </>
  );
}

/** A building's lorries, one to a dock it has, and one from the hand to
 *  give it while it has a dock without. */
function Lorries(props: { id: number; docks: number }) {
  const { send } = useGame();
  const n = () => {
    now();
    let k = 0;
    eachEntity((e) => {
      const c = e.object.kind === "Car" ? (e.object.data as Car) : null;
      if (c && c.owner === props.id && c.role === "Truck") k++;
    });
    return k;
  };
  return (
    <Section title="Lorries">
      <Row label={`${n()} of ${props.docks}`}>
        <Ticks n={n()} of={props.docks} color={LORRY_COLOR} w={Math.min(120, props.docks * 18)} />
      </Row>
      <Show when={town().lorries > 0 && n() < props.docks}>
        <Press round={12} pad={{ x: 12, y: 8 }} fill={LORRY_COLOR} align="center" onTap={() => send({ type: "AddLorry", data: { building: props.id } })}>
          <Text size={15} weight={600} ink="white">{town().lorries > 1 ? `Give it a lorry (${town().lorries} in hand)` : "Give it the lorry in hand"}</Text>
        </Press>
      </Show>
    </Section>
  );
}

/** A pane where it lies, at most as tall as its room; what is taller
 *  scrolls under the wheel or a finger. */
export function Pane(props: { children: JSX.Element; layer: string; at: BoxProps["at"]; w?: number; room: number }) {
  const [tall, setTall] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const roll = (by: number) => setScroll(Math.max(0, Math.min(tall() - props.room, scroll() + by)));
  createEffect(() => tall() <= props.room && setScroll(0));
  return (
    <Ink layer={props.layer} at={props.at} w={props.w} h={Math.min(tall(), props.room)} round={ROUND} clip onScroll={roll}>
      <Box y={-scroll()} pad={{ bottom: 6 }} onSize={(_, h) => setTall(h)}>
        {props.children}
      </Box>
    </Ink>
  );
}

/** A card's head: its name, a line under it (red when it is what is
 *  wrong), and a way to close it. */
export function Header(props: { title: string; sub?: string; alarm?: boolean; icon?: JSX.Element; onClose?: () => void }) {
  return (
    <Box dir="row" align="center" gap={10} pad={{ x: 16, top: 14, bottom: 10 }}>
      {props.icon}
      <Box grow={1} gap={2}>
        <Text size={17} weight={600} lines={1}>{props.title}</Text>
        <Show when={props.sub}>
          <Text size={13} weight={props.alarm ? 600 : undefined} ink={props.alarm ? BAD : undefined} soft={!props.alarm} lines={1}>{props.sub}</Text>
        </Show>
      </Box>
      <Press w={30} h={30} round={15} align="center" justify="center" fill="ink/0.14" onTap={props.onClose ?? (() => select(null))}>
        <Icon d={CLOSE} size={12} stroke={3} ink="ink/0.7" />
      </Press>
    </Box>
  );
}
