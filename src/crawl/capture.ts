import { chromium, firefox, webkit } from "playwright";
import type { Browser, BrowserType, Page } from "playwright";
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
import {
  MAX_SIDE,
  makeThumb,
  imageSize,
  stackScreens,
  writeFull,
  writeViewportCrop,
} from "./thumbnails";
import { routeHref } from "../shared/url";
import { captureScreens } from "./screens";
import { applyRecipe, gotoRoute, resolveUrl } from "./recipe";
import { takeSnapshot } from "./snapshot";
import { deviceContextOptions } from "./context-options";
import { useTestIdAttribute } from "../shared/selectors";
import { useUnstableIds } from "./generated-ids";
import { createProgress } from "../shared/progress";
import { pathExists } from "../shared/fsx";
import { mapPoolWithResource, sleep } from "../shared/pool";
import { countStates } from "./manifest";
import { checkAccessibility, rollupViolations, type AccessibilityViolation } from "./accessibility";
import { launchOptions } from "../shared/launch";

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
  /** The open-region signature the recipe left, read before stabilization ran. */
  sig?: string;
}

/** Forget what a page shows: it is being changed, or was just replaced. */
function forget(shown: PageState): void {
  shown.url = undefined;
  shown.recipe = undefined;
  shown.sig = undefined;
}

/** The directory one state's shots (for every device) are written to. */
function stateDir(shotsDir: string, route: RouteNode, state: StateNode): string {
  return path.join(shotsDir, pathSlug(route.url), stateSlug(state.id));
}

/**
 * The `waitFor` steps a recipe ends on — what it promises is on screen once it has
 * finished. Everything after its last interaction.
 */
export function closingPromises(
  recipe: RecipeStep[],
): Extract<RecipeStep, { action: "waitFor" }>[] {
  const out: Extract<RecipeStep, { action: "waitFor" }>[] = [];
  for (let i = recipe.length - 1; i >= 0; i--) {
    const step = recipe[i];
    if (step.action === "wait") continue;
    if (step.action !== "waitFor") break;
    if (step.selector) out.unshift(step);
  }
  return out;
}

/** Does `step`'s condition hold right now? Checked, not waited for. */
async function holdsNow(
  page: Page,
  step: Extract<RecipeStep, { action: "waitFor" }>,
): Promise<boolean> {
  if (!step.selector) return true;
  const all = page.locator(step.selector);
  switch (step.state ?? "visible") {
    case "visible":
      return (await all.filter({ visible: true }).count()) > 0;
    case "hidden":
      return all.first().isHidden();
    case "attached":
      return (await all.count()) > 0;
    case "detached":
      return (await all.count()) === 0;
  }
}

/**
 * Is the page still what `shown.recipe` left it as?
 *
 * `reusePlan` settles which steps are left to run; this settles whether running
 * only those is still equivalent to running them all from a fresh load. It is only
 * if nothing that ran *between* the two changed what the remaining steps build on —
 * and between them the page was stabilized and photographed. Stabilizing scrolls
 * the whole page to trigger lazy loading, which is exactly what closes a
 * Floating-UI popover or a Bootstrap dropdown: the next state's `click Submenu`
 * then fails against a closed menu that a fresh load would have had open.
 *
 * Two cheap checks. The recipe's own closing promises (its trailing `waitFor`s)
 * must still hold, and the open regions must be the ones it left. Either failing
 * means a reload, which is never wrong — only slower.
 */
export async function stillShowing(page: Page, shown: PageState): Promise<boolean> {
  if (shown.sig === undefined || !shown.recipe) return false;
  try {
    if ((await takeSnapshot(page)).sig !== shown.sig) return false;
    for (const step of closingPromises(shown.recipe)) {
      if (!(await holdsNow(page, step))) return false;
    }
    return true;
  } catch {
    return false;
  }
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
  /** Also reuse a page showing exactly `recipe` — nothing left to run. */
  allowSame = false,
): RecipeStep[] | null {
  if (shown.url !== url || !shown.recipe) return null;
  if (shown.recipe.length > recipe.length) return null;
  if (shown.recipe.length === recipe.length && !allowSame) return null;
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
async function adoptExistingShot(
  ctx: Pick<StateCtx, "route" | "state" | "device" | "shotsDir" | "runDir">,
): Promise<{ ref: ShotRef; violations?: AccessibilityViolation[] } | undefined> {
  const { route, state, device, shotsDir, runDir } = ctx;
  const metaPath = path.join(stateDir(shotsDir, route, state), `${device.name}.json`);
  const raw = await fs.readFile(metaPath, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const sidecar = JSON.parse(raw) as {
      shot?: ShotRef;
      routeUrl?: string;
      state?: string;
      accessibility?: AccessibilityViolation[];
    };
    const ref = sidecar.shot;
    if (!ref?.full) return undefined;
    // Another page's shot, should two ever share a folder, is not this one's.
    if (sidecar.routeUrl !== undefined && sidecar.routeUrl !== route.url) return undefined;
    if (sidecar.state !== undefined && sidecar.state !== state.id) return undefined;
    // The sidecar points at the image by a run-relative path; make sure it's there.
    if (!(await pathExists(path.join(runDir, ref.full)))) return undefined;
    return { ref, violations: sidecar.accessibility };
  } catch {
    return undefined;
  }
}

/** A captured shot, plus whether taking it managed to skip the route's reload. */
interface Captured {
  /** Absent when the state's `element` isn't on this route: nothing to capture. */
  ref?: ShotRef;
  violations?: AccessibilityViolation[];
  reusedNavigation: boolean;
  /** Reuse was planned, but the page had moved on since the previous shot. */
  reuseDeclined: boolean;
}

/**
 * Did loading `route` end on the login page, when it normally ends somewhere else?
 *
 * That is what a lapsed session looks like from the outside: no error, a 200, and
 * a perfectly good screenshot — of the login form, filed under the protected page.
 * Only a route whose known destination is *not* the login page can tell, so a
 * route seen for the first time, and the login page itself, are never flagged.
 */
export function sentToLogin(
  config: Config,
  baseUrl: string,
  route: Pick<RouteNode, "url" | "finalUrl">,
  landed: string,
): boolean {
  const login = config.auth.login?.url;
  if (!login || !config.auth.storageStatePath || !route.finalUrl) return false;
  const pathOf = (u: string) => new URL(u, baseUrl).pathname.replace(/\/+$/, "") || "/";
  const loginPath = pathOf(login);
  if (pathOf(route.finalUrl) === loginPath || pathOf(route.url) === loginPath) return false;
  return pathOf(landed) === loginPath;
}

async function captureState(page: Page, ctx: StateCtx, shown: PageState): Promise<Captured> {
  const { route, state, device, baseUrl, shotsDir, runDir, config } = ctx;
  const rel = (p: string) => path.relative(runDir, p).split(path.sep).join("/");

  // Navigate by the (relative) route path resolved against the *current* base, not a
  // stored absolute finalUrl — that keeps a cached site model portable across runs/hosts.
  const url = resolveUrl(baseUrl, routeHref(route));
  const reuse = config.politeness.reuseNavigation;
  // A component is photographed out of a page that is already showing what it
  // needs, so an identical recipe is reusable for it where a page state's isn't.
  let remaining = reuse ? reusePlan(shown, url, state.recipe, state.element !== undefined) : null;
  const declined = remaining !== null && !(await stillShowing(page, shown));
  if (declined) remaining = null;

  // From here on the page is being changed, so what it shows is unknown until the
  // recipe finishes — a step that throws half way must not leave a stale claim
  // behind for the next state to trust.
  forget(shown);

  // A reused page keeps the pointer wherever the previous state left it, and the
  // browser re-applies `:hover` at that position to the newly loaded document — a
  // phantom hover painted into an unrelated screenshot. Park it off-viewport before
  // the recipe runs; a recipe that *wants* a hover state moves the pointer itself.
  // Only after a navigation: when the page is kept, the pointer is part of the
  // state being extended, and parking it would close a hover-opened menu.
  const load = async () => {
    const resp = await gotoRoute(page, url, config.stabilize.waitStrategy);
    if (sentToLogin(config, baseUrl, route, page.url())) {
      throw new Error(
        `landed on the login page instead of ${route.url} — the saved session has expired or ` +
          "was signed out (name the session cookie in auth.login.sessionCookies so an expired " +
          "one is renewed, or run 'visualice auth')",
      );
    }
    if (resp && route.status === undefined) route.status = resp.status();
    if (!route.finalUrl) route.finalUrl = page.url();
    if (!route.title) route.title = await page.title().catch(() => undefined);
    await page.mouse.move(-1, -1).catch(() => {});
  };

  if (remaining === null) await load();

  await applyRecipe(page, remaining ?? state.recipe);
  // What the recipe left, read before stabilization has a chance to change it: the
  // baseline `stillShowing` holds this shot, and the next state's reuse, to.
  const opens = state.recipe.length > 0;
  let left = reuse || opens ? await takeSnapshot(page).catch(() => undefined) : undefined;
  // A recipe that scrolls wants the shot taken from where it scrolled to; without
  // this, stabilization's lazy-load pass would put the page back at the top.
  const keepScroll = state.recipe.some((s) => s.action === "scroll");
  // Taking a page a screen at a time scrolls it the way a user would, which wakes
  // lazy content on its own — the separate scroll-to-the-bottom-and-back pass would
  // only be a second, earlier scroll through the same page.
  const fullPage = config.screenshot.fullPage !== false;
  const screens = !state.element && config.screenshot.fullPage === "screens";
  const stabilize = screens ? { ...config.stabilize, lazyScroll: false } : config.stabilize;
  await stabilizePage(page, stabilize, ctx.log, { keepScroll });

  // Stabilizing scrolls the page to wake lazy content, and a scroll is exactly what
  // closes a Floating-UI popover, a Bootstrap dropdown or a hover menu — the shot
  // would then show the state closed. When what the recipe opened didn't survive,
  // take it again in the other order: scroll first on a fresh load, open the state
  // on the already-woken page, and leave the scroll out of the final settle.
  let reopened = false;
  if (
    opens &&
    stabilize.lazyScroll &&
    left &&
    !(await stillShowing(page, { recipe: state.recipe, sig: left.sig }))
  ) {
    await load();
    await stabilizePage(page, config.stabilize);
    await applyRecipe(page, state.recipe);
    left = await takeSnapshot(page).catch(() => undefined);
    await stabilizePage(page, { ...config.stabilize, lazyScroll: false }, ctx.log, { keepScroll });
    reopened = true;
    ctx.log?.(
      `  ↺ ${pathSlug(route.url)} / ${state.id}: closed by the lazy-load scroll — reopened after it`,
    );
  }
  shown.url = url;
  shown.recipe = state.recipe;
  shown.sig = reuse ? left?.sig : undefined;

  const element = state.element ? page.locator(state.element).first() : undefined;
  if (element && (await element.count()) === 0) {
    return { reusedNavigation: remaining !== null && !reopened, reuseDeclined: declined };
  }

  const dir = stateDir(shotsDir, route, state);
  await fs.mkdir(dir, { recursive: true });

  const ext = config.screenshot.format;
  const shotType = ext === "jpeg" ? "jpeg" : "png";
  const mask = config.stabilize.maskSelectors.map((s) => page.locator(s));

  const thumbExt = config.screenshot.thumbnail.format;
  const fullPath = path.join(dir, `${device.name}.${ext}`);
  const thumbPath = path.join(dir, `${device.name}.thumb.${thumbExt}`);
  const midPath = path.join(dir, `${device.name}.mid.${thumbExt}`);
  const metaPath = path.join(dir, `${device.name}.json`);

  const clip =
    !element && fullPage && !screens
      ? await fullPageClip(page, config.screenshot.maxHeight)
      : undefined;

  const taken = screens
    ? await captureScreens(page, {
        maxHeight: config.screenshot.maxHeight,
        maxScreens: config.screenshot.maxScreens,
        settleMs: config.stabilize.extraDelayMs,
        type: shotType,
        quality: config.screenshot.quality,
        mask,
        keepScroll,
      })
    : undefined;

  // A JPEG holds 65535px: a long page on a dense screen stacks past that, and the
  // encoder would refuse the whole shot. Keep the screens that fit, and say so.
  if (taken && shotType === "jpeg") {
    const frameHeight = Math.max(1, Math.round(device.height * device.dpr));
    const fits = Math.max(1, Math.floor(MAX_SIDE.jpeg / frameHeight));
    if (taken.frames.length > fits) {
      taken.frames.length = fits;
      if (taken.stops) taken.stops.length = fits;
      taken.clamped = true;
    }
  }

  const buf = taken
    ? await stackScreens(taken.frames, shotType, config.screenshot.quality)
    : element
      ? await element.screenshot({
          mask: mask.length ? mask : undefined,
          type: shotType,
          quality: shotType === "jpeg" ? config.screenshot.quality : undefined,
        })
      : await page.screenshot({
          // `clip` alone is bounded by the viewport; it only reaches further down the
          // page when fullPage is set too.
          fullPage,
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
  const zoomWidth = config.screenshot.thumbnail.zoomWidth;
  const wantsMid = zoomWidth > 0 && (dims.width ?? 0) > zoomWidth * 1.2;
  if (wantsMid) await makeThumb(buf, midPath, config.screenshot.thumbnail, zoomWidth);

  const ref: ShotRef = {
    full: rel(fullPath),
    thumb: rel(thumbPath),
    ...(wantsMid ? { mid: rel(midPath) } : {}),
    meta: rel(metaPath),
    width: dims.width,
    height: dims.height,
    ...(clip || taken?.clamped ? { clamped: true } : {}),
    ...(taken && taken.frames.length > 1 ? { screens: taken.frames.length } : {}),
  };
  if (taken?.stops && taken.viewportHeight && dims.height) {
    // Stops are measured in CSS px; the image is in device px.
    const k = dims.height / taken.frames.length / taken.viewportHeight;
    ref.frames = taken.stops.map((f) => ({
      y: Math.round(f.y * k),
      top: Math.round(f.top * k),
      bottom: Math.round(f.bottom * k),
    }));
  }

  if (config.screenshot.alsoViewport && !element) {
    const viewportPath = path.join(dir, `${device.name}.viewport.${ext}`);
    // Crop the viewport out of the full buffer instead of taking a second screenshot.
    if (fullPage && dims.width && dims.height) {
      const cropH = Math.min(Math.round(device.height * device.dpr), dims.height);
      await writeViewportCrop(buf, viewportPath, ext, config.screenshot.quality, dims.width, cropH);
    } else {
      await writeFull(buf, viewportPath, ext, config.screenshot.quality); // full already == viewport
    }
    ref.viewport = rel(viewportPath);
  }

  // After the screenshot, so nothing axe does to the page can reach the picture.
  let violations: AccessibilityViolation[] | undefined;
  if (config.checks.accessibility) {
    try {
      violations = await checkAccessibility(page, config.checks.accessibilityTags, state.element);
      ref.a11y = violations.length;
    } catch (e) {
      ctx.log?.(
        `  ⚠ accessibility check failed on ${pathSlug(route.url)} / ${state.id}: ${(e as Error).message.split("\n")[0]}`,
      );
    }
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
    ...(violations ? { accessibility: violations } : {}),
    capturedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaPath, JSON.stringify(sidecar, null, 2));

  return {
    ref,
    violations,
    reusedNavigation: remaining !== null && !reopened,
    reuseDeclined: declined,
  };
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

/**
 * Playwright's "browser isn't downloaded" error is a screenful about its own CLI;
 * what the person needs is the one command, named for the engine their config asked
 * for. Anything else (a crashed launch, a sandbox problem) passes through untouched.
 */
export function launchError(engine: string, error: Error): Error {
  if (/Executable doesn't exist|playwright install/i.test(error.message)) {
    return new Error(
      `the ${engine} browser isn't installed — run 'npx playwright install ${engine}'`,
    );
  }
  return error;
}

export async function runCapture(opts: CaptureOptions): Promise<CaptureResult> {
  const { config, manifest, baseUrl, runDir } = opts;
  const log = opts.log ?? (() => {});
  useTestIdAttribute(config.testIdAttribute);
  useUnstableIds(config.discovery.unstableIds);
  const started = Date.now();
  const shotsDir = path.join(runDir, "screenshots");
  await fs.mkdir(shotsDir, { recursive: true });

  const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
  const launched = new Map<string, Browser>();
  /** One browser per engine, started the first time a device asks for it. */
  const browserFor = async (name: string): Promise<Browser> => {
    const running = launched.get(name);
    if (running) return running;
    try {
      const browser = await engines[name].launch(launchOptions());
      launched.set(name, browser);
      return browser;
    } catch (e) {
      throw launchError(name, e as Error);
    }
  };
  const perShotViolations: AccessibilityViolation[][] = [];
  let shotCount = 0;
  let resumed = 0;
  const failures: CaptureFailure[] = [];

  try {
    await validateSelectors(await browserFor(config.devices[0]?.browser ?? "chromium"), [
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
    let declinedReuses = 0;

    for (const { device, groups } of plan) {
      const engine = device.browser ?? "chromium";
      log(
        `▸ ${device.name} (${device.width}×${device.height} @${device.dpr}${engine === "chromium" ? "" : `, ${engine}`})`,
      );
      const browser = await browserFor(engine);
      const newContext = async () => {
        const context = await browser.newContext(
          deviceContextOptions(config, device, opts.storageState),
        );
        context.setDefaultTimeout(config.politeness.timeoutMs);
        await applyContextInit(context, config.stabilize);
        return context;
      };
      const context = await newContext();

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
              const existing = await adoptExistingShot({ route, state, device, shotsDir, runDir });
              if (existing) {
                state.shots[device.name] = existing.ref;
                // Its accessibility findings count in the run's totals like any shot's.
                if (existing.violations) perShotViolations.push(existing.violations);
                shotCount++;
                resumed++;
                progress.tick();
                continue;
              }
            }
            for (let attempt = 0; ; attempt++) {
              // An isolated state gets a context of its own, thrown away after the
              // shot: whatever its recipe stores dies with it, and the shared page
              // (and what it is showing) is left exactly as it was.
              const own = state.isolate ? await newContext() : undefined;
              try {
                const { ref, violations, reusedNavigation, reuseDeclined } = await captureState(
                  own ? await own.newPage() : current,
                  { route, state, device, baseUrl, shotsDir, runDir, config, log },
                  own ? {} : shown,
                );
                if (!ref) {
                  // The component isn't on this route: not a shot, and not a failure.
                  progress.tick();
                  break;
                }
                if (reusedNavigation) reusedNavigations++;
                if (reuseDeclined) declinedReuses++;
                if (violations) perShotViolations.push(violations);
                state.shots[device.name] = ref;
                shotCount++;
                progress.tick();
                log(`  ✓ ${pathSlug(route.url)} / ${state.id}`);
                break;
              } catch (e) {
                const error = (e as Error).message.split("\n")[0];
                if (!own) {
                  current = await recycle();
                  forget(shown);
                }
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
                await own?.close().catch(() => {});
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
    if (reusedNavigations || declinedReuses) {
      // Declines are worth a number: each is a page that stabilization changed under
      // an open state, which usually means an overlay that closes on scroll.
      const declined = declinedReuses
        ? ` (${declinedReuses} more reloaded: the page had changed since the previous shot)`
        : "";
      log(`page reuse: ${reusedNavigations} of ${shotCount} shot(s) needed no reload${declined}`);
    }
  } finally {
    await Promise.all([...launched.values()].map((b) => b.close().catch(() => {})));
  }

  // A component that no device found on a route was never there: drop the state
  // rather than leave an empty row in the manifest, the viewer and the report.
  for (const route of manifest.routes) {
    route.states = route.states.filter(
      (s) => s.element === undefined || Object.keys(s.shots).length > 0,
    );
  }

  manifest.stats = {
    routes: manifest.routes.length,
    states: countStates(manifest.routes),
    shots: shotCount,
    failed: failures.length,
    durationMs: Date.now() - started,
    failures,
    ...(config.checks.accessibility ? { accessibility: rollupViolations(perShotViolations) } : {}),
  };

  return { manifest, shots: shotCount, failures, durationMs: manifest.stats.durationMs };
}
