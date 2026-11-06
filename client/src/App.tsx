import "./app.css";
import { createResource, Show } from "solid-js";
import Scene from "./engine/Scene";
import { createConnection } from "./network/connection";
import { connectLevel } from "./interchange/connection";
import { playerId } from "./network/playerId";

// Identity travels with the connection rather than being handed out by the
// server, so reconnecting rejoins as the same player.
const wsUrl =
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws` +
  `?player=${playerId()}`;

/** `?town=15-city`: a test town (`server/fixtures`) run in this tab on the
 *  game compiled to wasm, as a level is, rather than the server's world:
 *  the same town on every device and every build, for the bench. */
const fixtures = import.meta.glob<string>("../../server/fixtures/*.txt", { query: "?raw", import: "default" });
const town = new URLSearchParams(location.search).get("town");

export default function App() {
  if (!town) return <Scene connect={(on) => createConnection(wsUrl, on)} />;
  const [text] = createResource(() => fixtures[`../../server/fixtures/${town}.txt`]?.() ?? Promise.reject(new Error(`no town ${town}`)));
  return <Show when={text()}>{(text) => <Scene connect={(on) => connectLevel(town, text(), null, on, () => {}, () => {})} />}</Show>;
}
