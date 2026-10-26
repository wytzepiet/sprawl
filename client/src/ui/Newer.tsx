/** @jsxImportSource ~ui */
import { createSignal, For, onCleanup, Show } from "solid-js";
import { BAD, Press, wide } from "./kit";

/** What a branch's preview was built from (`.github/workflows/preview.yml`);
 *  any other build has none, and never asks. */
const { VITE_REPO: REPO, VITE_BRANCH: BRANCH = "", VITE_SHA: SHA } = import.meta.env;
/** How often GitHub is asked. Its answer says fresh for a minute, but a
 *  build is over in less: it is asked past the cache every time, and an
 *  answer unchanged is a 304, which costs no rate limit. */
const EVERY_MS = 10_000;
/** One wave of the building dots, in ms. */
const WAVE_MS = 1200;

type Run = { head_sha: string; status: string; conclusion: string | null; display_title: string };

/**
 * On a branch's preview, a newer push to the branch, said at the top:
 * building, so what is on screen is about to be old; ready, with a
 * reload; or failed, so this is the last that built. Read from the
 * branch's latest preview run on GitHub.
 */
export default function Newer() {
  const [run, setRun] = createSignal<Run>();
  if (SHA) {
    const ask = () => {
      if (document.hidden) return;
      fetch(`https://api.github.com/repos/${REPO}/actions/workflows/preview.yml/runs?branch=${encodeURIComponent(BRANCH)}&event=push&per_page=1`, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : undefined))
        .then((r) => r?.workflow_runs[0] && setRun(r.workflow_runs[0]))
        .catch(() => {});
    };
    ask();
    const timer = setInterval(ask, EVERY_MS);
    onCleanup(() => clearInterval(timer));
  }
  const newer = () => {
    const r = run();
    return r && r.head_sha !== SHA && r.conclusion !== "cancelled" ? r : undefined;
  };
  return (
    <Show when={newer()}>
      {(r) => (
        <glass layer="newer" h={40} round={20} pad={{ left: 16, right: 4 }} dir="row" align="center" gap={10}>
          <Show when={r().status !== "completed"}>
            <Building />
          </Show>
          <text size={13} weight={600} ink={r().conclusion === "failure" ? BAD : "ink"}>
            {r().status !== "completed" ? "Newer version building" : r().conclusion === "success" ? "Newer version ready" : "Newer version failed to build"}
          </text>
          <Show when={wide()}>
            <text size={13} soft lines={1} w={240}>{r().display_title}</text>
          </Show>
          <Show when={r().conclusion === "success"} fallback={<box w={12} />}>
            <Press h={32} round={16} pad={{ x: 14 }} align="center" justify="center" fill="ink" onTap={() => location.reload()}>
              <text size={13} weight={600} ink="glass">Reload</text>
            </Press>
          </Show>
        </glass>
      )}
    </Show>
  );
}

/** Three dots, a wave running through them: still building. */
function Building() {
  const [t, set] = createSignal(0);
  let frame = requestAnimationFrame(function tick(now) {
    set((now % WAVE_MS) / WAVE_MS);
    frame = requestAnimationFrame(tick);
  });
  onCleanup(() => cancelAnimationFrame(frame));
  return (
    <box dir="row" gap={4} align="center">
      <For each={[0, 1, 2]}>
        {(i) => <box w={6} h={6} round={3} fill="ink" opacity={0.25 + 0.75 * Math.max(0, Math.sin(Math.PI * 2 * (t() - i / 6)))} />}
      </For>
    </box>
  );
}
