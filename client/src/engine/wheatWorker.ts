import { bakeWheat } from "./wheat";

/** Bakes the wheat's stages off the main thread and hands their texels back. */
const texels = bakeWheat();
postMessage(texels, { transfer: [texels.buffer] });
