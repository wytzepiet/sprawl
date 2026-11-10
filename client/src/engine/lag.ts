/**
 * `?lag`: how long a stroke of the pen takes to show, step by step, on the
 * screen's corner: from the hand's first move to the pen's guess, the town
 * touched, its asphalt laid, the worker's paving landed, and each picture
 * shown after. A trial's measure, to be taken out with what it finds.
 */
const ON = new URLSearchParams(globalThis.location?.search ?? "").has("lag");
let start = 0;
let marks: string[] = [];
let timer = 0;
let box: HTMLDivElement | null = null;

/** The hand moved: a stroke begins, unless one is being timed. */
export function lagStart() {
  if (ON && !start) [start, marks] = [performance.now(), []];
}

/** A step of the stroke, the first of its name (or every one, `again`). */
export function lag(name: string, again = false) {
  if (!ON || !start) return;
  if (!again && marks.some((m) => m.startsWith(`${name} `))) return;
  marks.push(`${name} ${Math.round(performance.now() - start)}`);
  clearTimeout(timer);
  timer = setTimeout(show, 800) as unknown as number;
}

function show() {
  if (!box) {
    box = document.createElement("div");
    box.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:9999;font:12px monospace;color:#fff;background:#000c;padding:6px 8px;border-radius:6px;pointer-events:none";
    document.body.append(box);
  }
  box.textContent = `ms: ${marks.join(" · ")}`;
  console.log("[lag]", marks.join(" · "));
  start = 0;
}
