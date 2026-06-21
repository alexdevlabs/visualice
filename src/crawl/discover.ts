import { chromium } from "playwright";
import type { Config } from "../shared/config";
import type { InputManifest } from "../shared/types";
import { applyContextInit } from "./stabilize";
import { discoverRoutes } from "./discover-routes";
import { discoverStates } from "./discover-states";
import { resolveUrl } from "./recipe";

export interface DiscoverOptions {
  config: Config;
  baseUrl: string;
  storageState?: string;
  log?: (msg: string) => void;
}

/**
 * Auto-build a site model (routes + interaction recipes) without screenshots.
 * Discovery runs at a single desktop-ish viewport; capture later replays every
 * discovered state across all configured devices.
 */
export async function discoverPipeline(opts: DiscoverOptions): Promise<InputManifest> {
  const { config, baseUrl } = opts;
  const log = opts.log ?? (() => {});
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      storageState: opts.storageState,
    });
    context.setDefaultTimeout(config.politeness.timeoutMs);
    await applyContextInit(context, config.stabilize);

    log("discovering routes…");
    const routes = await discoverRoutes(context, config, baseUrl, log);
    log(`found ${routes.length} route(s); discovering UI states…`);

    for (const route of routes) {
      const url = resolveUrl(baseUrl, route.finalUrl ?? route.url);
      route.states = await discoverStates(context, url, route, config, log);
    }

    await context.close();
    const totalStates = routes.reduce((n, r) => n + r.states.length, 0);
    log(`discovered ${routes.length} route(s), ${totalStates} state(s)`);
    return { site: { title: routes[0]?.title }, routes };
  } finally {
    await browser.close();
  }
}
