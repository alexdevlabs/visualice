import type { BrowserContext } from "playwright";
import type { Config } from "../shared/config";
import type { RouteNode } from "../shared/types";
import { inScope } from "../shared/glob";
import {
  canonicalPath,
  dedupeLinks,
  relativeToOrigin,
  routeId,
  scopePath,
  uniqueId,
} from "../shared/url";
import { ALLOW_ALL, fetchRobots, isAllowed, type RobotsRules } from "../shared/robots";
import { politeFetch } from "../shared/http";
import { sleep } from "../shared/pool";

/** Sanity bound on how many sitemap files one crawl will fetch (index recursion). */
const MAX_SITEMAP_FETCHES = 20;

async function fetchSitemapUrls(
  baseUrl: string,
  origin: string,
  declared: string[],
  cap: number,
): Promise<string[]> {
  const queue = [new URL("/sitemap.xml", baseUrl).href, ...declared];
  const fetched = new Set<string>();
  const out: string[] = [];
  while (queue.length && out.length < cap && fetched.size < MAX_SITEMAP_FETCHES) {
    const sm = queue.shift()!;
    if (fetched.has(sm)) continue;
    fetched.add(sm);
    try {
      const r = await politeFetch(sm);
      if (!r.ok) continue;
      const xml = await r.text();
      // A <sitemapindex> lists further sitemap files in its <loc>s, not pages.
      const isIndex = /<sitemapindex[\s>]/i.test(xml);
      for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        const u = m[1].trim();
        try {
          if (new URL(u).origin !== origin) continue;
        } catch {
          continue;
        }
        if (isIndex) queue.push(u);
        else if (out.length < cap) out.push(u);
      }
    } catch {
      /* unreachable / timed out sitemap — the BFS still finds pages via links */
    }
  }
  return out;
}

/** BFS link crawl (+ sitemap) confined to the target origin, scope rules and robots.txt. */
export async function discoverRoutes(
  context: BrowserContext,
  config: Config,
  baseUrl: string,
  log: (msg: string) => void,
): Promise<RouteNode[]> {
  const origin = new URL(baseUrl).origin;
  const { include, exclude, maxDepth, maxPages, sameOriginOnly } = config.scope;
  const { respectRobots } = config.politeness;

  // One fetch serves both consumers: the crawl rules and the declared sitemaps.
  const robots: RobotsRules =
    respectRobots || config.discovery.useSitemap ? await fetchRobots(baseUrl, log) : ALLOW_ALL;
  if (respectRobots && robots.rules.length) {
    log(`  robots.txt: ${robots.rules.length} rule(s) apply`);
  }

  // A site-declared Crawl-delay only ever slows us down, never speeds us up.
  const delayMs = Math.max(
    config.politeness.minDelayMs,
    (respectRobots && robots.crawlDelayMs) || 0,
  );
  if (delayMs > config.politeness.minDelayMs) {
    log(`  robots.txt: honouring Crawl-delay → ${delayMs}ms between requests`);
  }

  const visited = new Set<string>();
  const routes: RouteNode[] = [];
  const queue: { url: string; depth: number; from: string | null }[] = [];
  const enqueue = (url: string, depth: number, from: string | null) =>
    queue.push({ url, depth, from });

  enqueue(baseUrl, 0, null);
  for (const s of config.seeds) {
    try {
      enqueue(new URL(s, baseUrl).href, 0, null);
    } catch {
      /* skip bad seed */
    }
  }
  if (config.discovery.useSitemap) {
    const fromSitemap = await fetchSitemapUrls(baseUrl, origin, robots.sitemaps, maxPages);
    for (const u of fromSitemap) enqueue(u, 0, null);
  }

  let blocked = 0;
  const page = await context.newPage();
  try {
    while (queue.length && routes.length < maxPages) {
      const item = queue.shift()!;
      let canon: string;
      let scope: string;
      try {
        const u = new URL(item.url);
        if (sameOriginOnly && u.origin !== origin) continue;
        canon = canonicalPath(u);
        scope = scopePath(u);
      } catch {
        continue;
      }
      const key = origin + canon;
      if (visited.has(key)) continue;
      // Mark before filtering so a rejected URL is only evaluated (and logged) once.
      visited.add(key);
      if (!inScope(scope, include, exclude)) continue;
      if (respectRobots && !isAllowed(canon, robots)) {
        blocked++;
        log(`  ⊘ ${canon} — disallowed by robots.txt`);
        continue;
      }

      let status: number | undefined;
      let title: string | undefined;
      let links: string[] = [];
      let navigated = false;
      for (let attempt = 0; attempt <= config.politeness.retries && !navigated; attempt++) {
        try {
          const resp = await page.goto(item.url, {
            waitUntil: "domcontentloaded",
            timeout: config.politeness.timeoutMs,
          });
          navigated = true;
          status = resp?.status();
          title = await page.title().catch(() => undefined);
          if (item.depth < maxDepth) {
            // Playwright's $$eval (DOM query in the page context), not JS eval().
            links = await page.$$eval("a[href]", (els) =>
              els.map((e) => (e as HTMLAnchorElement).href),
            );
          }
        } catch (e) {
          const msg = (e as Error).message.split("\n")[0];
          log(
            attempt < config.politeness.retries
              ? `  ↻ ${canon}: retrying — ${msg}`
              : `  ! ${canon}: ${msg}`,
          );
        }
      }

      const id = uniqueId(
        routeId(canon),
        routes.map((r) => r.id),
      );
      routes.push({
        id,
        url: canon,
        // page.url() is only meaningful if the navigation landed — after a failed
        // goto it still points at the *previous* page.
        finalUrl: navigated ? relativeToOrigin(page.url(), origin) : undefined,
        title,
        status,
        depth: item.depth,
        discoveredFrom: item.from,
        links: dedupeLinks(links, origin),
        states: [],
      });
      log(`  • ${canon}${title ? ` — ${title}` : ""}`);

      if (item.depth < maxDepth) {
        for (const href of links) {
          try {
            const u = new URL(href);
            if (u.origin !== origin) continue;
            const linkCanon = canonicalPath(u);
            if (visited.has(origin + linkCanon) || !inScope(scopePath(u), include, exclude))
              continue;
            enqueue(origin + linkCanon, item.depth + 1, canon);
          } catch {
            /* skip */
          }
        }
      }
      await sleep(delayMs);
    }
  } finally {
    await page.close().catch(() => {});
  }
  if (blocked) log(`  robots.txt blocked ${blocked} URL(s)`);
  return routes;
}
