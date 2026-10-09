import { bakeCrowns } from "./crowns";

/** Bakes the trees' crowns off the main thread and hands their texels back. */
const texels = bakeCrowns();
postMessage(texels, { transfer: [texels.buffer] });
