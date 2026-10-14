import { For } from "solid-js";
import { news } from "../state/sea";
import { setFollowing } from "../state/selection";

/**
 * A line across the top when something happens at a ramp, the ferry in,
 * with what it brought, the ferry gone, with what it took; or when the
 * town spends coins of its own accord: a box a rule bought, stone bought
 * express. Each on its own pane of glass, for a few seconds; a tap goes
 * there.
 */
export default function News() {
  return (
    <div class="pointer-events-none fixed top-6 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2 select-none">
      <For each={news()}>
        {(n) => (
          <button
            data-glass="toast"
            class="news ink pointer-events-auto flex items-center gap-3 rounded-full py-2 pl-2.5 pr-5 text-left cursor-pointer"
            onClick={() => setFollowing(n.at)}
          >
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white" style={{ background: n.coins ? "#B7791F" : "#2B6CA3" }}>
              {/* A ferry: the hull, the bridge; or a stack of coins. */}
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
                <path d={n.coins ? "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 9.5c0 1.7 3.6 3 8 3s8-1.3 8-3V12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 15.5c0 1.7 3.6 3 8 3s8-1.3 8-3V18c0 1.7-3.6 3-8 3s-8-1.3-8-3z" : "M2 14h20l-2.5 5.5h-15zM6 9h9v4H6zM8 5.5h4V9H8z"} />
              </svg>
            </span>
            <span class="leading-tight">
              <span class="block text-[14.5px] font-semibold">{n.text}</span>
              <span class="soft block text-[12px]">{n.sub}</span>
            </span>
          </button>
        )}
      </For>
    </div>
  );
}
