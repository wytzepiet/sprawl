import { lazy } from "solid-js";
import { render } from "solid-js/web";

import App from "./App";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

// The puzzle: interchanges between the roads at a map's edges, run in the
// browser (`interchange/`).
const Interchange = lazy(() => import("./interchange/Interchange"));
// The opening, played in the browser, fresh on every load (`opening/`).
const Opening = lazy(() => import("./opening/Opening"));
const path = location.pathname;
render(() => (path.startsWith("/interchange") ? <Interchange /> : path.startsWith("/opening") ? <Opening /> : <App />), root!);
