import type { Bevelled } from "../creases";
import type { Finish, ModelProp } from "./kit";
import { perfMark } from "../PerfReport";

/** A building's model asked of the worker that makes them
 *  (`modelsWorker.ts`): by name, its loading bay notched (`kit.ts`), and
 *  which way round. */
export interface Ask { name: string; notch: [number, number, number] | null; side: 1 | -1 }
/** And as it comes back: each finish's shape, its creases found, its
 *  props and its trees. */
export interface Made { finishes: [Finish, Bevelled][]; side: 1 | -1; props: ModelProp[]; trees: [number, number, number][] }

/** The worker, started with the page and had once it says it is ready:
 *  its solids' wasm takes seconds to load on a phone, and what is asked
 *  before then is not heard. */
const worker = new Promise<Worker>((ready) => {
  const w = new Worker(new URL("./modelsWorker.ts", import.meta.url), { type: "module" });
  w.onerror = (e) => console.error("models worker:", e.message);
  w.onmessage = ({ data }: MessageEvent<Made | "ready">) => (data === "ready" ? ready(w) : waiting.shift()!(data));
});
const asked = new Map<string, Promise<Made>>();
const waiting: ((made: Made) => void)[] = [];

/** A model, made once: the worker answers in the order it is asked. */
export function modelOf(ask: Ask): Promise<Made> {
  const key = JSON.stringify(ask);
  if (!asked.has(key)) {
    perfMark("model asked");
    asked.set(key, new Promise((done) => waiting.push((made) => (perfMark("model in"), done(made)))));
    void worker.then((w) => w.postMessage(ask));
  }
  return asked.get(key)!;
}
