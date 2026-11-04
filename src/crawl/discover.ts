import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import type { Config } from "../shared/config";
import type { Device, InputManifest, RouteNode, StateNode, Target } from "../shared/types";
import { applyContextInit } from "./stabilize";
import { httpContextOptions } from "./context-options";
import { discoverRoutes, type RouteDiscoveryLimit } from "./discover-routes";
import { defaultState, discoverStates } from "./discover-states";
import { gotoRoute, resolveUrl } from "./recipe";
import { locatorFor, useTestIdAttribute } from "../shared/selectors";
import { mapPool } from "../shared/pool";
import { uniqueId } from "../shared/url";
import { countStates } from "./manifest";
import { launchOptions } from "../shared/launch";

export interface DiscoverOptions {
  config: Config;
  baseUrl: string;
  storageState?: string;
  log?: (msg: string) => void;
  /** Discover only these pages (see `RouteDiscoveryLimit`). */
  limit?: RouteDiscoveryLimit;
  /** The model discovery is adding to, whose site-wide states new pages shouldn't repeat. */
  existing?: InputManifest;
}

/**
 * The desktop-found states whose trigger a phone doesn't show: a header dropdown
 * folded into the hamburger menu, a sidebar the layout drops. Replayed on a phone
 * they can only time out, so they capture on desktop devices only — the mobile
 * pass finds what the phone shows instead.
 */
async function hiddenTriggers(
  context: BrowserContext,
  url: string,
  states: StateNode[],
  config: Config,
): Promise<StateNode[]> {
  const candidates = states.filter((s) => {
    const first = s.recipe[0];
    return (
      s.source === "auto" && !s.devices && (first?.action === "click" || first?.action === "hover")
    );
  });
  if (!candidates.length) return [];
  const page = await context.newPage();
  try {
    await gotoRoute(page, url, config.stabilize.waitStrategy);
    const hidden: StateNode[] = [];
    for (const state of candidates) {
      const target = (state.recipe[0] as { target: Target }).target;
      const visible = await locatorFor(page, target)
        .first()
        .isVisible()
        .catch(() => true); // can't tell — leave it on every device
      if (!visible) hidden.push(state);
    }
    return hidden;
  } catch {
    return []; // the page didn't load at this size: nothing to conclude
  } finally {
    await page.close();
  }
}

/**
 * Keep each site-wide state once. A header dropdown or a chat widget opens the
 * same thing on every page, and every page's discovery finds it again — on a shop
 * with forty pages that is most of the states and most of the shots, all alike.
 * The first page it was found on keeps it (route order puts the start page first);
 * on the rest it is dropped. Auto states only: an authored state is there because
 * someone wanted it on that page. `existing` holds pages already mapped, so a
 * page discovered later doesn't bring back what they already show.
 * Returns how many were dropped.
 */
export function keepSiteWideOnce(routes: RouteNode[], existing: RouteNode[] = []): number {
  const key = (s: StateNode) => (s.siteKey ? `${s.siteKey}|${(s.devices ?? []).join(",")}` : "");
  const seen = new Set(existing.flatMap((r) => r.states.map(key)).filter(Boolean));
  let dropped = 0;
  for (const route of routes) {
    route.states = route.states.filter((s) => {
      const k = s.source === "auto" ? key(s) : "";
      if (!k) return true;
      if (seen.has(k)) {
        dropped++;
        return false;
      }
      seen.add(k);
      return true;
    });
  }
  return dropped;
}

/**
 * Fold the states found at a mobile viewport into the route. Anything whose DOM
 * signature the desktop pass already produced is a duplicate; genuinely new states
 * (hamburger nav, mobile-only drawers) are kept but capture only on mobile devices —
 * their triggers don't exist at desktop widths, so replaying there would only fail.
 */
export function mergeMobileStates(
  route: RouteNode,
  mobileStates: StateNode[],
  mobileDeviceNames: string[],
): void {
  const knownSigs = new Set(route.states.map((s) => s.signature).filter(Boolean));
  // The same steps are the same state, whatever the signature says: a signature can
  // differ between the two passes (an accordion caught mid-animation). Only a desktop
  // state that captures on every device covers it; one already limited to desktop
  // (its trigger is hidden at phone width) doesn't.
  const recipeKey = (s: StateNode) => (s.recipe.length ? JSON.stringify(s.recipe) : "");
  const knownRecipes = new Set(
    route.states
      .filter((s) => !s.devices)
      .map(recipeKey)
      .filter(Boolean),
  );
  for (const state of mobileStates) {
    if (state.id === "default") continue; // every viewport has one; keep the desktop's
    if (state.signature && knownSigs.has(state.signature)) continue;
    if (knownRecipes.has(recipeKey(state))) continue;
    if (state.signature) knownSigs.add(state.signature);
    if (recipeKey(state)) knownRecipes.add(recipeKey(state));
    state.id = uniqueId(
      state.id,
      route.states.map((s) => s.id),
    );
    state.devices = [...mobileDeviceNames];
    route.states.push(state);
  }
}

/**
 * Auto-build a site model (routes + interaction recipes) without screenshots.
 * States are probed at a desktop viewport, then (if `discovery.mobileStates` and a
 * mobile device is configured) again at the first mobile device's viewport so
 * mobile-only states are found too. Capture later replays every state across the
 * devices it applies to.
 */
export async function discoverPipeline(opts: DiscoverOptions): Promise<InputManifest> {
  const { config, baseUrl } = opts;
  const log = opts.log ?? (() => {});
  const interactions = config.discovery.interactions;
  useTestIdAttribute(config.testIdAttribute);
  const browser = await chromium.launch(launchOptions());

  const newDiscoveryContext = async (device?: Device): Promise<BrowserContext> => {
    const context = await browser.newContext({
      ...httpContextOptions(config),
      viewport: device ? { width: device.width, height: device.height } : config.discovery.viewport,
      deviceScaleFactor: 1,
      isMobile: device?.mobile ?? false,
      hasTouch: device?.touch ?? device?.mobile ?? false,
      userAgent: device?.userAgent,
      storageState: opts.storageState,
    });
    context.setDefaultTimeout(config.politeness.timeoutMs);
    await applyContextInit(context, config.stabilize);
    return context;
  };

  try {
    const context = await newDiscoveryContext();

    log("discovering routes…");
    const routes = await discoverRoutes(context, config, baseUrl, log, opts.limit);
    log(`found ${routes.length} route(s); discovering UI states…`);

    // State discovery is per-route independent — run it under the politeness pool
    // (each call opens its own page on the shared context).
    await mapPool(routes, config.politeness.concurrency, async (route) => {
      const url = resolveUrl(baseUrl, route.finalUrl ?? route.url);
      route.states = await discoverStates(context, url, route, config, log).catch((e) => {
        // One page that won't load costs that page its states, not the whole run.
        log(`  ! ${route.url}: states not discovered — ${(e as Error).message.split("\n")[0]}`);
        return [defaultState()];
      });
    });
    await context.close();

    const mobileDevices = config.devices.filter((d) => d.mobile);
    if (config.discovery.mobileStates && mobileDevices.length && interactions.auto) {
      const probeDevice = mobileDevices[0];
      log(`probing mobile-only states (${probeDevice.name} viewport)…`);
      const mobileContext = await newDiscoveryContext(probeDevice);
      const names = mobileDevices.map((d) => d.name);
      const desktopNames = config.devices.filter((d) => !d.mobile).map((d) => d.name);
      await mapPool(routes, config.politeness.concurrency, async (route) => {
        const url = resolveUrl(baseUrl, route.finalUrl ?? route.url);
        if (desktopNames.length) {
          const hidden = await hiddenTriggers(mobileContext, url, route.states, config);
          for (const state of hidden) state.devices = [...desktopNames];
        }
        const mobileStates = await discoverStates(mobileContext, url, route, config, log).catch(
          (e) => {
            log(
              `  ! ${route.url}: mobile states not discovered — ${(e as Error).message.split("\n")[0]}`,
            );
            return [];
          },
        );
        mergeMobileStates(route, mobileStates, names);
      });
      await mobileContext.close();
    }

    if (interactions.siteWideOnce) {
      const existing = (opts.existing?.routes ?? []).filter(
        (r) => !routes.some((x) => x.url === r.url),
      );
      const dropped = keepSiteWideOnce(routes, existing);
      if (dropped) log(`kept site-wide states once: dropped ${dropped} repeat(s) on other pages`);
    }

    const totalStates = countStates(routes);
    log(`discovered ${routes.length} route(s), ${totalStates} state(s)`);
    return { site: { title: routes[0]?.title }, routes };
  } finally {
    await browser.close();
  }
}
