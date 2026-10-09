import { bakeRipples } from "./ripples";

/** Bakes the sand's ripples off the main thread and hands their texels back. */
const texels = bakeRipples();
postMessage(texels, { transfer: [texels.buffer] });
