import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import type { Config } from "../shared/config";
import type { Device, InputManifest, RouteNode, StateNode } from "../shared/types";
import { applyContextInit } from "./stabilize";
import { httpContextOptions } from "./context-options";
import { discoverRoutes } from "./discover-routes";
import { discoverStates } from "./discover-states";
import { resolveUrl } from "./recipe";
import { mapPool } from "../shared/pool";
import { uniqueId } from "../shared/url";
import { countStates } from "./manifest";

export interface DiscoverOptions {
  config: Config;
  baseUrl: string;
  storageState?: string;
  log?: (msg: string) => void;
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
  for (const state of mobileStates) {
    if (state.id === "default") continue; // every viewport has one; keep the desktop's
    if (state.signature && knownSigs.has(state.signature)) continue;
    if (state.signature) knownSigs.add(state.signature);
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
  const browser = await chromium.launch();

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
    const routes = await discoverRoutes(context, config, baseUrl, log);
    log(`found ${routes.length} route(s); discovering UI states…`);

    // State discovery is per-route independent — run it under the politeness pool
    // (each call opens its own page on the shared context).
    await mapPool(routes, config.politeness.concurrency, async (route) => {
      const url = resolveUrl(baseUrl, route.finalUrl ?? route.url);
      route.states = await discoverStates(context, url, route, config, log);
    });
    await context.close();

    const mobileDevices = config.devices.filter((d) => d.mobile);
    if (
      config.discovery.mobileStates &&
      mobileDevices.length &&
      interactions.auto &&
      interactions.nestDepth >= 1
    ) {
      const probeDevice = mobileDevices[0];
      log(`probing mobile-only states (${probeDevice.name} viewport)…`);
      const mobileContext = await newDiscoveryContext(probeDevice);
      const names = mobileDevices.map((d) => d.name);
      await mapPool(routes, config.politeness.concurrency, async (route) => {
        const url = resolveUrl(baseUrl, route.finalUrl ?? route.url);
        const mobileStates = await discoverStates(mobileContext, url, route, config, log);
        mergeMobileStates(route, mobileStates, names);
      });
      await mobileContext.close();
    }

    const totalStates = countStates(routes);
    log(`discovered ${routes.length} route(s), ${totalStates} state(s)`);
    return { site: { title: routes[0]?.title }, routes };
  } finally {
    await browser.close();
  }
}
