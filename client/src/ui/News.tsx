import { For } from "solid-js";
import { news } from "../state/sea";
import { setFollowing } from "../state/selection";

/**
 * A line across the top when something happens at a ramp: the ferry in,
 * with what it brought; the ferry gone, with what it took. Each on its own
 * pane of glass, for a few seconds; a tap goes there.
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
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white" style={{ background: "#2B6CA3" }}>
              {/* A ferry: the hull, the bridge. */}
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M2 14h20l-2.5 5.5h-15zM6 9h9v4H6zM8 5.5h4V9H8z" /></svg>
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
