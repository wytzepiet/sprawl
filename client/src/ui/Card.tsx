/** @jsxImportSource ~ui */
import { For, Show, createEffect, createRoot, createSignal } from "solid-js";
import { BLUEPRINTS, GOODS } from "../blueprints";
import { select, selected } from "../state/selection";
import { getEntity, reached } from "../state/gameObjects";
import { now } from "../state/town";
import { PATIENCE_MS } from "../generated/rows";
import { BAD, Bar, GOOD, Press, Row, Section } from "./kit";
import type { JSX } from "~ui/jsx-runtime";
import type { Building, Car, CarRole } from "../generated";

const CLOSE = "M6 6l12 12M18 6L6 18";

createRoot(() => {
  // `#1234` in the address is a card to open on arrival: a thing you can
  // point someone at.
  const fromHash = () => {
    const id = Number(location.hash.slice(1));
    if (id) select(id);
  };
  fromHash();
  window.addEventListener("hashchange", fromHash);
});

const ROLE: Record<CarRole, string> = { Private: "Family car", Truck: "Shop's lorry", Van: "Van", Tractor: "Tractor", Ferry: "Ferry" };

/** What was tapped, read again four times a second: the map's own record of it. */
const thing = () => {
  now();
  const id = selected();
  return id === null ? null : (getEntity(id) ?? null);
};

/**
 * The card for whatever was tapped, as the select tab's sheet: its head
 * the thing's name, peeking over the dock; drawn up, what it wants or
 * holds.
 */
export function InspectHead() {
  return (
    <Show when={thing()} fallback={<Header title="Gone" sub="Nothing stands here any more" />}>
      {(e) => {
        const head = () => {
          const o = e().object;
          if (o.kind === "Car") {
            const c = o.data as Car;
            return { title: ROLE[c.role], sub: c.trip ? "on the road" : "parked" };
          }
          if (o.kind !== "Building") return { title: o.kind };
          const b = o.data as Building;
          const bp = BLUEPRINTS[b.kind];
          return {
            title: bp.label,
            sub: reached(e()) ? undefined : "no road reaches it",
            icon: (
              <box w={36} h={36} round={18} fill={bp.color} align="center" justify="center">
                <icon d={bp.glyph} size={19} ink="white" />
              </box>
            ),
          };
        };
        return <Header title={head().title} sub={head().sub} icon={(head() as { icon?: JSX.Element }).icon} />;
      }}
    </Show>
  );
}

export function InspectBody() {
  const building = () => {
    const o = thing()?.object;
    return o?.kind === "Building" ? (o.data as Building) : null;
  };
  const car = () => {
    const o = thing()?.object;
    return o?.kind === "Car" ? (o.data as Car) : null;
  };
  return (
    <box pad={{ bottom: 12 }}>
      <Show when={building()}>
        {(b) => (
          <>
            <Show when={b().home}>
              {(h) => (
                <Section title={h().wants.length ? "Wants" : "Has all it wants"}>
                  <For each={h().wants}>
                    {(w) => (
                      <Row label={GOODS[w.good].label}>
                        <Bar value={1 - (now() - w.since) / PATIENCE_MS} color={now() - w.since > PATIENCE_MS / 2 ? BAD : GOOD} />
                      </Row>
                    )}
                  </For>
                </Section>
              )}
            </Show>
            <Show when={Object.keys(b().stocks).length}>
              <Section title="On the shelf">
                <For each={Object.entries(b().stocks)}>
                  {([g, s]) => (
                    <Row label={GOODS[g as keyof typeof GOODS].label}>
                      <text serif size={13}>{`${s!.level} / ${s!.cap}`}</text>
                    </Row>
                  )}
                </For>
              </Section>
            </Show>
            <box pad={{ x: 16, top: 6 }}>
              <text size={13} soft lead={1.45}>{BLUEPRINTS[b().kind].about}</text>
            </box>
          </>
        )}
      </Show>
      <Show when={car()?.load}>
        {(l) => (
          <Section title="Carrying">
            <Row label={GOODS[l()[0]].label}>
              <text serif size={13}>{l()[1]}</text>
            </Row>
          </Section>
        )}
      </Show>
    </box>
  );
}

/** A pane of glass where it lies, at most as tall as its room; what is
 *  taller scrolls under the wheel or a finger. */
export function Pane(props: { children: JSX.Element; layer: string; at: JSX.Box["at"]; w?: number; room: number }) {
  const [tall, setTall] = createSignal(0);
  const [scroll, setScroll] = createSignal(0);
  const roll = (by: number) => setScroll(Math.max(0, Math.min(tall() - props.room, scroll() + by)));
  createEffect(() => tall() <= props.room && setScroll(0));
  return (
    <glass layer={props.layer} at={props.at} w={props.w} h={Math.min(tall(), props.room)} round={22} clip onScroll={roll}>
      <box y={-scroll()} pad={{ bottom: 6 }} onSize={(_, h) => setTall(h)}>
        {props.children}
      </box>
    </glass>
  );
}

export function Header(props: { title: string; sub?: string; icon?: JSX.Element; onClose?: () => void }) {
  return (
    <box dir="row" align="center" gap={10} pad={{ x: 16, top: 14, bottom: 10 }}>
      {props.icon}
      <box grow={1} gap={2}>
        <text size={16} weight={600} lines={1}>{props.title}</text>
        <Show when={props.sub}>
          <text size={12} soft lines={1}>{props.sub}</text>
        </Show>
      </box>
      <Press w={28} h={28} round={14} align="center" justify="center" onTap={props.onClose ?? (() => select(null))}>
        <icon d={CLOSE} size={14} stroke={2.4} ink="ink/0.6" />
      </Press>
    </box>
  );
}

