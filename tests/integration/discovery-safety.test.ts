import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { ConfigSchema } from "../../src/shared/config";
import { discoverPipeline } from "../../src/crawl/discover";
import { captureScreens } from "../../src/crawl/screens";
import { stabilizePage } from "../../src/crawl/stabilize";
import { launchOptions } from "../../src/shared/launch";

/**
 * What discovery must not do to a site, and what it must not miss: found by
 * running it against small servers that log every request they get.
 */

interface Site {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

async function serve(
  pages: Record<string, string | ((res: http.ServerResponse) => void)>,
): Promise<Site> {
  const requests: string[] = [];
  // A map, so a request for `/constructor` finds no page instead of Object's own.
  const byPath = new Map(Object.entries(pages));
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const page = byPath.get(req.url ?? "/");
    if (typeof page === "function") return page(res);
    if (page === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>404</title><h1>Not found</h1>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>T</title>
      <style>[role=dialog]{position:fixed;top:40px;left:40px;width:240px;height:120px;background:#fff;border:1px solid}</style>
      </head><body>${page}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const open: Site[] = [];
const site = async (...args: Parameters<typeof serve>) => {
  const s = await serve(...args);
  open.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

const discover = (baseUrl: string, over: Record<string, unknown> = {}) =>
  discoverPipeline({
    config: ConfigSchema.parse({
      routesFile: false,
      politeness: { minDelayMs: 0, respectRobots: false },
      stabilize: { waitStrategy: "load" },
      discovery: {
        useSitemap: false,
        mobileStates: false,
        interactions: { formStates: false, hover: false },
      },
      ...over,
    }),
    baseUrl,
  });

describe("discovery", () => {
  it("never submits a form, whatever its button is called", async () => {
    const s = await site({
      "/": `<h1>Shop</h1>
        <form method="post" action="/cart/add"><input name="sku" value="1"><button>Add to cart</button></form>
        <form method="post" action="/newsletter"><input type="image" alt="Join" src="data:,"></form>
        <form method="post" action="/wrapped"><button><span role="button">Buy now</span></button></form>
        <button id="help">Help</button>
        <div id="d" role="dialog" aria-label="Help" hidden>Help</div>
        <script>document.getElementById("help").onclick = () => { document.getElementById("d").hidden = false; };</script>`,
    });
    const found = await discover(s.url, { scope: { maxPages: 1 } });
    expect(s.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    // A button outside any form is still probed.
    expect(found.routes[0].states.map((x) => x.label)).toContain("Help");
  }, 60_000);

  it("leaves alone a page that redirects to another site", async () => {
    const other = await site({
      "/landing": `<h1>Partner</h1><button onclick="fetch('/clicked', {method: 'POST'})">Accept</button>`,
    });
    const s = await site({
      "/": `<h1>Home</h1><a href="/out">Partner</a><a href="/about">About</a>`,
      "/about": `<h1>About</h1>`,
      "/out": (res) => {
        res.writeHead(302, { location: `${other.url}landing` });
        res.end();
      },
    });
    const found = await discover(s.url);
    expect(found.routes.map((r) => r.url).sort()).toEqual(["/", "/about"]);
    expect(other.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  }, 60_000);

  // A sidebar whose groups render their links only once clicked open.
  const nav = `<nav>
      <a href="/">Home</a>
      <button id="fin" aria-expanded="false" aria-controls="fin-links">Finance</button>
      <div id="fin-links"></div>
    </nav>
    <script>
      document.getElementById("fin").onclick = (e) => {
        const open = e.currentTarget.getAttribute("aria-expanded") === "true";
        e.currentTarget.setAttribute("aria-expanded", String(!open));
        document.getElementById("fin-links").innerHTML = open
          ? ""
          : '<a href="/payments">Payments</a><a href="/credit-notes">Credit notes</a><a href="/login">Sign in</a>';
      };
    </script>`;
  const folded = () =>
    site({
      "/": `<h1>Dashboard</h1>${nav}`,
      "/payments": `<h1>Payments</h1>${nav}<a href="/payments/42">Payment 42</a>`,
      "/payments/42": `<h1>Payment 42</h1>${nav}`,
      "/credit-notes": `<h1>Credit notes</h1>${nav}`,
      "/login": `<h1>Sign in</h1>`,
    });

  it("finds the pages behind a menu group that renders its links when opened", async () => {
    const s = await folded();
    const found = await discover(s.url, { scope: { exclude: ["/login**"] } });
    expect(found.routes.map((r) => r.url).sort()).toEqual([
      "/",
      "/credit-notes",
      "/payments",
      "/payments/42",
    ]);
    const payments = found.routes.find((r) => r.url === "/payments")!;
    expect(payments).toMatchObject({ discoveredFrom: "/", depth: 1 });
    // Each page is loaded for mapping once, not again by a later round.
    expect(found.routes.every((r) => r.states.length >= 1)).toBe(true);
    expect(s.requests).not.toContain("GET /login");
  }, 120_000);

  it("keeps to the page limit and the depth when following revealed links", async () => {
    const s = await folded();
    const capped = await discover(s.url, { scope: { maxPages: 2 } });
    expect(capped.routes).toHaveLength(2);
    const shallow = await discover(s.url, { scope: { maxDepth: 0 } });
    expect(shallow.routes.map((r) => r.url)).toEqual(["/"]);
  }, 120_000);

  it("denies a label as whole words: a menu group with the word inside its name is opened", async () => {
    const s = await site({
      "/": `<h1>Admin</h1>
        <button data-d="g">Network Importers</button>
        <button data-d="i">Import CSV</button>
        <div id="g" role="dialog" aria-label="Importers" hidden>Importers</div>
        <div id="i" role="dialog" aria-label="Import" hidden>Import</div>
        <script>
          for (const b of document.querySelectorAll("button[data-d]")) {
            b.onclick = () => { document.getElementById(b.dataset.d).hidden = false; };
          }
        </script>`,
    });
    const found = await discover(s.url, {
      scope: { maxPages: 1 },
      discovery: {
        useSitemap: false,
        mobileStates: false,
        interactions: { formStates: false, hover: false, denyLabels: ["import"] },
      },
    });
    const labels = found.routes[0].states.map((x) => x.label);
    expect(labels).toContain("Network Importers");
    expect(labels).not.toContain("Import CSV");
  }, 60_000);

  it("leaves out the query variants a glob with a ? names, keeping the page itself", async () => {
    const s = await site({
      "/": `<h1>Home</h1><a href="/metrics">Metrics</a>
        <a href="/metrics?network=A">A</a><a href="/metrics?network=B">B</a><a href="/list?page=2">More</a>`,
      "/metrics": `<h1>Metrics</h1>`,
      "/metrics?network=A": `<h1>A</h1>`,
      "/metrics?network=B": `<h1>B</h1>`,
      "/list?page=2": `<h1>List</h1>`,
    });
    const found = await discover(s.url, { scope: { exclude: ["/metrics?*"] } });
    expect(found.routes.map((r) => r.url).sort()).toEqual(["/", "/list?page=2", "/metrics"]);
    expect(s.requests.filter((r) => r.includes("network="))).toEqual([]);
  }, 60_000);

  it("probes each of several buttons with one name, and a name inside another's", async () => {
    const s = await site({
      "/": `<h1>Cards</h1>
        <button data-d="a">Details</button>
        <button data-d="b">Details</button>
        <button data-d="m">Menu</button>
        <button data-d="x">Close menu</button>
        <div id="a" role="dialog" aria-label="First card" hidden>First card</div>
        <div id="b" role="dialog" aria-label="Second card" hidden>Second card</div>
        <div id="m" role="dialog" aria-label="Site menu" hidden>Site menu</div>
        <script>
          for (const b of document.querySelectorAll("button[data-d]")) {
            b.onclick = () => { const d = document.getElementById(b.dataset.d); if (d) d.hidden = false; };
          }
          document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") for (const d of document.querySelectorAll("[role=dialog]")) d.hidden = true;
          });
        </script>`,
    });
    const found = await discover(s.url, { scope: { maxPages: 1 } });
    const states = found.routes[0].states.filter((x) => x.id !== "default");
    expect(states).toHaveLength(3);
    expect((found.quiet ?? []).filter((q) => q.result === "click failed")).toEqual([]);
    // Each recipe names one button: it replays.
    const targets = states.map(
      (x) => (x.recipe[0] as unknown as { target: Record<string, unknown> }).target,
    );
    expect(targets).toContainEqual({ role: "button", name: "Menu", exact: true });
    expect(targets).toContainEqual({ role: "button", name: "Details", exact: true, nth: 0 });
    expect(targets).toContainEqual({ role: "button", name: "Details", exact: true, nth: 1 });
  }, 60_000);

  it("loads a page at the path the site links to, trailing slash and all", async () => {
    const s = await site({
      "/": `<h1>Home</h1><a href="/docs/">Docs</a>`,
      "/docs/": `<h1>Docs</h1><a href="/docs/deep/">Deep</a>`,
      "/docs/deep/": `<h1>Deep</h1>`,
    });
    const found = await discover(s.url);
    const docs = found.routes.find((r) => r.url === "/docs")!;
    expect(docs.status).toBe(200);
    expect(docs.trailingSlash).toBe(true);
    expect(found.routes.map((r) => r.url).sort()).toEqual(["/", "/docs", "/docs/deep"]);
    expect(s.requests).not.toContain("GET /docs");
  }, 60_000);
});

describe("capturing", () => {
  it("scrolls an app shell that locks the page and scrolls inside, but not under a modal", async () => {
    const browser = await chromium.launch(launchOptions());
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      const shell = (extra = "") => `<!doctype html><html><head><style>
          html,body{height:100%;margin:0;overflow:hidden}
          main{height:100%;overflow-y:auto}
          .tall{height:3000px;background:linear-gradient(#fff,#888)}
        </style></head><body><main><div class="tall">content</div></main>${extra}</body></html>`;
      const shoot = () =>
        captureScreens(page, {
          maxHeight: 25000,
          settleMs: 0,
          type: "png",
          quality: 80,
          mask: [],
          keepScroll: false,
        });
      await page.setContent(shell());
      expect((await shoot()).frames.length).toBeGreaterThan(3);
      await page.setContent(
        shell(
          `<div role="dialog" aria-modal="true" style="position:fixed;inset:100px;background:#fff">Sure?</div>`,
        ),
      );
      expect((await shoot()).frames).toHaveLength(1);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("doesn't wait for ever on a font that never arrives", async () => {
    const s = await site({
      "/": `<style>@font-face{font-family:Late;src:url(/font.woff2)}</style><h1>Title</h1>
        <button onclick="document.querySelector('h1').style.fontFamily='Late'">Use font</button>`,
      "/font.woff2": () => {
        /* never answers */
      },
    });
    const browser = await chromium.launch(launchOptions());
    try {
      const page = await browser.newPage();
      await page.goto(s.url);
      await page.getByRole("button", { name: "Use font" }).click();
      const config = ConfigSchema.parse({ stabilize: { waitStrategy: "load" } });
      const started = Date.now();
      await stabilizePage(page, config.stabilize);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
