import "./app.css";
import { createSignal, Show } from "solid-js";
import Scene from "./engine/Scene";

const servers = [
  ...(import.meta.env.DEV ? [{ name: "Local", ws: "ws://localhost:3001/ws" }] : []),
  { name: "EU 1", ws: "wss://eu-1.sprawl.nl/ws" },
];

export default function App() {
  const [wsUrl, setWsUrl] = createSignal<string | null>(null);

  return (
    <Show
      when={wsUrl()}
      fallback={
        <div class="h-screen w-screen flex items-center justify-center bg-neutral-900">
          <div class="flex flex-col gap-3">
            <h1 class="text-white text-2xl font-bold mb-2">Sprawl</h1>
            {servers.map((s) => (
              <button
                class="px-6 py-3 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-lg cursor-pointer"
                onClick={() => setWsUrl(s.ws)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {(url) => <Scene wsUrl={url()} />}
    </Show>
  );
}
