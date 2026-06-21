import type { BrowserContext } from "playwright";
import type { Config } from "../shared/config";
import type { RouteNode } from "../shared/types";
import { inScope } from "../shared/glob";
import { pathSlug } from "../shared/slug";
import { sleep } from "../shared/pool";

function routeId(pathname: string): string {
  return pathSlug(pathname).replace(/\//g, "-");
}

function normPath(pathname: string): string {
  const x = pathname.replace(/\/+$/, "");
  return x === "" ? "/" : x;
}

function uniqueRouteId(base: string, routes: RouteNode[]): string {
  if (!routes.some((r) => r.id === base)) return base;
  let n = 2;
  while (routes.some((r) => r.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function dedupeLinks(links: string[], origin: string): string[] {
  const out = new Set<string>();
  for (const href of links) {
    try {
      const u = new URL(href);
      if (u.origin === origin) out.add(normPath(u.pathname));
    } catch {
      /* skip */
    }
  }
  return [...out];
}

async function fetchSitemapUrls(baseUrl: string, origin: string): Promise<string[]> {
  const candidates = [new URL("/sitemap.xml", baseUrl).href];
  try {
    const robots = await fetch(new URL("/robots.txt", baseUrl).href);
    if (robots.ok) {
      const txt = await robots.text();
      for (const m of txt.matchAll(/sitemap:\s*(\S+)/gi)) candidates.push(m[1]);
    }
  } catch {
    /* no robots */
  }
  const out: string[] = [];
  for (const sm of candidates) {
    try {
      const r = await fetch(sm);
      if (!r.ok) continue;
      const xml = await r.text();
      for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
        const u = m[1].trim();
        try {
          if (new URL(u).origin === origin) out.push(u);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** BFS link crawl (+ sitemap) confined to the target origin and scope rules. */
export async function discoverRoutes(
  context: BrowserContext,
  config: Config,
  baseUrl: string,
  log: (msg: string) => void,
): Promise<RouteNode[]> {
  const origin = new URL(baseUrl).origin;
  const { include, exclude, maxDepth, maxPages, sameOriginOnly } = config.scope;

  const visited = new Set<string>();
  const routes: RouteNode[] = [];
  const queue: { url: string; depth: number; from: string | null }[] = [];
  const enqueue = (url: string, depth: number, from: string | null) => queue.push({ url, depth, from });

  enqueue(baseUrl, 0, null);
  for (const s of config.seeds) {
    try {
      enqueue(new URL(s, baseUrl).href, 0, null);
    } catch {
      /* skip bad seed */
    }
  }
  if (config.discovery.useSitemap) {
    for (const u of await fetchSitemapUrls(baseUrl, origin)) enqueue(u, 0, null);
  }

  const page = await context.newPage();
  try {
    while (queue.length && routes.length < maxPages) {
      const item = queue.shift()!;
      let pathname: string;
      try {
        const u = new URL(item.url);
        if (sameOriginOnly && u.origin !== origin) continue;
        pathname = normPath(u.pathname);
      } catch {
        continue;
      }
      const key = origin + pathname;
      if (visited.has(key)) continue;
      if (!inScope(pathname, include, exclude)) continue;
      visited.add(key);

      let status: number | undefined;
      let title: string | undefined;
      let links: string[] = [];
      try {
        const resp = await page.goto(item.url, {
          waitUntil: "domcontentloaded",
          timeout: config.politeness.timeoutMs,
        });
        status = resp?.status();
        title = await page.title().catch(() => undefined);
        if (item.depth < maxDepth) {
          links = await page.$$eval("a[href]", (els) => els.map((e) => (e as HTMLAnchorElement).href));
        }
      } catch (e) {
        log(`  ! ${pathname}: ${(e as Error).message.split("\n")[0]}`);
      }

      const id = uniqueRouteId(routeId(pathname), routes);
      routes.push({
        id,
        url: pathname,
        finalUrl: page.url(),
        title,
        status,
        depth: item.depth,
        discoveredFrom: item.from,
        links: dedupeLinks(links, origin),
        states: [],
      });
      log(`  • ${pathname}${title ? ` — ${title}` : ""}`);

      if (item.depth < maxDepth) {
        for (const href of links) {
          try {
            const u = new URL(href);
            if (u.origin !== origin) continue;
            const np = normPath(u.pathname);
            if (visited.has(origin + np) || !inScope(np, include, exclude)) continue;
            enqueue(origin + np, item.depth + 1, pathname);
          } catch {
            /* skip */
          }
        }
      }
      await sleep(config.politeness.minDelayMs);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return routes;
}
