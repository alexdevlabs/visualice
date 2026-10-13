import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { ConfigSchema, type Config, type VisualiceConfig } from "../src/shared/config";
import { discoverRoutes } from "../src/crawl/discover-routes";

/**
 * Route discovery's decisions — how far it follows links, when it stops, what it
 * seeds from — don't need a browser to exercise, only something that answers
 * "what does this page link to". The fake below is exactly that surface: the five
 * Playwright calls `discoverRoutes` makes, over an in-memory site.
 */

const ORIGIN = "https://site.test";

/** path → the hrefs that page links to. A path that isn't here fails to load. */
type Site = Record<string, string[]>;

function fakeContext(site: Site) {
  const visited: string[] = [];
  let current = `${ORIGIN}/`;
  const page = {
    goto: async (url: string) => {
      visited.push(new URL(url).pathname + new URL(url).search);
      if (!(new URL(url).pathname in site)) throw new Error(`net::ERR_ABORTED at ${url}`);
      current = url;
      return { status: () => 200 };
    },
    title: async () => `Page ${new URL(current).pathname}`,
    $$eval: async () => (site[new URL(current).pathname] ?? []).map((h) => new URL(h, ORIGIN).href),
    url: () => current,
    close: async () => {},
  };
  return {
    visited,
    context: { newPage: async () => page } as unknown as BrowserContext,
  };
}

const config = (over: Partial<VisualiceConfig> = {}): Config =>
  ConfigSchema.parse({
    target: ORIGIN,
    // No robots fetch and no sitemap fetch unless a test asks for one.
    politeness: { respectRobots: false, minDelayMs: 0, retries: 0 },
    discovery: { useSitemap: false },
    ...over,
  });

async function crawl(site: Site, cfg = config()) {
  const { context, visited } = fakeContext(site);
  const logs: string[] = [];
  const routes = await discoverRoutes(context, cfg, `${ORIGIN}/`, (m) => logs.push(m));
  return { routes, urls: routes.map((r) => r.url), visited, logs };
}

/** Answers `politeFetch` (robots.txt, sitemaps) from a map of path → body; 404 otherwise. */
function stubFetch(files: Record<string, string>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const body = files[new URL(url).pathname];
    return body === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => body };
  });
}

const urlset = (...paths: string[]) =>
  `<?xml version="1.0"?><urlset>${paths.map((p) => `<loc>${p}</loc>`).join("")}</urlset>`;

const CHAIN: Site = { "/": ["/a", "/b"], "/a": ["/c"], "/b": [], "/c": [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("maxDepth", () => {
  it("captures only the entry point at depth 0", async () => {
    const { urls } = await crawl(CHAIN, config({ scope: { maxDepth: 0 } }));
    expect(urls).toEqual(["/"]);
  });

  it("follows one hop at depth 1 but does not read the links it finds there", async () => {
    const { urls } = await crawl(CHAIN, config({ scope: { maxDepth: 1 } }));
    expect(urls).toEqual(["/", "/a", "/b"]);
  });

  it("reaches the grandchild at depth 2", async () => {
    const { routes } = await crawl(CHAIN, config({ scope: { maxDepth: 2 } }));
    expect(routes.map((r) => [r.url, r.depth])).toEqual([
      ["/", 0],
      ["/a", 1],
      ["/b", 1],
      ["/c", 2],
    ]);
  });

  it("records where each route was discovered from", async () => {
    const { routes } = await crawl(CHAIN, config({ scope: { maxDepth: 2 } }));
    expect(routes.map((r) => r.discoveredFrom)).toEqual([null, "/", "/", "/a"]);
  });
});

describe("maxPages", () => {
  it("stops crawling once the cap is reached, however much is still queued", async () => {
    const { urls, visited } = await crawl(CHAIN, config({ scope: { maxDepth: 4, maxPages: 2 } }));
    expect(urls).toEqual(["/", "/a"]);
    expect(visited).toHaveLength(2); // the cap is a navigation budget, not a filter
  });

  it("keeps everything when the cap is larger than the site", async () => {
    const { urls } = await crawl(CHAIN, config({ scope: { maxDepth: 4, maxPages: 50 } }));
    expect(urls).toEqual(["/", "/a", "/b", "/c"]);
  });
});

describe("scope", () => {
  it("never navigates to an excluded path", async () => {
    const site: Site = { "/": ["/a", "/admin/users"], "/a": [], "/admin/users": [] };
    const { urls, visited } = await crawl(
      site,
      config({ scope: { exclude: ["/admin/**"], maxDepth: 2 } }),
    );
    expect(urls).toEqual(["/", "/a"]);
    expect(visited).not.toContain("/admin/users");
  });

  it("only crawls what the include globs cover", async () => {
    const site: Site = { "/": ["/docs/a", "/blog/b"], "/docs/a": [], "/blog/b": [] };
    const { urls } = await crawl(
      site,
      config({ scope: { include: ["/", "/docs/**"], maxDepth: 2 } }),
    );
    expect(urls).toEqual(["/", "/docs/a"]);
  });

  it("never leaves the target origin", async () => {
    const site: Site = { "/": ["https://other.test/x", "/a"], "/a": [] };
    const { routes, urls } = await crawl(site, config({ scope: { maxDepth: 2 } }));
    expect(urls).toEqual(["/", "/a"]);
    // The off-origin href isn't recorded as an outbound link either.
    expect(routes[0].links).toEqual(["/a"]);
  });

  it("treats urls that canonicalize the same as one route", async () => {
    const site: Site = { "/": ["/a", "/a/", "/a?utm_source=news", "/a#top"], "/a": [] };
    const { urls, visited } = await crawl(site, config({ scope: { maxDepth: 2 } }));
    expect(urls).toEqual(["/", "/a"]);
    expect(visited.filter((v) => v.startsWith("/a"))).toHaveLength(1);
  });
});

describe("seeds", () => {
  it("crawls configured seeds at depth 0, even with nothing linking to them", async () => {
    const site: Site = { "/": [], "/orphan": [] };
    const { routes } = await crawl(site, config({ seeds: ["/orphan"], scope: { maxDepth: 0 } }));
    expect(routes.map((r) => [r.url, r.depth])).toEqual([
      ["/", 0],
      ["/orphan", 0],
    ]);
  });

  it("ignores a seed that isn't a usable url", async () => {
    const { urls } = await crawl(
      { "/": [] },
      config({ seeds: ["http://"], scope: { maxDepth: 0 } }),
    );
    expect(urls).toEqual(["/"]);
  });
});

describe("sitemap seeding", () => {
  const sitemapConfig = (over: Partial<VisualiceConfig> = {}) =>
    config({ discovery: { useSitemap: true }, scope: { maxDepth: 0 }, ...over });

  it("seeds routes from /sitemap.xml that links alone would never reach", async () => {
    stubFetch({ "/sitemap.xml": urlset(`${ORIGIN}/x`, `${ORIGIN}/y`) });
    const { urls } = await crawl({ "/": [], "/x": [], "/y": [] }, sitemapConfig());
    expect(urls).toEqual(["/", "/x", "/y"]);
  });

  it("follows a sitemap index down to the sitemaps it lists", async () => {
    stubFetch({
      "/sitemap.xml": `<?xml version="1.0"?><sitemapindex><loc>${ORIGIN}/sitemap-1.xml</loc></sitemapindex>`,
      "/sitemap-1.xml": urlset(`${ORIGIN}/x`),
    });
    const { urls } = await crawl({ "/": [], "/x": [] }, sitemapConfig());
    expect(urls).toEqual(["/", "/x"]);
  });

  it("also reads the sitemaps robots.txt declares", async () => {
    stubFetch({
      "/robots.txt": `Sitemap: ${ORIGIN}/extra.xml\n`,
      "/extra.xml": urlset(`${ORIGIN}/x`),
    });
    const { urls } = await crawl({ "/": [], "/x": [] }, sitemapConfig());
    expect(urls).toEqual(["/", "/x"]);
  });

  it("drops sitemap entries that point at another origin", async () => {
    stubFetch({ "/sitemap.xml": urlset("https://other.test/z", `${ORIGIN}/x`) });
    const { urls, visited } = await crawl({ "/": [], "/x": [] }, sitemapConfig());
    expect(urls).toEqual(["/", "/x"]);
    expect(visited).not.toContain("/z");
  });

  it("never seeds more than maxPages worth of urls", async () => {
    stubFetch({
      "/sitemap.xml": urlset(...["a", "b", "c", "d", "e"].map((p) => `${ORIGIN}/${p}`)),
    });
    const site: Site = { "/": [], "/a": [], "/b": [], "/c": [], "/d": [], "/e": [] };
    const { urls } = await crawl(site, sitemapConfig({ scope: { maxDepth: 0, maxPages: 3 } }));
    expect(urls).toEqual(["/", "/a", "/b"]);
  });

  it("carries on crawling when the sitemap is missing or unreadable", async () => {
    stubFetch({}); // every fetch 404s
    const { urls } = await crawl({ "/": ["/a"], "/a": [] }, sitemapConfig({ scope: {} }));
    expect(urls).toEqual(["/", "/a"]);
  });
});

describe("navigation failures", () => {
  it("still records a route whose page never loaded, without inventing a final url", async () => {
    const { routes, logs } = await crawl({ "/": ["/gone"] }, config({ scope: { maxDepth: 2 } }));
    const gone = routes[1];
    expect(gone.url).toBe("/gone");
    expect(gone.finalUrl).toBeUndefined(); // the page never moved — don't claim it did
    expect(gone.status).toBeUndefined();
    expect(gone.title).toBeUndefined();
    expect(logs.join("\n")).toContain("! /gone");
  });

  it("retries a failed navigation as many times as politeness.retries allows", async () => {
    const { visited, logs } = await crawl(
      { "/": ["/gone"] },
      config({
        scope: { maxDepth: 2 },
        politeness: { respectRobots: false, minDelayMs: 0, retries: 2 },
      }),
    );
    expect(visited.filter((v) => v === "/gone")).toHaveLength(3); // the attempt plus 2 retries
    expect(logs.filter((l) => l.includes("↻ /gone"))).toHaveLength(2);
  });
});

describe("limit", () => {
  it("only visits the listed pages: no start page, no link following", async () => {
    const { context, visited } = fakeContext(CHAIN);
    const routes = await discoverRoutes(context, config(), `${ORIGIN}/`, () => {}, {
      only: ["/a"],
      takenIds: ["a"],
    });
    expect(visited).toEqual(["/a"]);
    expect(routes.map((r) => [r.url, r.links])).toEqual([["/a", []]]);
    // An id the merged-into model already uses is not handed out again.
    expect(routes[0].id).not.toBe("a");
  });
});
