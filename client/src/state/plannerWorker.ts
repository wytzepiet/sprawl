import init, { Planner } from "../wasm/sprawl_web.js";

/** The game's road planner off the main thread (`planner.ts`): a world
 *  made again for each drag costs a big town some milliseconds. */
let planner: Planner | null = null;
const early: MessageEvent[] = [];
let preparing = 0;

const handle = ({ data }: MessageEvent) => {
  if (!planner) return void early.push({ data } as MessageEvent);
  if (data.hear) {
    planner.hear(data.hear);
    // Ready for the next drag once the line is quiet.
    clearTimeout(preparing);
    preparing = setTimeout(() => planner!.prepare(), 100) as unknown as number;
  } else if (data.draw) postMessage({ laid: planner.draw(data.draw) });
  else if (data.reach) postMessage({ asked: data.asked, hint: planner.reach(data.reach) });
};
onmessage = handle;

void init().then(() => {
  planner = new Planner();
  for (const e of early.splice(0)) handle(e);
  postMessage({ ready: true });
});
