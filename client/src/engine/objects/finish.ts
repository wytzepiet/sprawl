/** What a model's parts are made in; each finish a bucket of its own,
 *  drawn in its own coat (`finishes.ts`). Ground finishes lie flat, mapped
 *  by how far inside their outline (`kit.ts`'s `ground`). Here, apart from
 *  the kit, with what a shape and its coat must agree on: the kit's solids
 *  are a worker's (`modelsWorker.ts`), the coats the page's. */
export const FINISHES = ["matte", "zinc", "ribs", "tiles", "glass", "bark", "leaves", "rock", "gravel", "chips", "lawn", "paving", "earth", "dust"] as const;
export type Finish = (typeof FINISHES)[number];
export const FLAT: ReadonlySet<Finish> = new Set(["lawn", "paving", "earth", "dust"]);

/** How far out a heap's spill reaches, of its foot's reach. */
export const SPILL = 1.45;

/** Bark's texture goes once round a log and this many tiles along it. */
export const BARK_ALONG = 0.3;
