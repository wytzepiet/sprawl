import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { launch } from "../../scripts/lib";
import { bindGroupLayouts, compose, type Composed, type Pass, type VertexLayout } from "./compose";
import { createPbrMaterial, markMaterialUboDirty, type OwnPbrMaterial } from "./material";

/**
 * Every material the client builds, made by the client's own code with the
 * renderer stubbed (`engine/gpu` answers anything with anything, and its
 * `createPbrMaterial` is ours), composed for every pass, and each module
 * built into a pipeline by Chromium's WebGPU (SwiftShader): zero errors.
 */

/** Anything: every field, call and `new` of it is another. */
const anything = (): any => {
  const own: Record<PropertyKey, unknown> = {};
  return new Proxy(function () {}, {
    get: (_, k) =>
      k === Symbol.toPrimitive ? () => 0 : k === "then" ? undefined : k === Symbol.iterator ? function* () {} : k in own ? own[k] : (own[k] = anything()),
    set: (_, k, v) => ((own[k] = v), true),
    apply: () => anything(),
    construct: () => anything(),
  });
};

const made: OwnPbrMaterial[] = [];
const gpu: Record<string, unknown> = {};
// Every name the engine takes from the renderer: what `engine/gpu.ts` and `render/index.ts` export.
for (const file of ["../engine/gpu.ts", "./index.ts"]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  for (const [, names] of source.matchAll(/export \{([^}]*)\} from/g)) for (const name of names!.split(",").map((n) => n.trim()).filter(Boolean)) gpu[name] = anything();
  for (const [, name] of source.matchAll(/export function (\w+)/g)) gpu[name!] = anything();
}
Object.assign(gpu, {
  createPbrMaterial: (props: Parameters<typeof createPbrMaterial>[0]) => {
    const m = createPbrMaterial(props);
    made.push(m);
    return m;
  },
  markMaterialUboDirty,
  wgsl: (s: TemplateStringsArray, ...v: unknown[]) => s.reduce((a, b, i) => a + String(v[i - 1]) + b),
});
mock.module("../engine/gpu", () => gpu);
mock.module("solid-js/jsx-dev-runtime", () => ({ jsxDEV: anything(), Fragment: anything() }));
globalThis.Worker = class extends EventTarget {
  postMessage() {}
} as never;
Object.assign(globalThis, { location: new URL("http://localhost/"), window: globalThis, document: anything(), requestAnimationFrame: () => 0, localStorage: anything() });

const ctx = anything();
ctx.beforeRender = () => () => {};

/** The client's materials, each made as the client makes it. */
async function build() {
  const { townMaterial, FLAT, CAST_ONLY } = await import("../engine/material");
  townMaterial([]);
  townMaterial([FLAT]);
  townMaterial([CAST_ONLY]);
  const { bevelPlugin, lacquer } = await import("../engine/bevel");
  lacquer(townMaterial([bevelPlugin()]), "rock");
  const { GroundTiles } = await import("../engine/ground");
  // Every kind of ground: every sheet of it.
  new GroundTiles(ctx.engine, ctx.scene, ctx.beforeRender, ctx.cull).set("0,0", [0, 0], new Uint8Array(36 * 36).map((_, k) => k % 7));
  const { waterMaterial } = await import("../engine/water");
  waterMaterial(ctx.engine, null, null);
  waterMaterial(ctx.engine, anything(), new Uint8Array(64));
  const { peakMaterial, cliffMaterial } = await import("../engine/peaks");
  peakMaterial(ctx.engine, new Uint16Array(64), [0, 0]);
  cliffMaterial(ctx.engine, new Uint8Array(64), null);
  cliffMaterial(ctx.engine, new Uint8Array(64), anything());
  const { TownLayer } = await import("../engine/TownLayer");
  const town = new TownLayer(ctx, anything(), () => {}, () => undefined, anything()) as any;
  const { kerbField } = await import("../engine/kerbs");
  const { WHITE } = await import("../engine/rgb");
  town.pavement(WHITE, null);
  town.pavement(WHITE, kerbField(ctx.engine, { half: 4, origin: [0, 0], size: [8, 8], texels: new Uint8Array(64) } as never));
  town.pieceMaterial("hedges", WHITE);
  const { plant, grove } = await import("../engine/trees");
  plant(ctx, grove("test", [0, 0], "broad"), new Float32Array(16), new Float32Array(4), undefined);
  plant(ctx, grove("test", [0, 0], "conifer"), new Float32Array(16), new Float32Array(4), undefined);
  const { placeProps } = await import("../engine/props");
  const { PROP_FLOATS } = await import("../engine/town/layer");
  placeProps(ctx, new Float32Array(PROP_FLOATS), [0, 0], undefined);
  const { InstancePool } = await import("../engine/InstancePool");
  const pool = new InstancePool(ctx.engine, ctx.scene, anything(), anything());
  const box = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1] };
  pool.ensureBucket("marker", box as never, WHITE, false, false);
  const { COATS } = await import("../engine/objects/finishes");
  for (const [k, coat] of Object.entries(COATS)) pool.ensureBucket(`coat_${k}`, box as never, WHITE, true, true, undefined, [coat(ctx)]);
  const { paint } = await import("../engine/objects/CarObject");
  paint(pool, "car", box as never, WHITE);
  const { keepField } = await import("../engine/objects/field");
  const tiles = [0, 1].flatMap((x) => [0, 1].map((y) => ({ at: { x, y }, stage: "Sown" as const, since: 0 })));
  keepField(ctx, anything(), 1, tiles, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], anything());
}

/** Two layouts that between them take every branch: vertex colours and no
 *  uvs; uvs and thin instances with colours. */
const LAYOUTS: VertexLayout[] = [
  { uv: false, colors: true, instances: false, instanceColors: false },
  { uv: true, colors: false, instances: true, instanceColors: true },
];
const PASSES: Pass[] = ["gbuffer", "shadow", "forward"];

test("every client material composes, and Chromium builds every pipeline", async () => {
  await build();
  const names = new Set(made.map((m) => m.plugins.map((p) => p.name).join("+")));
  console.log(`${made.length} materials, ${names.size} plugin lists:\n  ${[...names].join("\n  ")}`);
  for (const want of ["Ground turf", "Ground rock", "Ground beach", "Ground wash", "Water", "Basalt", "LandCliff", "Road", "Kerb", "Paving", "Tint", "Roof", "Windows", "Crown", "Card", "LampHead", "ModelGlass", "Field", "ClearCoat", "Flat", "CastOnly", "Bevel"])
    expect([...names].some((n) => n.split("+").includes(want))).toBe(true);

  // A plugin reading vertex colours is drawn only on meshes that have them,
  // and no mesh has more vertex buffers than a device takes (8, Lite's too).
  const composed = new Map<string, Composed>();
  for (const pass of PASSES) {
    const one = new Set(made.map((m) => compose(m, pass, LAYOUTS[0]!).key));
    for (const m of made)
      for (const layout of LAYOUTS) {
        const c = compose(m, pass, layout);
        if ((layout.colors || !c.code.includes("input.vColor")) && c.vertexBuffers.length <= 8) composed.set(c.key, c);
      }
    console.log(`${pass}: ${one.size} shader keys for one layout, ${[...composed.values()].filter((c) => c.pass === pass).length} over both`);
  }

  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.route("http://localhost:9/", (r) => r.fulfill({ body: "<!doctype html>", contentType: "text/html" }));
    await page.goto("http://localhost:9/");
    const all = [...composed.values()].map((c) => ({ key: c.key, code: c.code, vertexBuffers: c.vertexBuffers, layouts: bindGroupLayouts(c), pass: c.pass }));
    const errors: string[] = await page.evaluate(async (all) => {
      const device = await (await navigator.gpu.requestAdapter())!.requestDevice();
      const built = all.map(async (c) => {
        const module = device.createShaderModule({ code: c.code });
        const errors = (await module.getCompilationInfo()).messages
          .filter((m) => m.type === "error")
          .map((m) => `${c.key} ${m.lineNum}:${m.linePos} ${m.message}\n${c.code.split("\n")[m.lineNum - 1]}`);
        const targets: GPUColorTargetState[] = c.pass === "gbuffer" ? [0, 1, 2].map(() => ({ format: "rgba8unorm" })) : c.pass === "forward" ? [{ format: "bgra8unorm" }] : [];
        device.pushErrorScope("validation");
        const layout = device.createPipelineLayout({ bindGroupLayouts: c.layouts.map((l) => device.createBindGroupLayout(l)) });
        const scope = device.popErrorScope();
        await device
          .createRenderPipelineAsync({
            layout,
            vertex: { module, entryPoint: "vs", buffers: c.vertexBuffers },
            fragment: { module, entryPoint: "fs", targets },
            depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "greater" },
          })
          .catch((e: Error) => errors.push(`${c.key} ${e.message}`));
        const e = await scope;
        if (e) errors.push(`${c.key} ${e.message}`);
        return errors;
      });
      return (await Promise.all(built)).flat();
    }, all);
    console.log(`${all.length} pipelines built`);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
