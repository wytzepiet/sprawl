/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";

import App from "./App";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

// The sandbox is the look alone, with no server: see `sandbox/Sandbox.tsx`.
// Loaded only there.
const Sandbox = lazy(() => import("./sandbox/Sandbox"));
render(() => (location.pathname.startsWith("/sandbox") ? <Sandbox /> : <App />), root!);
