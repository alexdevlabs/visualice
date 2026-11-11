import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigSchema } from "../../src/shared/config";
import { discoverPipeline } from "../../src/crawl/discover";
import { crawlPipeline } from "../../src/crawl/orchestrator";
import { promises as fs } from "node:fs";
import path from "node:path";
import { silent, tempDir } from "./helpers";

/**
 * A probe clicks, waits `settleMs`, and looks for what opened. A dialog that needs
 * a request first (its code, its data, a busy dev server) shows up later than that,
 * and used to be taken for a button that does nothing. Now the probe keeps looking
 * while the click is still loading, and says which triggers showed nothing.
 */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Queues</title>
<style>[role=dialog]{position:fixed;top:40px;left:40px;width:240px;height:120px;background:#fff;border:1px solid}</style>
</head><body>
  <h1>Queues</h1>
  <button id="redrive">Redrive All</button>
  <button id="refresh">Refresh</button>
  <button id="ping">Ping</button>
  <button id="stuck">Export log</button>
  <div id="confirm" role="dialog" aria-label="Redrive all queues?" hidden>Redrive all queues?</div>
  <script>
    const d = document.getElementById("confirm");
    // Opens only once its data has loaded, as a lazily loaded dialog does.
    document.getElementById("redrive").addEventListener("click", async () => {
      await fetch("/slow.json");
      d.hidden = false;
    });
    document.getElementById("refresh").addEventListener("click", () => {});
    // Loads something and shows nothing for it.
    document.getElementById("ping").addEventListener("click", () => fetch("/slow.json"));
    // Still loading when any probe would give up.
    document.getElementById("stuck").addEventListener("click", () => fetch("/stuck.json"));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") d.hidden = true; });
  </script>
</body></html>`;

// A page that is never idle: a ticker rewrites the DOM and a poll asks the server,
// with nobody touching it. Its buttons do nothing.
const RESTLESS = `<!doctype html><html><head><meta charset="utf-8"><title>Live</title></head><body>
  <h1>Live</h1>
  <p id="tick">0</p>
  <button>Refresh</button>
  <button>Sort</button>
  <button>Filter</button>
  <button>Export</button>
  <script>
    let n = 0;
    setInterval(() => { document.getElementById("tick").textContent = String(++n); }, 40);
    setInterval(() => fetch("/poll.json?t=" + n), 120);
  </script>
</body></html>`;

async function serve(page = PAGE): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const delay =
      req.url === "/slow.json"
        ? 800
        : req.url === "/stuck.json"
          ? 15_000
          : req.url?.startsWith("/poll.json")
            ? 200
            : 0;
    const body = req.url?.includes(".json") ? "{}" : page;
    const timer = setTimeout(() => {
      res.writeHead(200, {
        "content-type": req.url?.includes(".json") ? "application/json" : "text/html",
      });
      res.end(body);
    }, delay);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const run = async (interactions: Record<string, unknown>, page = PAGE) => {
  const site = await serve(page);
  try {
    const started = Date.now();
    const found = await discoverPipeline({
      config: ConfigSchema.parse({
        routesFile: false,
        scope: { maxPages: 1 },
        politeness: { minDelayMs: 0 },
        stabilize: { waitStrategy: "load" },
        discovery: {
          mobileStates: false,
          interactions: { formStates: false, hover: false, ...interactions },
        },
      }),
      baseUrl: site.url,
    });
    return {
      states: found.routes[0].states.map((s) => s.label),
      quiet: found.quiet ?? [],
      ms: Date.now() - started,
    };
  } finally {
    await site.close();
  }
};

describe("probing a page that is slow to answer a click", () => {
  it("finds a dialog that opens after a slow request, and says what showed nothing", async () => {
    const { states, quiet } = await run({});
    expect(states).toContain("Redrive All");
    const result = Object.fromEntries(quiet.map((q) => [q.trigger, q.result]));
    expect(result).toEqual({
      '"Refresh"': "no change",
      // Loaded, finished, and still nothing: a button that does nothing visible.
      '"Ping"': "no change",
      // Still loading when the probe stopped looking: worth a look.
      '"Export log"': "busy",
    });
    expect(quiet.every((q) => q.route === "/")).toBe(true);
  }, 60_000);

  it("misses it when the probe looks only once, and says the page was still loading", async () => {
    const { states, quiet } = await run({ patienceMs: 0 });
    expect(states).not.toContain("Redrive All");
    expect(quiet.find((q) => q.trigger === '"Redrive All"')?.result).toBe("busy");
  }, 60_000);

  it("doesn't make a button that does nothing wait out the patience", async () => {
    // Ten seconds of patience: only the trigger still loading may use it all.
    const { ms } = await run({ patienceMs: 10_000 });
    const { ms: once } = await run({ patienceMs: 0 });
    // The dialog's request (0.8s), Ping's (0.8s) and Export log's full ten seconds.
    expect(ms - once).toBeLessThan(10_000 + 2 * 800 + 1500);
    expect(ms - once).toBeGreaterThan(10_000);
  }, 90_000);

  it("doesn't take a page that changes and polls on its own for a click still loading", async () => {
    const { quiet, ms } = await run({ patienceMs: 5000 }, RESTLESS);
    expect(quiet.map((q) => [q.trigger, q.result])).toEqual([
      ['"Refresh"', "no change"],
      ['"Sort"', "no change"],
      ['"Filter"', "no change"],
      ['"Export"', "no change"],
    ]);
    // Only the first button waits out the patience, which is how the page is found
    // out; the other three cost what a button that does nothing always did.
    expect(ms).toBeLessThan(5000 + 5000);
  }, 90_000);

  it("puts the list in the run's report, and keeps it out of the cached model", async () => {
    const site = await serve();
    const out = await tempDir("patience");
    try {
      const config = ConfigSchema.parse({
        routesFile: false,
        scope: { maxPages: 1 },
        politeness: { minDelayMs: 0 },
        stabilize: { waitStrategy: "load" },
        devices: [{ name: "desktop", width: 1280, height: 800 }],
        output: { dir: out },
        discovery: {
          mobileStates: false,
          interactions: { formStates: false, hover: false, patienceMs: 1200 },
        },
      });
      const { runDir, manifest } = await crawlPipeline({ config, baseUrl: site.url, log: silent });
      expect(manifest.stats?.quiet?.find((q) => q.trigger === '"Export log"')?.result).toBe("busy");
      const report = await fs.readFile(path.join(runDir, "crawl-report.md"), "utf8");
      expect(report).toContain("## Clicked, nothing opened");
      expect(report).toContain('| `/` | "Export log" | **still loading** |');
      const cached = await fs.readFile(path.join(out, "crawl-map.cache.json"), "utf8");
      expect(cached).not.toContain("quiet");
    } finally {
      await site.close();
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 90_000);
});
