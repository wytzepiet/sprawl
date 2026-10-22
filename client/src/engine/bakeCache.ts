import { createTexture2DFromPixels, updateTexture2DFromPixels, type EngineContext, type Texture2D } from "@babylonjs/lite";
import type { Bake } from "./bakeWorker";

type TextureOptions = Parameters<typeof createTexture2DFromPixels>[4];

/**
 * What is baked at load, kept between loads in the browser's own storage
 * (IndexedDB), deflated: baked once, then read back, with no worker asked. Each is kept
 * under its name with the version it was baked by, a hash of its recipe's
 * source, so a change to the recipe, a knob or all, bakes it anew. Storage
 * the browser will not give (a private window, a full disk) only means
 * baking every time, as before.
 */

const DB = "sprawl-bakes";
const STORE = "bakes";

/** A string's hash, FNV-1a, in hex: the version a recipe's source gives. */
function versionOf(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function open(): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => done(req.result);
    req.onerror = () => fail(req.error);
  });
}

/** What the bake worker bakes of that name (`bakeWorker.ts`), a worker
 *  each, so bakes run side by side; kept under the name by its recipe's
 *  source. */
function baked(name: Bake, recipe: string): Promise<Uint8Array> {
  return cached(name, versionOf(recipe), () => new Promise((done) => {
    const w = new Worker(new URL("./bakeWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<Uint8Array>) => (w.terminate(), done(data));
    w.postMessage(name);
  }));
}

/** Each engine's texture of each bake, and when it has its texels. */
const TEXTURES = new Map<Bake, WeakMap<EngineContext, { texture: Texture2D; ready: Promise<void> }>>();

/** An engine's texture of a bake, made once: `placeholder`, `width` by
 *  `height`, until the worker has baked it or it is read back from the
 *  last bake. */
export function bakedTexture(engine: EngineContext, name: Bake, recipe: string, [width, height, placeholder]: [number, number, Uint8Array], options: TextureOptions): Texture2D {
  const made = TEXTURES.get(name) ?? TEXTURES.set(name, new WeakMap()).get(name)!;
  let it = made.get(engine);
  if (!it) {
    const texture = createTexture2DFromPixels(engine, placeholder, width, height, options);
    it = { texture, ready: baked(name, recipe).then((data) => updateTexture2DFromPixels(engine, texture, data)) };
    made.set(engine, it);
  }
  return it.texture;
}

/** When an engine's texture of a bake has its texels: at once if it was
 *  never asked for. */
export const whenBaked = (engine: EngineContext, name: Bake): Promise<void> => TEXTURES.get(name)?.get(engine)?.ready ?? Promise.resolve();

async function squeeze(data: Uint8Array, how: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(how)).arrayBuffer());
}

/** What `bake` makes, from storage if it holds this version, else baked,
 *  handed back, and stored after. */
async function cached(name: string, version: string, bake: () => Promise<Uint8Array>): Promise<Uint8Array> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    const kept = await new Promise<{ version: string; data: Uint8Array } | undefined>((done, fail) => {
      const req = db!.transaction(STORE).objectStore(STORE).get(name);
      req.onsuccess = () => done(req.result);
      req.onerror = () => fail(req.error);
    });
    if (kept?.version === version) return await squeeze(kept.data, new DecompressionStream("deflate"));
  } catch {
    // No storage, or nothing in it: bake.
  }
  const made = await bake();
  if (db) {
    const store = db;
    // Not kept, if it fails: baked again next time.
    void squeeze(made, new CompressionStream("deflate"))
      .then((data) => store.transaction(STORE, "readwrite").objectStore(STORE).put({ version, data }, name))
      .catch(() => {});
  }
  return made;
}
