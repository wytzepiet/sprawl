/* @refresh reload */
import { render } from "solid-js/web";

import App from "./App";
import Sandbox from "./sandbox/Sandbox";

const root = document.getElementById("root");

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  );
}

// The sandbox is the look alone, with no server: see `sandbox/Sandbox.tsx`.
render(() => (location.pathname.startsWith("/sandbox") ? <Sandbox /> : <App />), root!);
