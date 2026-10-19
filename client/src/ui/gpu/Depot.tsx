/** @jsxImportSource ~ui */
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { buildingAt, getEntity, useGame } from "../../state/gameObjects";
import { load, now, sea, until } from "../../state/sea";
import { GOODS } from "../../blueprints";
import { GOOD_ORDER } from "../../state/deals";
import { coins, Follow, GoodDot, Pop, Press, Section } from "./kit";
import type { Building, Car, Good } from "../../generated";

/** What another lorry costs from the world, and how many a depot may buy (`haul.rs`). */
const LORRY_PRICE = 40;
const MORE_LORRIES = 3;

/** A building of the client's, read again four times a second. */
const building = (id: number) =>
  createMemo(() => {
    now();
    const e = getEntity(id);
    return e?.object.kind === "Building" ? (e.object.data as Building) : null;
  });

/** The harbour a lorry is standing at, if any. */
const atHarbour = (car: { x: number; y: number } | null) => {
  if (!car) return false;
  const b = buildingAt(car.x, car.y);
  return b?.object.kind === "Building" && (b.object.data as Building).kind === "Harbour";
};

/**
 * A depot's card: its lorries and what each is doing, another bought;
 * and each good's stock, what is on its way drawn faint beyond it. The
 * lorries go about their work of their own accord: what comes in and
 * goes out is the feed's deals.
 */
export function DepotPanel(props: { id: number; lorries: number[] }) {
  const { send, growth } = useGame();
  const b = building(props.id);
  const cars = createMemo(() => {
    now();
    return props.lorries.map((id) => {
      const e = getEntity(id);
      return { id, car: e?.object.kind === "Car" ? (e.object.data as Car) : null, at: e?.position ?? null };
    });
  });
  const [bought, setBought] = createSignal(false);
  const buy = () => {
    send({ type: "BuyLorry", data: { depot: props.id } });
    setBought(true);
    setTimeout(() => setBought(false), 1800);
  };
  const can = () => (b()?.lorries ?? 0) < MORE_LORRIES && growth().treasury >= LORRY_PRICE;

  return (
    <Show when={b()} fallback={<Section title="Depot"><text size={13.5} soft>Out of sight.</text></Section>}>
      {(d) => (
        <>
          <Section title={props.lorries.length > 1 ? `Lorries · ${props.lorries.length}` : "The lorry"}>
            <Index each={cars()}>
              {(l) => {
                const w = () => doing(props.id, l().car, l().at);
                return (
                  <box dir="row" align="center" gap={8} minH={26}>
                    <text grow={1} size={14.5} weight={600} lines={2}>{w().words[0].toUpperCase() + w().words.slice(1)}</text>
                    <Show when={w().eta}>{(eta) => <text serif size={18}>{until(eta())}</text>}</Show>
                    <Follow id={l().id} />
                  </box>
                );
              }}
            </Index>
            <box dir="row" justify="end" pad={{ top: 6 }}>
              <Press dir="row" align="center" gap={6} h={30} pad={{ x: 12 }} round={15} stroke={[1.5, "ink/0.18"]} opacity={can() ? 1 : 0.4} onTap={() => can() && buy()}>
                <Show when={bought()} fallback={<text size={12.5} weight={600}>+ lorry</text>}>
                  <Pop><text size={12.5} weight={600}>Bought ✓</text></Pop>
                </Show>
                <text serif size={12.5} soft>{coins(-LORRY_PRICE)}</text>
              </Press>
            </box>
          </Section>
          <Section title="Stock">
            <For each={GOOD_ORDER.filter((g) => d().stocks[g])}>{(g) => <Shelf depot={props.id} good={g} level={d().stocks[g]!.level} cap={d().stocks[g]!.cap} />}</For>
          </Section>
        </>
      )}
    </Show>
  );
}

/** A depot's lorry in words, and when it is due. */
function doing(depot: number, car: Car | null, at: { x: number; y: number } | null): { words: string; eta: number | null } {
  if (!car) return { words: "out of sight", eta: null };
  const box = car.hitched;
  if (car.trip) {
    const home = car.trip.destination === depot;
    const words = home ? (box ? `bringing ${load(box)} home` : "coming home") : box ? `taking ${load(box)} to the harbour` : "on its way to the harbour";
    return { words, eta: car.trip.eta };
  }
  if (atHarbour(at)) return { words: "at the harbour, hitching up", eta: null };
  if (box && !box.outbound) return { words: `unloading ${load(box)}`, eta: null };
  return { words: box ? `in the yard with ${load(box)}` : "in the yard", eta: null };
}

/** A good's shelf: how full, and what is on its way drawn faint beyond it. */
function Shelf(props: { depot: number; good: Good; level: number; cap: number }) {
  const incoming = () => sea.shipments.filter((s) => (s.to === props.depot || s.to === null) && s.good === props.good && !s.outbound).reduce((a, s) => a + s.units, 0);
  const share = (v: number) => Math.max(0, Math.min(1, v / props.cap));
  const [w, setW] = createSignal(0);
  const color = () => GOODS[props.good].color;
  return (
    <box pad={{ y: 6 }} gap={8}>
      <box dir="row" align="center" gap={8}>
        <GoodDot good={props.good} size={20} />
        <text size={13.5} weight={600}>{GOODS[props.good].label[0].toUpperCase() + GOODS[props.good].label.slice(1)}</text>
        <box dir="row" align="end" gap={2}>
          <text serif size={13.5}>{Math.floor(props.level)}</text>
          <text serif size={12} soft>/ {props.cap}</text>
        </box>
        <Show when={incoming() > 0}>
          <text size={11} soft>+{Math.round(incoming())} coming</text>
        </Show>
      </box>
      <box h={14} round={7} fill="ink/0.09" onSize={(x) => setW(x)}>
        <box at={{ left: 0, top: 0 }} w={w() * share(props.level + incoming())} h={14} round={7} fill={`${color()}55`} />
        <box at={{ left: 0, top: 0 }} w={w() * share(props.level)} h={14} round={7} fill={color()} />
      </box>
    </box>
  );
}
