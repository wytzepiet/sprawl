import { bakeCrowns } from "./crowns";

/** The broadleaves grown off the main thread, and their shapes handed
 *  back (`broadleaves.ts`). */
const shapes = bakeCrowns();
postMessage(shapes, { transfer: [shapes.buffer] });
