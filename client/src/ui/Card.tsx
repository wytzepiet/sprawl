import { Box, Ink, Text, Icon, type BoxProps } from "~ui";
import { For, Show, createEffect, createRoot, createSignal } from "solid-js";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { select } from "../state/selection";
import { selected } from "../state/selection";
import { eachEntity, getEntity, reached } from "../state/gameObjects";
import { now } from "../state/town";
import { BAD, Bar, GOOD, Press, Row, Section, ROUND } from "./kit";
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
          return {
            title: h ? `${["", "Cottage", "House", "Townhouse", "Apartment"][h.level] ?? bp.label}` : bp.label,
            sub: h ? (h.wants.length ? `wants ${h.wants.map((w) => GOODS[w.good].label.toLowerCase()).join(", ")}` : "content") : idle ? "nobody at work" : bp.makes ? `makes ${GOODS[bp.makes].label.toLowerCase()}` : undefined,
            icon: (
              <Box w={36} h={36} round={18} fill={bp.color} align="center" justify="center">
                <Icon d={bp.glyph} size={19} ink="white" />
              </Box>
            ),
          };
        };
        return <Header title={head().title} sub={head().sub} icon={(head() as { icon?: JSX.Element }).icon} />;
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
  let shop: Building | null = null, best = Infinity, maker = false;
  eachEntity((e) => {
    if (e.object.kind !== "Building") return;
    const b = e.object.data as Building;
    if (BLUEPRINTS[b.kind].makes === good) maker = true;
    if (b.kind !== "Shop" || !reached(e)) return;
    const d = Math.max(Math.abs(b.tiles[0].x - at.x), Math.abs(b.tiles[0].y - at.y));
    if (d <= REACH && d < best) [shop, best] = [b, d];
  });
  const name = GOODS[good].label.toLowerCase();
  if (!shop) return "no shop within reach";
  if (!maker) return `nobody makes ${name}`;
  if (((shop as Building).stocks[good]?.level ?? 0) < 1) return `the shop is out of ${name}`;
  return "on the shelf: the car goes soon";
}

const stocks = (s: { [key in Good]?: Stock }) => Object.entries(s) as [Good, Stock][];

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
                      <Row label={GOODS[w.good].label}>
                        <Bar value={left()} color={left() < 0.3 ? BAD : GOOD} />
                        <Text size={12} soft>{w.by !== null ? "on its way" : why(props.b, props.id, w.good)}</Text>
                      </Row>
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
            <Bar value={props.b.work} color={GOODS[bp().makes ?? "Logs"]?.color} />
          </Row>
        </Section>
      </Show>
      <Show when={!props.b.home && stocks(props.b.stocks).length > 0}>
        <Section title={bp().seats > 0 ? "Yard" : "Shelves"}>
          <For each={stocks(props.b.stocks)}>
            {([good, s]) => (
              <Row label={GOODS[good].label}>
                <Bar value={s.level / Math.max(1, s.cap)} color={s.level < 1 ? BAD : GOODS[good].color} />
                <Text size={12} soft>{`${Math.floor(s.level)} / ${s.cap}`}</Text>
              </Row>
            )}
          </For>
        </Section>
      </Show>
    </>
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

export function Header(props: { title: string; sub?: string; icon?: JSX.Element; onClose?: () => void }) {
  return (
    <Box dir="row" align="center" gap={10} pad={{ x: 16, top: 14, bottom: 10 }}>
      {props.icon}
      <Box grow={1} gap={2}>
        <Text size={16} weight={600} lines={1}>{props.title}</Text>
        <Show when={props.sub}>
          <Text size={12} soft lines={1}>{props.sub}</Text>
        </Show>
      </Box>
      <Press w={28} h={28} round={14} align="center" justify="center" onTap={props.onClose ?? (() => select(null))}>
        <Icon d={CLOSE} size={14} stroke={2.4} ink="ink/0.6" />
      </Press>
    </Box>
  );
}
