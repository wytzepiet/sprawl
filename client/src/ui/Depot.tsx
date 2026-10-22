/** @jsxImportSource ~ui */
import { createMemo, createSignal, Index, Show } from "solid-js";
import { buildingAt, getEntity, useGame } from "../state/gameObjects";
import { load, now, until } from "../state/sea";
import { Btn, coins, Follow, Section } from "./kit";
import { LORRY_PRICE, MORE_LORRIES } from "../generated/rows";
import type { Building, Car } from "../generated";

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
 * A depot's card: its lorries and what each is doing, another bought.
 * The lorries go about their work of their own accord: what comes in
 * and goes out is the feed's deals, and what the depots hold is the
 * market's (docs/plan-market.md: a building never gets a panel of its own).
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
          <Btn onTap={buy} disabled={!can()}>{bought() ? "Bought ✓" : `+ lorry ${coins(-LORRY_PRICE)}`}</Btn>
        </box>
      </Section>
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
