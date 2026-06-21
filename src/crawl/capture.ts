import { chromium } from "playwright";
import type { Page } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../shared/config";
import type { Manifest, RouteNode, StateNode, Device, ShotRef } from "../shared/types";
import { pathSlug, stateSlug } from "../shared/slug";
import { applyContextInit, stabilizePage } from "./stabilize";
import { makeThumb, imageSize, writeFull } from "./thumbnails";
import { applyRecipe, resolveUrl } from "./recipe";
import { mapPool, sleep } from "../shared/pool";

export interface CaptureOptions {
  config: Config;
  manifest: Manifest; // routes/states/recipes in; shots filled in place
  baseUrl: string;
  runDir: string;
  storageState?: string;
  log?: (msg: string) => void;
}

export interface CaptureResult {
  manifest: Manifest;
  shots: number;
  durationMs: number;
}

interface StateCtx {
  route: RouteNode;
  state: StateNode;
  device: Device;
  baseUrl: string;
  shotsDir: string;
  runDir: string;
  config: Config;
}

async function captureState(page: Page, ctx: StateCtx): Promise<ShotRef> {
  const { route, state, device, baseUrl, shotsDir, runDir, config } = ctx;
  const rel = (p: string) => path.relative(runDir, p).split(path.sep).join("/");

  // Navigate by the (relative) route path resolved against the *current* base, not a
  // stored absolute finalUrl — that keeps a cached site model portable across runs/hosts.
  const url = resolveUrl(baseUrl, route.url);
  const resp = await page.goto(url, { waitUntil: config.stabilize.waitStrategy });
  if (resp && route.status === undefined) route.status = resp.status();
  if (!route.finalUrl) route.finalUrl = page.url();
  if (!route.title) route.title = await page.title().catch(() => undefined);

  await applyRecipe(page, state.recipe);
  await stabilizePage(page, config.stabilize);

  const dir = path.join(shotsDir, pathSlug(route.url), stateSlug(state.id));
  await fs.mkdir(dir, { recursive: true });

  const ext = config.screenshot.format;
  const shotType = ext === "jpeg" ? "jpeg" : "png";
  const mask = config.stabilize.maskSelectors.map((s) => page.locator(s));

  const fullPath = path.join(dir, `${device.name}.${ext}`);
  const thumbPath = path.join(dir, `${device.name}.thumb.${config.screenshot.thumbnail.format}`);
  const metaPath = path.join(dir, `${device.name}.json`);

  const buf = await page.screenshot({
    fullPage: config.screenshot.fullPage,
    mask: mask.length ? mask : undefined,
    type: shotType,
    quality: shotType === "jpeg" ? config.screenshot.quality : undefined,
  });

  await writeFull(buf, fullPath, ext, config.screenshot.quality);
  await makeThumb(buf, thumbPath, config.screenshot.thumbnail);
  const dims = await imageSize(buf);

  const ref: ShotRef = {
    full: rel(fullPath),
    thumb: rel(thumbPath),
    meta: rel(metaPath),
    width: dims.width,
    height: dims.height,
  };

  if (config.screenshot.alsoViewport) {
    const viewportPath = path.join(dir, `${device.name}.viewport.${ext}`);
    const vbuf = await page.screenshot({
      fullPage: false,
      mask: mask.length ? mask : undefined,
      type: shotType,
      quality: shotType === "jpeg" ? config.screenshot.quality : undefined,
    });
    await writeFull(vbuf, viewportPath, ext, config.screenshot.quality);
    ref.viewport = rel(viewportPath);
  }

  const sidecar = {
    route: route.id,
    routeUrl: route.url,
    state: state.id,
    stateLabel: state.label,
    stateKind: state.kind,
    device: device.name,
    url: page.url(),
    viewport: { width: device.width, height: device.height, dpr: device.dpr },
    shot: ref,
    capturedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(sidecar, null, 2));

  return ref;
}

export async function runCapture(opts: CaptureOptions): Promise<CaptureResult> {
  const { config, manifest, baseUrl, runDir } = opts;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const shotsDir = path.join(runDir, "screenshots");
  await fs.mkdir(shotsDir, { recursive: true });

  const browser = await chromium.launch();
  let shotCount = 0;

  try {
    for (const device of config.devices) {
      log(`▸ ${device.name} (${device.width}×${device.height} @${device.dpr})`);
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.dpr,
        isMobile: device.mobile ?? false,
        hasTouch: device.touch ?? device.mobile ?? false,
        userAgent: device.userAgent,
        storageState: opts.storageState,
      });
      context.setDefaultTimeout(config.politeness.timeoutMs);
      await applyContextInit(context, config.stabilize);

      const tasks: { route: RouteNode; state: StateNode }[] = [];
      for (const route of manifest.routes) for (const state of route.states) tasks.push({ route, state });

      await mapPool(tasks, config.politeness.concurrency, async ({ route, state }) => {
        const page = await context.newPage();
        try {
          const ref = await captureState(page, { route, state, device, baseUrl, shotsDir, runDir, config });
          state.shots[device.name] = ref;
          shotCount++;
          log(`  ✓ ${pathSlug(route.url)} / ${state.id}`);
        } catch (e) {
          log(`  ✗ ${pathSlug(route.url)} / ${state.id} [${device.name}]: ${(e as Error).message.split("\n")[0]}`);
        } finally {
          await page.close().catch(() => {});
          await sleep(config.politeness.minDelayMs);
        }
      });

      await context.close();
    }
  } finally {
    await browser.close();
  }

  manifest.stats = {
    routes: manifest.routes.length,
    states: manifest.routes.reduce((n, r) => n + r.states.length, 0),
    shots: shotCount,
    durationMs: Date.now() - started,
  };

  return { manifest, shots: shotCount, durationMs: manifest.stats.durationMs };
}
