import { useDayNight } from "../engine/DayNightCycle";

function timeLabel(t: number): string {
  const hours = Math.floor(t * 24);
  const minutes = Math.floor((t * 24 - hours) * 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export default function TimeSlider() {
  const { timeOfDay, setTimeOfDay, paused, setPaused } = useDayNight();

  return (
    <div class="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-xl bg-white/70 backdrop-blur-xl border border-black/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
      <button
        onClick={() => setPaused(!paused())}
        class="text-xs font-semibold tracking-wide uppercase text-stone-500 hover:text-stone-800 transition-colors cursor-pointer w-6"
        title={paused() ? "Play" : "Pause"}
      >
        {paused() ? "\u25B6" : "\u2759\u2759"}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={timeOfDay()}
        onInput={(e) => {
          setPaused(true);
          setTimeOfDay(parseFloat(e.currentTarget.value));
        }}
        class="w-40 accent-stone-500 cursor-pointer"
      />
      <span class="text-xs font-mono text-stone-500 w-10">{timeLabel(timeOfDay())}</span>
    </div>
  );
}
