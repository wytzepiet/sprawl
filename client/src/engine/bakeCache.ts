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
export function versionOf(source: string): string {
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

/** What a worker bakes (made by `worker`, written `new Worker(new URL(…))`
 *  where it is called, as Vite bundles a worker only so; it hands its
 *  texels back), kept under `name` by its recipe's source. */
export function baked(name: string, recipe: string, worker: () => Worker): Promise<Uint8Array> {
  return cached(name, versionOf(recipe), () => new Promise((done) => {
    const w = worker();
    w.onmessage = ({ data }: MessageEvent<Uint8Array>) => (w.terminate(), done(data));
  }));
}

async function squeeze(data: Uint8Array, how: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(how)).arrayBuffer());
}

/** What `bake` makes, from storage if it holds this version, else baked,
 *  handed back, and stored after. */
export async function cached(name: string, version: string, bake: () => Promise<Uint8Array>): Promise<Uint8Array> {
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
