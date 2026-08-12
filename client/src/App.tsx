import "./app.css";
import Scene from "./engine/Scene";
import { playerId } from "./network/playerId";

// Identity travels with the connection rather than being handed out by the
// server, so reconnecting rejoins as the same player.
const wsUrl =
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws` +
  `?player=${playerId()}`;

export default function App() {
  return <Scene wsUrl={wsUrl} />;
}
