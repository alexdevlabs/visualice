import type { BrowserContext } from "playwright";
import type { Config } from "../shared/config";
import type { RouteNode } from "../shared/types";
import { globToRegExp, inScope } from "../shared/glob";
import {
  canonicalPath,
  dedupeLinks,
  hashPart,
  relativeToOrigin,
  routeId,
  scopePath,
  uniqueId,
} from "../shared/url";
import { ALLOW_ALL, fetchRobots, isAllowed, type RobotsRules } from "../shared/robots";
import { politeFetch } from "../shared/http";
import { sleep } from "../shared/pool";
import { gotoRoute } from "./recipe";

/** How long a page may take to finish loading its data before its links are read. */
const LINK_SETTLE_MS = 5000;

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
      for (const m of xml.matchAll(
        /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi,
      )) {
        const u = xmlText(m[1].trim());
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

/** XML character data as text: `&amp;` → `&`. A sitemap URL with two parameters has one. */
export function xmlText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (all, name: string) => {
    const n = name.toLowerCase();
    if (n === "amp") return "&";
    if (n === "lt") return "<";
    if (n === "gt") return ">";
    if (n === "quot") return '"';
    if (n === "apos") return "'";
    const code = n.startsWith("#x") ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Narrows a route discovery to known pages. */
export interface RouteDiscoveryLimit {
  /** Visit exactly these pages: no start page, no sitemap, no link following. */
  only?: string[];
  /** Route ids already in use (by a cached model the result is merged into). */
  takenIds?: string[];
  /**
   * Pages the last crawl kept. The routes file seeds every one of them, and a seeded
   * page is always kept: these count toward `scope.samples`, so a sampled template
   * stays at its size instead of gaining `max` more pages each crawl.
   */
  known?: string[];
  /**
   * Links that only showed once something on a page was opened (a collapsed menu
   * group, a drawer): visit these, and what they link to, instead of the start
   * page, seeds and sitemap. `depth` is the page's own, one past where it was found.
   */
  revealed?: { url: string; from: string; depth: number }[];
  /** Pages already discovered this crawl: not visited again, and counted toward the limits. */
  have?: RouteNode[];
}

/** BFS link crawl (+ sitemap) confined to the target origin, scope rules and robots.txt. */
export async function discoverRoutes(
  context: BrowserContext,
  config: Config,
  baseUrl: string,
  log: (msg: string) => void,
  limit: RouteDiscoveryLimit = {},
): Promise<RouteNode[]> {
  const origin = new URL(baseUrl).origin;
  const { include, exclude, maxPages, sameOriginOnly, hashRoutes } = config.scope;
  const maxDepth = limit.only ? 0 : config.scope.maxDepth;
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
  /** `seeded`: asked for by name (a seed, a routes-file page), not found by following links. */
  const queue: { url: string; depth: number; from: string | null; seeded?: boolean }[] = [];
  const enqueue = (url: string, depth: number, from: string | null, seeded = false) =>
    queue.push({ url, depth, from, seeded });

  const have = limit.have ?? [];
  for (const r of have) visited.add(origin + r.url);
  for (const r of limit.revealed ?? []) enqueue(r.url, r.depth, r.from);
  const fresh = !limit.only && !limit.revealed;
  if (fresh) enqueue(baseUrl, 0, null);
  for (const s of limit.revealed ? [] : (limit.only ?? config.seeds)) {
    try {
      enqueue(new URL(s, baseUrl).href, 0, null, true);
    } catch {
      /* skip bad seed */
    }
  }
  if (config.discovery.useSitemap && fresh) {
    const fromSitemap = await fetchSitemapUrls(baseUrl, origin, robots.sitemaps, maxPages);
    for (const u of fromSitemap) enqueue(u, 0, null);
  }

  // A template's pages, sampled: the first few links of each glob are kept and the
  // rest skipped — a shop's forty product pages are one design, forty times.
  const samples = Object.entries(config.scope.samples).map(([glob, max]) => ({
    glob,
    max,
    re: globToRegExp(glob),
    taken: 0,
    skipped: 0,
  }));
  for (const r of have) {
    const u = safeUrl(origin + r.url);
    const sample = u && samples.find((x) => x.re.test(scopePath(u, hashRoutes)));
    if (sample) sample.taken++;
  }
  const known = new Set(limit.known ?? []);
  const sampled = (path: string, seeded: boolean, canon: string): boolean => {
    const sample = samples.find((x) => x.re.test(path));
    if (!sample) return true;
    if (seeded) {
      // A page asked for by name is always kept, on top of the sample. One the last
      // crawl already had is part of the sample it took.
      if (known.has(canon)) sample.taken++;
      return true;
    }
    if (sample.taken >= sample.max) {
      sample.skipped++;
      return false;
    }
    sample.taken++;
    return true;
  };

  let blocked = 0;
  const page = await context.newPage();
  try {
    while (queue.length && have.length + routes.length < maxPages) {
      const item = queue.shift()!;
      let canon: string;
      let scope: string;
      /** The path as the site wrote it, which is what its robots.txt rules are about. */
      let written: string;
      try {
        const u = new URL(item.url);
        if (sameOriginOnly && u.origin !== origin) continue;
        canon = canonicalPath(u, hashRoutes);
        scope = scopePath(u, hashRoutes);
        written = u.pathname + u.search;
      } catch {
        continue;
      }
      const key = origin + canon;
      if (visited.has(key)) continue;
      // Mark before filtering so a rejected URL is only evaluated (and logged) once.
      visited.add(key);
      if (!inScope(scope, include, exclude, canon)) continue;
      if (respectRobots && !isAllowed(written, robots)) {
        blocked++;
        log(`  ⊘ ${canon} — disallowed by robots.txt`);
        continue;
      }
      if (!sampled(scope, !!item.seeded, canon)) continue;

      let status: number | undefined;
      let title: string | undefined;
      let links: string[] = [];
      let navigated = false;
      for (let attempt = 0; attempt <= config.politeness.retries && !navigated; attempt++) {
        try {
          const resp = await gotoRoute(
            page,
            item.url,
            "domcontentloaded",
            config.politeness.timeoutMs,
          );
          navigated = true;
          status = resp?.status();
          // A client-rendered page has its shell at domcontentloaded but not its
          // data: the article and profile links of a feed arrive with an API call
          // after it. Let the page settle the way capture would — bounded, so a site
          // that never goes quiet (polling, a socket) only costs the wait once.
          if (item.depth < maxDepth && config.stabilize.waitStrategy !== "domcontentloaded") {
            await page
              .waitForLoadState(config.stabilize.waitStrategy, { timeout: LINK_SETTLE_MS })
              .catch(() => {});
          }
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

      // A page that sends the browser to another site isn't this site's page: what
      // is there must not be probed (its buttons clicked) or shot as part of it.
      const landed = navigated ? safeUrl(page.url()) : undefined;
      if (sameOriginOnly && landed && landed.origin !== origin) {
        log(`  ⊘ ${canon} — redirects to ${landed.origin}, outside the site`);
        await sleep(delayMs);
        continue;
      }

      const id = uniqueId(routeId(canon), [
        ...(limit.takenIds ?? []),
        ...have.map((r) => r.id),
        ...routes.map((r) => r.id),
      ]);
      routes.push({
        id,
        url: canon,
        // The site serves this page at the path with a slash on the end: the
        // canonical path drops it, and a server may answer that with a 404.
        ...(landed &&
        landed.pathname.length > 1 &&
        landed.pathname.endsWith("/") &&
        canonicalPath(landed, hashRoutes) === canon
          ? { trailingSlash: true }
          : {}),
        // page.url() is only meaningful if the navigation landed — after a failed
        // goto it still points at the *previous* page.
        finalUrl: navigated ? relativeToOrigin(page.url(), origin, hashRoutes) : undefined,
        title,
        status,
        depth: item.depth,
        discoveredFrom: item.from,
        links: dedupeLinks(links, origin, hashRoutes),
        states: [],
      });
      log(`  • ${canon}${title ? ` — ${title}` : ""}`);

      if (item.depth < maxDepth) {
        for (const href of links) {
          try {
            const u = new URL(href);
            if (u.origin !== origin) continue;
            const linkCanon = canonicalPath(u, hashRoutes);
            if (
              visited.has(origin + linkCanon) ||
              !inScope(scopePath(u, hashRoutes), include, exclude, linkCanon)
            )
              continue;
            // As the page wrote it (`/docs/`), not the canonical form: some servers
            // answer only that one.
            u.hash = hashPart(u, hashRoutes);
            enqueue(u.href, item.depth + 1, canon);
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
  for (const x of samples.filter((x) => x.skipped)) {
    log(`  sampled ${x.glob}: kept ${x.max}, skipped ${x.skipped}`);
  }
  return routes;
}
