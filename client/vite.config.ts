import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 4800,
    // Fail rather than wander. Vite's default is to take the next free port,
    // which lands it on the game server's — and then you are debugging a page
    // that is not the one you think.
    strictPort: true,
    // The client derives its socket URL from location.host, so the dev server
    // has to forward /ws to the game server or it dials itself.
    proxy: {
      "/ws": { target: "ws://localhost:4801", ws: true },
      "/tree": { target: "http://localhost:4801" },
    },
  },
  build: {
    target: "esnext",
    rolldownOptions: {},
  },
  dev: {},
});
