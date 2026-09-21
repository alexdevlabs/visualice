import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../shared/config";
import type {
  Manifest,
  RouteNode,
  StateNode,
  Device,
  RecipeStep,
  ShotRef,
  CaptureFailure,
} from "../shared/types";
import { pathSlug, stateSlug } from "../shared/slug";
import { applyContextInit, stabilizePage } from "./stabilize";
import { makeThumb, imageSize, writeFull, writeViewportCrop } from "./thumbnails";
import { applyRecipe, gotoRoute, resolveUrl } from "./recipe";
import { httpContextOptions } from "./context-options";
import { createProgress } from "../shared/progress";
import { pathExists } from "../shared/fsx";
import { mapPoolWithResource, sleep } from "../shared/pool";

export interface CaptureOptions {
  config: Config;
  manifest: Manifest; // routes/states/recipes in; shots filled in place
  baseUrl: string;
  runDir: string;
  storageState?: string;
  /** Reuse shots already present in `runDir` instead of recapturing them. */
  resume?: boolean;
  log?: (msg: string) => void;
}

export interface CaptureResult {
  manifest: Manifest;
  shots: number;
  failures: CaptureFailure[];
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
  log?: (msg: string) => void;
}

/**
 * What a reused page is currently showing: the URL it last loaded and the recipe
 * that was applied on top of it. `undefined` means "unknown" — a fresh or recycled
 * page, which must navigate.
 */
export interface PageState {
  url?: string;
  recipe?: RecipeStep[];
}

/**
 * The steps still to run for `recipe` given what the page already shows, or `null`
 * if it has to be reloaded first.
 *
 * Every state resets the DOM by navigating, which is why page reuse on its own
 * bought nothing: the cost was never the page lifecycle, it was the reload. But a
 * reload is only needed when the page is showing something the next recipe doesn't
 * build on. A state whose recipe *extends* what's on screen — anything captured
 * straight after the route's default render, and every nested state captured after
 * its parent — can run its remaining steps where the page already is.
 *
 * The prefix has to match exactly, step for step: a recipe that diverges reaches a
 * page its later steps were never recorded against.
 */
export function reusePlan(
  shown: PageState,
  url: string,
  recipe: RecipeStep[],
): RecipeStep[] | null {
  if (shown.url !== url || !shown.recipe) return null;
  if (shown.recipe.length >= recipe.length) return null;
  for (let i = 0; i < shown.recipe.length; i++) {
    if (JSON.stringify(shown.recipe[i]) !== JSON.stringify(recipe[i])) return null;
  }
  return recipe.slice(shown.recipe.length);
}

/**
 * Order a route's states so each one follows a state its recipe extends, where such
 * a state exists — which is what gives `reusePlan` something to reuse.
 *
 * The manifest's own order groups states by the depth they were discovered at, so a
 * nested state sits several entries away from the parent it was recorded through.
 * Greedily preferring the longest shared prefix puts them back together. Ties keep
 * manifest order, so the result is deterministic and a flat route (no nesting)
 * comes back unchanged.
 */
export function orderForReuse(states: StateNode[]): StateNode[] {
  const shared = (a: RecipeStep[], b: RecipeStep[]): number => {
    let n = 0;
    while (n < a.length && n < b.length && JSON.stringify(a[n]) === JSON.stringify(b[n])) n++;
    return n;
  };
  const remaining = [...states];
  const out: StateNode[] = [];
  let previous: RecipeStep[] = [];
  while (remaining.length) {
    let best = 0;
    let bestUsable = -1;
    let bestLength = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      // Only a *full* prefix of the candidate counts: a partial overlap still needs
      // a reload, so it is worth nothing here.
      const recipe = remaining[i].recipe;
      const usable = shared(previous, recipe) === previous.length ? previous.length : -1;
      // Among the states that can follow, take the shallowest. Walking the chain a
      // step at a time keeps each state reachable from the one before it; jumping
      // straight to the deepest would strand the steps in between.
      if (usable > bestUsable || (usable === bestUsable && recipe.length < bestLength)) {
        bestUsable = usable;
        bestLength = recipe.length;
        best = i;
      }
    }
    const [next] = remaining.splice(best, 1);
    out.push(next);
    previous = next.recipe;
  }
  return out;
}

/**
 * Full-page screenshots of an infinite-scroll page have no natural end: the shot
 * grows until Playwright or sharp runs out of memory. Above `screenshot.maxHeight`
 * the capture is clipped to the top of the page and flagged, so the run produces a
 * usable (if partial) image instead of dying.
 */
async function fullPageClip(
  page: Page,
  maxHeight: number,
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  if (maxHeight <= 0) return undefined;
  const dims = await page
    .evaluate(() => {
      const el = document.scrollingElement || document.documentElement;
      return { height: el.scrollHeight, width: el.scrollWidth };
    })
    .catch(() => undefined);
  if (!dims || dims.height <= maxHeight) return undefined;
  const width = Math.max(1, Math.min(dims.width, page.viewportSize()?.width ?? dims.width));
  return { x: 0, y: 0, width, height: maxHeight };
}

/**
 * A shot from an interrupted run, if it's already on disk.
 *
 * Resuming reads the sidecar rather than re-deriving the ShotRef: the sidecar is
 * written last, after every image, so its presence is what proves the shot
 * finished. A half-written PNG from a kill mid-capture has no sidecar and is
 * simply recaptured.
 */
async function adoptExistingShot(ctx: StateCtx): Promise<ShotRef | undefined> {
  const { route, state, device, shotsDir, runDir } = ctx;
  const dir = path.join(shotsDir, pathSlug(route.url), stateSlug(state.id));
  const metaPath = path.join(dir, `${device.name}.json`);
  const raw = await fs.readFile(metaPath, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const sidecar = JSON.parse(raw) as { shot?: ShotRef };
    const ref = sidecar.shot;
    if (!ref?.full) return undefined;
    // The sidecar points at the image by a run-relative path; make sure it's there.
    if (!(await pathExists(path.join(runDir, ref.full)))) return undefined;
    return ref;
  } catch {
    return undefined;
  }
}

/** A captured shot, plus whether taking it managed to skip the route's reload. */
interface Captured {
  ref: ShotRef;
  reusedNavigation: boolean;
}

async function captureState(page: Page, ctx: StateCtx, shown: PageState): Promise<Captured> {
  const { route, state, device, baseUrl, shotsDir, runDir, config } = ctx;
  const rel = (p: string) => path.relative(runDir, p).split(path.sep).join("/");

  // Navigate by the (relative) route path resolved against the *current* base, not a
  // stored absolute finalUrl — that keeps a cached site model portable across runs/hosts.
  const url = resolveUrl(baseUrl, route.url);
  const remaining = config.politeness.reuseNavigation ? reusePlan(shown, url, state.recipe) : null;

  // From here on the page is being changed, so what it shows is unknown until the
  // recipe finishes — a step that throws half way must not leave a stale claim
  // behind for the next state to trust.
  shown.url = undefined;
  shown.recipe = undefined;

  if (remaining === null) {
    const resp = await gotoRoute(page, url, config.stabilize.waitStrategy);
    if (resp && route.status === undefined) route.status = resp.status();
    if (!route.finalUrl) route.finalUrl = page.url();
    if (!route.title) route.title = await page.title().catch(() => undefined);

    // A reused page keeps the pointer wherever the previous state left it, and the
    // browser re-applies `:hover` at that position to the newly loaded document — a
    // phantom hover painted into an unrelated screenshot. Park it off-viewport before
    // the recipe runs; a recipe that *wants* a hover state moves the pointer itself.
    // Only after a navigation: when the page is kept, the pointer is part of the
    // state being extended, and parking it would close a hover-opened menu.
    await page.mouse.move(-1, -1).catch(() => {});
  }

  await applyRecipe(page, remaining ?? state.recipe);
  await stabilizePage(page, config.stabilize, ctx.log);
  shown.url = url;
  shown.recipe = state.recipe;

  const dir = path.join(shotsDir, pathSlug(route.url), stateSlug(state.id));
  await fs.mkdir(dir, { recursive: true });

  const ext = config.screenshot.format;
  const shotType = ext === "jpeg" ? "jpeg" : "png";
  const mask = config.stabilize.maskSelectors.map((s) => page.locator(s));

  const thumbExt = config.screenshot.thumbnail.format;
  const fullPath = path.join(dir, `${device.name}.${ext}`);
  const thumbPath = path.join(dir, `${device.name}.thumb.${thumbExt}`);
  const midPath = path.join(dir, `${device.name}.mid.${thumbExt}`);
  const metaPath = path.join(dir, `${device.name}.json`);

  const clip = config.screenshot.fullPage
    ? await fullPageClip(page, config.screenshot.maxHeight)
    : undefined;

  const buf = await page.screenshot({
    // `clip` alone is bounded by the viewport; it only reaches further down the
    // page when fullPage is set too.
    fullPage: config.screenshot.fullPage,
    clip,
    mask: mask.length ? mask : undefined,
    type: shotType,
    quality: shotType === "jpeg" ? config.screenshot.quality : undefined,
  });

  await writeFull(buf, fullPath, ext, config.screenshot.quality);
  await makeThumb(buf, thumbPath, config.screenshot.thumbnail);
  const dims = await imageSize(buf);

  // A mid tier only earns its bytes when the full image is meaningfully wider than
  // it — otherwise the viewer would download two near-identical images.
  const midWidth = config.screenshot.thumbnail.midWidth;
  const wantsMid = midWidth > 0 && (dims.width ?? 0) > midWidth * 1.2;
  if (wantsMid) await makeThumb(buf, midPath, config.screenshot.thumbnail, midWidth);

  const ref: ShotRef = {
    full: rel(fullPath),
    thumb: rel(thumbPath),
    ...(wantsMid ? { mid: rel(midPath) } : {}),
    meta: rel(metaPath),
    width: dims.width,
    height: dims.height,
    ...(clip ? { clamped: true } : {}),
  };

  if (config.screenshot.alsoViewport) {
    const viewportPath = path.join(dir, `${device.name}.viewport.${ext}`);
    // Crop the viewport out of the full buffer instead of taking a second screenshot.
    if (config.screenshot.fullPage && dims.width && dims.height) {
      const cropH = Math.min(Math.round(device.height * device.dpr), dims.height);
      await writeViewportCrop(buf, viewportPath, ext, config.screenshot.quality, dims.width, cropH);
    } else {
      await writeFull(buf, viewportPath, ext, config.screenshot.quality); // full already == viewport
    }
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

  return { ref, reusedNavigation: remaining !== null };
}

/**
 * Playwright only rejects a malformed selector when something uses it — which, for
 * a mask, is at screenshot time, once per shot, after the crawl is already running.
 * Checking them once against a blank page turns "every capture fails mysteriously"
 * into one clear error before the first navigation.
 */
async function validateSelectors(
  browser: Browser,
  selectors: { value: string; source: string }[],
): Promise<void> {
  if (!selectors.length) return;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const bad: string[] = [];
    for (const { value, source } of selectors) {
      try {
        await page.locator(value).count();
      } catch (e) {
        bad.push(`  ${source} "${value}" — ${(e as Error).message.split("\n")[0]}`);
      }
    }
    if (bad.length) {
      throw new Error(`invalid selector(s) in the configuration:\n${bad.join("\n")}`);
    }
  } finally {
    await context.close();
  }
}

export async function runCapture(opts: CaptureOptions): Promise<CaptureResult> {
  const { config, manifest, baseUrl, runDir } = opts;
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const shotsDir = path.join(runDir, "screenshots");
  await fs.mkdir(shotsDir, { recursive: true });

  const browser = await chromium.launch();
  let shotCount = 0;
  let resumed = 0;
  const failures: CaptureFailure[] = [];

  try {
    await validateSelectors(browser, [
      ...config.stabilize.maskSelectors.map((value) => ({ value, source: "maskSelectors" })),
      ...config.stabilize.waitForSelectors.map((value) => ({ value, source: "waitForSelectors" })),
    ]);

    // The full plan up front: an ETA needs a denominator, and per-device totals
    // aren't it — a mobile-only state exists on one device and not the others.
    //
    // The unit of work is a route, not a state: everything a route's states could
    // reuse from each other is only reusable if one worker captures them in a row.
    // Routes are still handed out one at a time, so a route with twelve states
    // doesn't leave the other workers idle at the end of the run.
    const plan = config.devices.map((device) => ({
      device,
      groups: manifest.routes
        .map((route) => ({
          route,
          states: orderForReuse(
            route.states.filter((state) => !state.devices || state.devices.includes(device.name)),
          ),
        }))
        .filter((group) => group.states.length > 0),
    }));
    const progress = createProgress({
      total: plan.reduce((n, p) => n + p.groups.reduce((m, g) => m + g.states.length, 0), 0),
      log,
    });
    let reusedNavigations = 0;

    for (const { device, groups } of plan) {
      log(`▸ ${device.name} (${device.width}×${device.height} @${device.dpr})`);
      const context = await browser.newContext({
        ...httpContextOptions(config),
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.dpr,
        isMobile: device.mobile ?? false,
        hasTouch: device.touch ?? device.mobile ?? false,
        userAgent: device.userAgent,
        colorScheme: device.colorScheme ?? "light",
        reducedMotion: device.reducedMotion ?? "reduce",
        // Pinned locale + timezone: Date is frozen by the stabilizer, but
        // Intl/toLocaleString would otherwise still render in the machine's TZ.
        locale: device.locale ?? "en-US",
        timezoneId: device.timezoneId ?? "UTC",
        storageState: opts.storageState,
      });
      context.setDefaultTimeout(config.politeness.timeoutMs);
      await applyContextInit(context, config.stabilize);

      // One page per worker rather than one per shot: every state re-navigates
      // anyway (that's what resets the DOM), so the page lifecycle is pure overhead.
      // A failed attempt still gets a fresh page — a wedged renderer must not be
      // handed to the next state.
      await mapPoolWithResource(groups, config.politeness.concurrency, {
        create: () => context.newPage(),
        dispose: (page) => page.close().catch(() => {}),
        run: async ({ route, states }, page, recycle) => {
          // What this worker's page is showing, carried across the route's states.
          // A recycled page starts blank again, which is why this is reset there.
          const shown: PageState = {};
          let current = page;

          for (const state of states) {
            if (opts.resume) {
              const existing = await adoptExistingShot({
                route,
                state,
                device,
                baseUrl,
                shotsDir,
                runDir,
                config,
              });
              if (existing) {
                state.shots[device.name] = existing;
                shotCount++;
                resumed++;
                progress.tick();
                continue;
              }
            }
            for (let attempt = 0; ; attempt++) {
              try {
                const { ref, reusedNavigation } = await captureState(
                  current,
                  { route, state, device, baseUrl, shotsDir, runDir, config, log },
                  shown,
                );
                if (reusedNavigation) reusedNavigations++;
                state.shots[device.name] = ref;
                shotCount++;
                progress.tick();
                log(`  ✓ ${pathSlug(route.url)} / ${state.id}`);
                break;
              } catch (e) {
                const error = (e as Error).message.split("\n")[0];
                current = await recycle();
                shown.url = undefined;
                shown.recipe = undefined;
                if (attempt < config.politeness.retries) {
                  log(
                    `  ↻ ${pathSlug(route.url)} / ${state.id} [${device.name}]: retrying — ${error}`,
                  );
                } else {
                  state.shots[device.name] = { error };
                  failures.push({ route: route.url, state: state.id, device: device.name, error });
                  progress.tick();
                  log(`  ✗ ${pathSlug(route.url)} / ${state.id} [${device.name}]: ${error}`);
                  break;
                }
              } finally {
                await sleep(config.politeness.minDelayMs);
              }
            }
          }
        },
      });

      await context.close();
    }
    progress.done();
    if (resumed) log(`resumed: ${resumed} shot(s) already on disk were kept`);
    if (reusedNavigations) {
      log(`page reuse: ${reusedNavigations} of ${shotCount} shot(s) needed no reload`);
    }
  } finally {
    await browser.close();
  }

  manifest.stats = {
    routes: manifest.routes.length,
    states: manifest.routes.reduce((n, r) => n + r.states.length, 0),
    shots: shotCount,
    failed: failures.length,
    durationMs: Date.now() - started,
    failures,
  };

  return { manifest, shots: shotCount, failures, durationMs: manifest.stats.durationMs };
}
