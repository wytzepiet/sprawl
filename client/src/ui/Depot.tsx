import { Box, Text } from "~ui";
import { createMemo, createSignal, Index, Show } from "solid-js";
import { BLUEPRINTS } from "../blueprints";
import { buildingAt, getEntity, useGame } from "../state/gameObjects";
import { load, now, until } from "../state/sea";
import { Btn, coins, Follow, Section } from "./kit";
import { LORRY_PRICE, MORE_LORRIES } from "../generated/rows";
import type { Building, Car, CarRole } from "../generated";

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
  return b?.object.kind === "Building" && BLUEPRINTS[(b.object.data as Building).kind].quay;
};

/**
 * A depot's card: its lorries and what each is doing, another lorry or
 * van bought.
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
  const [bought, setBought] = createSignal<CarRole | null>(null);
  const buy = (role: CarRole) => {
    send({ type: "Buy", data: { depot: props.id, role } });
    setBought(role);
    setTimeout(() => setBought(null), 1800);
  };
  const can = () => (b()?.lorries ?? 0) + (b()?.vans ?? 0) < MORE_LORRIES && growth().treasury >= LORRY_PRICE;

  return (
    <Show when={b()} fallback={<Section title="Depot"><Text size={13.5} soft>Out of sight.</Text></Section>}>
      <Section title={props.lorries.length > 1 ? `Lorries · ${props.lorries.length}` : "The lorry"}>
        <Index each={cars()}>
          {(l) => {
            const w = () => doing(props.id, l().car, l().at);
            return (
              <Box dir="row" align="center" gap={8} minH={26}>
                <Text grow={1} size={14.5} weight={600} lines={2}>{w().words[0].toUpperCase() + w().words.slice(1)}</Text>
                <Show when={w().eta}>{(eta) => <Text serif size={18}>{until(eta())}</Text>}</Show>
                <Follow id={l().id} />
              </Box>
            );
          }}
        </Index>
        <Box dir="row" justify="end" gap={8} pad={{ top: 6 }}>
          <Btn onTap={() => buy("Van")} disabled={!can()}>{bought() === "Van" ? "Bought ✓" : `+ van ${coins(-LORRY_PRICE)}`}</Btn>
          <Btn onTap={() => buy("Truck")} disabled={!can()}>{bought() === "Truck" ? "Bought ✓" : `+ lorry ${coins(-LORRY_PRICE)}`}</Btn>
        </Box>
      </Section>
    </Show>
  );
}

/** A depot's lorry in words, and when it is due. */
function doing(depot: number, car: Car | null, at: { x: number; y: number } | null): { words: string; eta: number | null } {
  if (!car) return { words: "out of sight", eta: null };
  const on = car.cargo.length ? load(car.cargo) : null;
  if (car.trip) {
    const home = car.trip.destination === depot;
    const words = home ? (on ? `bringing ${on} home` : "coming home") : on ? `taking ${on} out` : "on its way to fetch";
    return { words, eta: car.trip.eta };
  }
  if (atHarbour(at)) return { words: "at the harbour, by the forklift", eta: null };
  if (on && car.cargo.some((p) => !p.outbound)) return { words: `unloading ${on}`, eta: null };
  return { words: on ? `in the yard with ${on}` : "in the yard", eta: null };
}
