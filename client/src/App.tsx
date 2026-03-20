import "./app.css";
import Scene from "./engine/Scene";

const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

export default function App() {
  return <Scene wsUrl={wsUrl} />;
}
