/** @jsxImportSource ~ui */
import { createSignal, onCleanup, Show } from "solid-js";
import { BAD, Press, wide } from "./kit";

/** What a branch's preview was built from (`.github/workflows/preview.yml`);
 *  any other build has none, and never asks. */
const { VITE_REPO: REPO, VITE_BRANCH: BRANCH = "", VITE_SHA: SHA } = import.meta.env;
/** GitHub's answer is fresh for a minute; asked again after, it answers
 *  the browser's revalidation with a 304, which costs no rate limit. */
const EVERY_MS = 30_000;

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
      fetch(`https://api.github.com/repos/${REPO}/actions/workflows/preview.yml/runs?branch=${encodeURIComponent(BRANCH)}&event=push&per_page=1`)
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
