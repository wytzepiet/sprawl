import { appendFileSync, mkdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import solidPlugin from "vite-plugin-solid";

/**
 * What a player's tab reports of how it draws (`engine/PerfReport.tsx`),
 * appended to `.dev/perf.jsonl` a line a report, so its frames can be read
 * from outside it. And the page served so the tab may sample its own
 * JavaScript, which the browser allows only when the page asks.
 */
function perfLog(): Plugin {
  const file = new URL("../.dev/perf.jsonl", import.meta.url);
  return {
    name: "perf-log",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader("Document-Policy", "js-profiling");
        if (req.method !== "POST" || req.url !== "/__perf") return next();
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          mkdirSync(new URL(".", file), { recursive: true });
          appendFileSync(file, body.replace(/\n/g, " ") + "\n");
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// A second stack can stand beside the game's — the fixture shots run on one —
// so both ports come from the environment, defaulting to the game's.
const port = Number(process.env.SPRAWL_CLIENT_PORT ?? 4800);
const server = `localhost:${process.env.SPRAWL_PORT ?? 4801}`;

export default defineConfig({
  plugins: [solidPlugin(), perfLog()],
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
    },
  },
  build: {
    target: "esnext",
    rolldownOptions: {},
  },
  dev: {},
});
