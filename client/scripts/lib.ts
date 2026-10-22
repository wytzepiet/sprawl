import type { Page } from "playwright-core";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What the scripts share: where the repo is, where the game answers,
 *  their flags, a browser and a contact sheet. */

export const ROOT = resolve(import.meta.dir, "../..");
/** The dev client, the one `bun run dev` runs, or SPRAWL_CLIENT_PORT's. */
export const CLIENT = `http://localhost:${process.env.SPRAWL_CLIENT_PORT ?? 4800}`;
/** The dev server's port, or SPRAWL_PORT's. */
export const PORT = Number(process.env.SPRAWL_PORT ?? 4801);

/** The command line; each flag read is taken out of it, so what is left
 *  is the words given in order. */
export const args = process.argv.slice(2);
/** `--name value`, its value; undefined if it is not given. */
export const word = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
/** `--name 3`, as a number, or `or`. */
export const flag = (name: string, or: number) => Number(word(name) ?? or);
/** `--name`, alone: whether it is given. */
export const has = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 && !!args.splice(i, 1);
};

/** Playwright's Chromium, where a cloud container has it. */
const SOFTWARE = process.env.CHROME ?? "/opt/pw-browsers/chromium";

/**
 * A browser that draws the game, which is WebGPU only: desktop Chrome on
 * the machine's GPU; or, without it (a cloud container), the Chromium
 * CHROME names or Playwright's, its WebGPU run in software by SwiftShader.
 * Its own Vulkan is SwiftShader's too, named to it, or the canvas cannot
 * show what WebGPU drew and the device is lost on the first frame. Slow,
 * but the same picture.
 */
export const launch = async () => {
  const { chromium } = await import("playwright-core");
  return existsSync(SOFTWARE)
    ? chromium.launch({
        executablePath: SOFTWARE,
        args: process.env.GPU_ARGS?.split(" ") ?? ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
        env: { ...process.env, VK_ICD_FILENAMES: `${dirname(realpathSync(SOFTWARE))}/vk_swiftshader_icd.json` },
      })
    : chromium.launch({ channel: "chrome", args: ["--enable-unsafe-webgpu"] });
};

/**
 * A page of it, the canvas configured so the glass can copy from it: the
 * Lite fork checked out here may lack `copySource`, and without it the
 * UI's glass draws nothing behind the cards. Only for photographs.
 */
export async function open(browser: Awaited<ReturnType<typeof launch>>, viewport: { width: number; height: number }) {
  // `DPR=3` for a phone's screen.
  const page = await browser.newPage({ viewport, deviceScaleFactor: Number(process.env.DPR ?? 1) });
  await page.addInitScript(() => {
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function (c: GPUCanvasConfiguration) {
      return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC });
    };
  });
  return page;
}

/** A contact sheet: each cell (a `<figure>`, its picture and caption) on
 *  one page, `columns` across, photographed whole to `path`. */
export async function sheet(page: Page, cells: string[], columns: number, path: string) {
  await page.setViewportSize({ width: 1800, height: 800 });
  await page.setContent(`<style>
    body { margin: 16px; font: 13px system-ui; background: #fff; }
    main { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 16px; align-items: start; }
    figure { margin: 0; } img, svg { width: 100%; height: auto; display: block; border-radius: 4px; }
    figcaption { padding: 4px 2px; color: #444; }
  </style><main>${cells.join("")}</main>`);
  await page.waitForLoadState("load");
  await page.screenshot({ path, fullPage: true });
}
