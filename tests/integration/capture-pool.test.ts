import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import sharp from "sharp";
import type { InputManifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir } from "./helpers";

/**
 * Capture reuses one page per worker instead of one per shot. That makes anything
 * the browser keeps *on the page* — rather than in the document — leak from one
 * state into the next. Pointer position is the one that bites: the browser
 * re-applies `:hover` at the last cursor position to each newly loaded document,
 * so a hover state captured earlier would paint a phantom hover into an unrelated
 * screenshot.
 */

const HOVER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Hover</title><style>
  body{margin:0;font:16px system-ui}
  #mark{width:300px;height:200px;background:#eee}
  #mark:hover{background:#c00}
</style></head><body><div id="mark"></div></body></html>`;

/** Share of pixels that differ at all between two same-sized images. */
async function differingRatio(a: string, b: string): Promise<number> {
  const [x, y] = await Promise.all(
    [a, b].map((f) => sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })),
  );
  expect([x.info.width, x.info.height]).toEqual([y.info.width, y.info.height]);
  let diff = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    if (x.data.readUInt32BE(i) !== y.data.readUInt32BE(i)) diff++;
  }
  return diff / (x.data.length / 4);
}

const config = (dir: string): Config =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    devices: [{ name: "small", width: 400, height: 300, dpr: 1 }],
    // One worker, so every state in the run shares a single page.
    politeness: { concurrency: 1, minDelayMs: 0 },
    stabilize: { waitStrategy: "load", extraDelayMs: 25, lazyScroll: false },
  });

const state = (id: string, recipe: unknown[] = []) => ({
  id,
  kind: "default" as const,
  label: id,
  recipe: recipe as never,
  shots: {},
});

describe("page reuse", () => {
  it("does not leak a hover state into the next shot on the same page", async () => {
    const { server, dir: siteDir } = await serveFiles({
      "index.html": HOVER_PAGE,
      "second.html": HOVER_PAGE,
    });
    const out = await tempDir("pool");
    try {
      const cfg = config(out);

      // A run whose first state hovers the element, then captures a second page.
      const withHover: InputManifest = {
        routes: [
          {
            id: "home",
            url: "/",
            depth: 0,
            states: [state("hovered", [{ action: "hover", target: { selector: "#mark" } }])],
          },
          { id: "second", url: "/second.html", depth: 0, states: [state("default")] },
        ],
      };
      const dirty = await capturePipeline({
        config: cfg,
        inputManifest: withHover,
        baseUrl: server.url,
        log: silent,
      });

      // The same second page, captured by itself — nothing hovered anything.
      const clean = await capturePipeline({
        config: cfg,
        inputManifest: {
          routes: [{ id: "second", url: "/second.html", depth: 0, states: [state("default")] }],
        },
        baseUrl: server.url,
        log: silent,
      });

      const shotOf = (result: { runDir: string; manifest: { routes: unknown[] } }, route: number) =>
        path.join(
          result.runDir,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result.manifest.routes[route] as any).states[0].shots.small.full as string,
        );

      // The hover *was* captured where it was asked for…
      expect(await differingRatio(shotOf(dirty, 0), shotOf(clean, 0))).toBeGreaterThan(0.1);

      // …and did not survive into the next page's shot.
      expect(await differingRatio(shotOf(dirty, 1), shotOf(clean, 0))).toBe(0);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps capturing after a state fails, on a fresh page", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": HOVER_PAGE });
    const out = await tempDir("pool");
    try {
      const result = await capturePipeline({
        config: { ...config(out), politeness: { ...config(out).politeness, retries: 0 } },
        inputManifest: {
          routes: [
            {
              id: "home",
              url: "/",
              depth: 0,
              states: [
                // A recipe that can never succeed, between two that can.
                state("first"),
                state("broken", [
                  { action: "waitFor", selector: "#nope", state: "visible", timeoutMs: 500 },
                ]),
                state("last"),
              ],
            },
          ],
        },
        baseUrl: server.url,
        log: silent,
      });

      const states = result.manifest.routes[0].states;
      expect(states[0].shots.small.full).toBeTruthy();
      expect(states[1].shots.small.error).toBeTruthy();
      expect(states[2].shots.small.full).toBeTruthy();
      expect(result.manifest.stats?.failed).toBe(1);
      expect(result.manifest.stats?.shots).toBe(2);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A page whose look depends on what's in localStorage — a cart, in miniature. A
 * recipe that adds to it changes every page the shared context loads afterwards.
 */
const CART_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Cart</title><style>
  body{margin:0;font:16px system-ui}#badge{width:300px;height:200px;background:#eee}
  .full #badge{background:#c00}
</style></head><body><div id="badge"></div><button id="add">Add</button><script>
  const paint = () => document.body.classList.toggle("full", !!localStorage.getItem("cart"));
  document.getElementById("add").addEventListener("click", () => {
    localStorage.setItem("cart", "1");
    paint();
  });
  paint();
</script></body></html>`;

describe("isolated states", () => {
  const run = async (isolate: boolean) => {
    const { server, dir: siteDir } = await serveFiles({
      "index.html": CART_PAGE,
      "second.html": CART_PAGE,
    });
    const out = await tempDir("pool");
    try {
      const result = await capturePipeline({
        config: config(out),
        inputManifest: {
          routes: [
            {
              id: "home",
              url: "/",
              depth: 0,
              states: [
                {
                  ...state("added", [{ action: "click", target: { selector: "#add" } }]),
                  isolate,
                },
              ],
            },
            { id: "second", url: "/second.html", depth: 0, states: [state("default")] },
          ],
        },
        baseUrl: server.url,
        log: silent,
      });
      const shot = (route: number) =>
        sharp(path.join(result.runDir, result.manifest.routes[route].states[0].shots.small.full!))
          .extract({ left: 10, top: 10, width: 1, height: 1 })
          .raw()
          .toBuffer();
      return { added: [...(await shot(0))], second: [...(await shot(1))] };
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  };

  it("keeps what an isolated recipe stores out of the shots after it", async () => {
    const shared = await run(false);
    // Without isolation the cart leaks: the second page is painted full too…
    expect(shared.added).toEqual([204, 0, 0]);
    expect(shared.second).toEqual([204, 0, 0]);
    const isolated = await run(true);
    // …with it, the state still shows its cart and the next page doesn't.
    expect(isolated.added).toEqual([204, 0, 0]);
    expect(isolated.second).toEqual([238, 238, 238]);
  }, 120_000);
});

/**
 * A menu that closes when the page scrolls — Floating-UI's `hide`, Bootstrap's
 * dropdowns. Stabilization scrolls the page to trigger lazy loading, so between one
 * state's recipe and the next state's reuse of it, the menu has quietly closed —
 * and, before that, between the recipe and the screenshot.
 */
const scrollClosingMenu = (aria: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<title>Menu</title><style>body{margin:0;font:16px system-ui}#spacer{height:3000px}
#dropdown{width:200px;height:60px;background:#0a0}</style></head><body>
  <button id="menu"${aria ? ' aria-expanded="false"' : ""}>Menu</button>
  <div id="dropdown" hidden><button id="sub">Submenu</button></div>
  <div id="subpanel" hidden>Sub content</div>
  <div id="spacer"></div>
  <script>
    const menu = document.getElementById("menu"), dd = document.getElementById("dropdown");
    const set = (open) => { dd.hidden = !open; ${aria ? 'menu.setAttribute("aria-expanded", String(open));' : ""} };
    menu.addEventListener("click", () => set(true));
    document.getElementById("sub").addEventListener("click", () => {
      document.getElementById("subpanel").hidden = false;
    });
    addEventListener("scroll", () => set(false));
  </script>
</body></html>`;

describe("reusing a page after stabilization", () => {
  // No retries, and a short timeout: a reuse that runs `click Submenu` against a
  // closed menu has to fail loudly here rather than be rescued by a fresh retry.
  const strict = (out: string): Config => {
    const c = config(out);
    return {
      ...c,
      politeness: { ...c.politeness, retries: 0, timeoutMs: 2500 },
      stabilize: { ...c.stabilize, lazyScroll: true },
      // The lazy-load pass under test only runs for a single full-page render; a
      // screen-by-screen capture does its scrolling while it shoots.
      screenshot: { ...c.screenshot, fullPage: "single" },
    };
  };

  const run = async (html: string, recipes: { menu: unknown[]; sub: unknown[] }) => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": html });
    const out = await tempDir("pool");
    const logs: string[] = [];
    try {
      const result = await capturePipeline({
        config: strict(out),
        inputManifest: {
          routes: [
            {
              id: "home",
              url: "/",
              depth: 0,
              states: [state("menu", recipes.menu), state("sub", recipes.sub)],
            },
          ],
        },
        baseUrl: server.url,
        log: (m) => logs.push(m),
      });
      // The dropdown is a green box; sample it to the right of the button inside it.
      const menuShot = path.join(
        result.runDir,
        result.manifest.routes[0].states[0].shots.small.full!,
      );
      const info = await sharp(menuShot).metadata();
      const box = await sharp(menuShot)
        .extract({ left: 0, top: 0, width: info.width!, height: 120 })
        .removeAlpha()
        .raw()
        .toBuffer();
      let green = 0;
      for (let i = 0; i < box.length; i += 3) {
        if (box[i] === 0 && box[i + 1] === 170 && box[i + 2] === 0) green++;
      }
      return { result, logs, menuOpenInShot: green > 2000 };
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  };

  it("photographs the menu open, and reuses it, when the closing promise broke", async () => {
    const openMenu = [
      { action: "click", target: { selector: "#menu" } },
      { action: "waitFor", selector: "#dropdown", state: "visible" },
    ];
    const { result, logs, menuOpenInShot } = await run(scrollClosingMenu(false), {
      menu: openMenu,
      sub: [
        ...openMenu,
        { action: "click", target: { selector: "#sub" } },
        { action: "waitFor", selector: "#subpanel", state: "visible" },
      ],
    });
    expect(result.manifest.stats?.failures ?? [], logs.join("\n")).toEqual([]);
    // The lazy-load scroll closed the menu, so the shot was retaken scroll-first —
    // which also leaves the menu open for the nested state to build on.
    expect(logs.join("\n")).toContain("closed by the lazy-load scroll — reopened after it");
    expect(menuOpenInShot).toBe(true);
  }, 120_000);

  it("photographs the menu open when the open regions moved, with no promise to check", async () => {
    const { result, logs, menuOpenInShot } = await run(scrollClosingMenu(true), {
      menu: [{ action: "click", target: { selector: "#menu" } }],
      sub: [
        { action: "click", target: { selector: "#menu" } },
        { action: "click", target: { selector: "#sub" } },
        { action: "waitFor", selector: "#subpanel", state: "visible" },
      ],
    });
    expect(result.manifest.stats?.failures ?? [], logs.join("\n")).toEqual([]);
    // The lazy-load scroll closed the menu, so the shot was retaken scroll-first —
    // which also leaves the menu open for the nested state to build on.
    expect(logs.join("\n")).toContain("closed by the lazy-load scroll — reopened after it");
    expect(menuOpenInShot).toBe(true);
  }, 120_000);

  it("still reuses the page when nothing changed under it", async () => {
    // The same menu minus the scroll listener: reuse is the point of all this, and a
    // check that declined every time would be a correct but useless one.
    const html = scrollClosingMenu(true).replace(
      'addEventListener("scroll", () => set(false));',
      "",
    );
    const { result, logs, menuOpenInShot } = await run(html, {
      menu: [{ action: "click", target: { selector: "#menu" } }],
      sub: [
        { action: "click", target: { selector: "#menu" } },
        { action: "click", target: { selector: "#sub" } },
        { action: "waitFor", selector: "#subpanel", state: "visible" },
      ],
    });
    expect(result.manifest.stats?.failures ?? []).toEqual([]);
    // The first state navigates; the second extends it on the same page.
    expect(logs.join("\n")).toContain("page reuse: 1 of 2 shot(s) needed no reload");
    expect(logs.join("\n")).not.toContain("more reloaded");
    expect(logs.join("\n")).not.toContain("reopened after it");
    expect(menuOpenInShot).toBe(true);
  }, 120_000);

  it("keeps a recipe's scroll position instead of stabilizing back to the top", async () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bands</title><style>
      body{margin:0}.a{height:1000px;background:#f00}.b{height:1000px;background:#00f}
    </style></head><body><div class="a"></div><div class="b"></div></body></html>`;
    const { server, dir: siteDir } = await serveFiles({ "index.html": html });
    const out = await tempDir("pool");
    try {
      const c = strict(out);
      const result = await capturePipeline({
        config: { ...c, screenshot: { ...c.screenshot, fullPage: false } },
        inputManifest: {
          routes: [
            {
              id: "home",
              url: "/",
              depth: 0,
              states: [state("scrolled", [{ action: "scroll", to: 1000 }])],
            },
          ],
        },
        baseUrl: server.url,
        log: silent,
      });
      const file = path.join(result.runDir, result.manifest.routes[0].states[0].shots.small.full!);
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      const at = (150 * info.width + 200) * info.channels;
      // Blue: the band the recipe scrolled to. Red would be the top of the page.
      expect([data[at], data[at + 1], data[at + 2]]).toEqual([0, 0, 255]);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
