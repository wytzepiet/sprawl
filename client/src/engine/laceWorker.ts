import { bakeLace } from "./lace";

/** Bakes the foam's lace off the main thread and hands its texels back. */
const texels = bakeLace();
postMessage(texels, { transfer: [texels.buffer] });
