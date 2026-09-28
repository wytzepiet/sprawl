import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

// A second stack can stand beside the game's — the fixture shots run on one —
// so both ports come from the environment, defaulting to the game's.
const port = Number(process.env.SPRAWL_CLIENT_PORT ?? 4800);
const server = `localhost:${process.env.SPRAWL_PORT ?? 4801}`;

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port,
    // Fail rather than wander. Vite's default is to take the next free port,
    // which lands it on the game server's — and then you are debugging a page
    // that is not the one you think.
    strictPort: true,
    // The sandbox reads the fixtures from the server's side of the repo.
    fs: { allow: [".."] },
    // The client derives its socket URL from location.host, so the dev server
    // has to forward /ws to the game server or it dials itself.
    proxy: {
      "/ws": { target: `ws://${server}`, ws: true },
      "/tree": { target: `http://${server}` },
      "/inspect": { target: `http://${server}` },
      "/town": { target: `http://${server}` },
      "/site": { target: `http://${server}` },
    },
  },
  build: {
    target: "esnext",
    rolldownOptions: {},
  },
  dev: {},
});
