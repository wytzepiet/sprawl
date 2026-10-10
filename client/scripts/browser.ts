import { chromium } from "playwright-core";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

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
export const launch = () =>
  existsSync(SOFTWARE)
    ? chromium.launch({
        executablePath: SOFTWARE,
        args: process.env.GPU_ARGS?.split(" ") ?? ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
        env: { ...process.env, VK_ICD_FILENAMES: `${dirname(realpathSync(SOFTWARE))}/vk_swiftshader_icd.json` },
      })
    : chromium.launch({ channel: "chrome", args: ["--enable-unsafe-webgpu"] });

/**
 * A page of it, the canvas configured so the glass can copy from it: the
 * Lite fork checked out here may lack `copySource`, and without it the
 * UI's glass draws nothing behind the cards. Only for photographs.
 */
export async function open(browser: Awaited<ReturnType<typeof launch>>, viewport: { width: number; height: number }) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(() => {
    const configure = GPUCanvasContext.prototype.configure;
    GPUCanvasContext.prototype.configure = function (c: GPUCanvasConfiguration) {
      return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC });
    };
  });
  return page;
}
