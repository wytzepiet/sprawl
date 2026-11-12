import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";

/** The page served so the bench (`engine/PerfReport.tsx`) may sample its
 *  own JavaScript, which the browser allows only when the page asks. */
const profiling: Plugin = {
  name: "js-profiling",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Document-Policy", "js-profiling");
      next();
    });
  },
};

// A second stack can stand beside the game's — the fixture shots run on one —
// so both ports come from the environment, defaulting to the game's.
const port = Number(process.env.SPRAWL_CLIENT_PORT ?? 4800);
const server = `localhost:${process.env.SPRAWL_PORT ?? 4801}`;

export default defineConfig({
  // No hot swapping: an edit reloads the page. Solid's refresh remounts the
  // component an edit touched, and here nearly every component hangs off the
  // engine, its scene, the socket or a store made once at load — a remount
  // tears the engine down under the rest, or builds on state the swap left
  // behind, and the game goes blank. A reload costs a second and is always
  // right; the server holds the game, so the page comes back as it was.
  plugins: [solidPlugin({ hot: false }), profiling],
  // Workers as modules, as they are started: the models' awaits its solids' wasm as it loads.
  worker: { format: "es" },
  resolve: {
    alias: [
      // The UI's ink (`ui/`): what the cards are made of, knowing nothing of the game.
      { find: /^~ui$/, replacement: fileURLToPath(new URL("./ui/index.tsx", import.meta.url)) },
    ],
  },
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
      "/town": { target: `http://${server}` },
      "/perf": { target: `http://${server}` },
    },
  },
  // Manifold finds its wasm beside its script (`new URL(…, import.meta.url)`),
  // which pre-bundling would move away from it.
  optimizeDeps: { exclude: ["manifold-3d"], esbuildOptions: { target: "esnext" } },
  build: {
    target: "esnext",
  },
});
