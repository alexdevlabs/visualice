import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema } from "../../src/shared/config";
import { discoverPipeline } from "../../src/crawl/discover";
import { runCapture } from "../../src/crawl/capture";
import type { Manifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir, walk } from "./helpers";

/**
 * A hash-routed SPA, end to end. Every route of one shares a pathname and a
 * document, so it is the case that collapses to a single screenshot unless the
 * fragment is treated as route identity and each route is re-rendered from cold.
 */
const SPA = `<!doctype html>
<html><head><meta charset="utf-8"><title>SPA</title></head>
<body>
  <nav>
    <a href="#/">home</a>
    <a href="#/about">about</a>
    <a href="#/pricing">pricing</a>
    <a href="#/docs/install">install</a>
  </nav>
  <main id="view">…</main>
  <script>
    const VIEWS = {
      "": ["Home", "the landing view"],
      "/about": ["About", "who we are"],
      "/pricing": ["Pricing", "what it costs"],
      "/docs/install": ["Install", "how to start"],
    };
    function render() {
      const key = location.hash.replace(/^#/, "").replace(/\\/$/, "");
      const [title, body] = VIEWS[key] || ["Not found", "no such view"];
      document.title = title;
      const view = document.getElementById("view");
      view.textContent = "";
      const h = document.createElement("h1");
      h.setAttribute("data-view", key || "/");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = body;
      view.append(h, p);
    }
    addEventListener("hashchange", render);
    render();
  </script>
</body></html>`;

/** Same links, but as in-page anchors — these must stay one route. */
const ANCHORS = `<!doctype html>
<html><head><meta charset="utf-8"><title>Docs</title></head>
<body>
  <a href="#install">install</a> <a href="#usage">usage</a>
  <h2 id="install">Install</h2><h2 id="usage">Usage</h2>
</body></html>`;

const config = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    routesFile: false,
    scope: { maxPages: 20, maxDepth: 2, ...(over.scope as object) },
    devices: [{ name: "desktop", width: 900, height: 600 }],
    politeness: { minDelayMs: 0 },
    discovery: { useSitemap: false, mobileStates: false, interactions: { auto: false } },
    stabilize: { waitStrategy: "domcontentloaded" },
    screenshot: { fullPage: false },
  });

async function withSite<T>(
  files: Record<string, string>,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const { server, dir } = await serveFiles(files);
  try {
    return await fn(server.url);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("hash-routed SPAs", () => {
  it("discovers one route per client-side view", async () => {
    await withSite({ "index.html": SPA }, async (url) => {
      const m = await discoverPipeline({ config: config(), baseUrl: url, log: silent });
      expect(m.routes.map((r) => r.url).sort()).toEqual([
        "/",
        "/#/about",
        "/#/docs/install",
        "/#/pricing",
      ]);
    });
  }, 60_000);

  it("collapses them all into one route when told fragments are anchors", async () => {
    await withSite({ "index.html": SPA }, async (url) => {
      const m = await discoverPipeline({
        config: config({ scope: { hashRoutes: "never" } }),
        baseUrl: url,
        log: silent,
      });
      expect(m.routes.map((r) => r.url)).toEqual(["/"]);
    });
  }, 60_000);

  it("leaves a page's in-page anchors as one route", async () => {
    await withSite({ "index.html": ANCHORS }, async (url) => {
      const m = await discoverPipeline({ config: config(), baseUrl: url, log: silent });
      expect(m.routes.map((r) => r.url)).toEqual(["/"]);
    });
  }, 60_000);

  it("captures each view's own content, not whichever rendered first", async () => {
    // The actual failure mode: changing only the fragment is a same-document
    // navigation, so without a reload every shot shows the view the page happened
    // to load with.
    await withSite({ "index.html": SPA }, async (url) => {
      const runDir = await tempDir("hash-capture");
      try {
        const cfg = config();
        const input = await discoverPipeline({ config: cfg, baseUrl: url, log: silent });
        const manifest: Manifest = {
          version: 1,
          site: {
            baseUrl: url,
            origin: new URL(url).origin,
            runId: "hash-routes",
            generatedAt: new Date(0).toISOString(),
          },
          devices: cfg.devices,
          routes: input.routes,
        };
        const result = await runCapture({
          config: cfg,
          manifest,
          baseUrl: url,
          runDir,
          log: silent,
        });
        expect(result.failures).toEqual([]);
        expect(result.shots).toBe(4);

        // One directory per route — the proof that they didn't overwrite each other.
        const files = await walk(path.join(runDir, "screenshots"));
        const dirs = new Set(files.map((f) => f.split("/").slice(0, -1).join("/")));
        expect([...dirs].sort()).toEqual([
          "home/default",
          "home__h-about/default",
          "home__h-docs--install/default",
          "home__h-pricing/default",
        ]);

        // Each sidecar records the URL its own shot was taken at…
        const urls = await Promise.all(
          [...dirs].sort().map(async (d) => {
            const raw = await fs.readFile(
              path.join(runDir, "screenshots", d, "desktop.json"),
              "utf8",
            );
            return new URL((JSON.parse(raw) as { url: string }).url).hash;
          }),
        );
        expect(urls).toEqual(["", "#/about", "#/docs/install", "#/pricing"]);

        // …and the shots are genuinely different images, which is what would fail
        // if every route had screenshotted the same rendered view.
        const bytes = await Promise.all(
          [...dirs]
            .sort()
            .map((d) => fs.readFile(path.join(runDir, "screenshots", d, "desktop.png"))),
        );
        expect(new Set(bytes.map((b) => b.toString("base64"))).size).toBe(4);
      } finally {
        await fs.rm(runDir, { recursive: true, force: true });
      }
    });
  }, 120_000);
});
