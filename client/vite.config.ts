import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 3000,
    // The client derives its socket URL from location.host, so the dev server
    // has to forward /ws to the game server or it dials itself.
    proxy: {
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    target: "esnext",
    rolldownOptions: {},
  },
  dev: {},
});
