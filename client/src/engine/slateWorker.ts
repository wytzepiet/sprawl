import { bakeSlate } from "./slate";

/** Bakes the slate off the main thread and hands its texels back. */
const { texels } = bakeSlate();
postMessage(texels, { transfer: [texels.buffer] });
