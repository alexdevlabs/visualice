import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import sharp from "sharp";
import { compareImages } from "../../src/diff/pixels";
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
      const hovered = await compareImages(shotOf(dirty, 0), shotOf(clean, 0));
      expect(hovered.ratio).toBeGreaterThan(0.1);

      // …and did not survive into the next page's shot.
      const next = await compareImages(shotOf(dirty, 1), shotOf(clean, 0));
      expect(next.changedPixels).toBe(0);
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
 * A menu that closes when the page scrolls — Floating-UI's `hide`, Bootstrap's
 * dropdowns. Stabilization scrolls the page to trigger lazy loading, so between one
 * state's recipe and the next state's reuse of it, the menu has quietly closed.
 */
const scrollClosingMenu = (aria: boolean) => `<!doctype html><html><head><meta charset="utf-8">
<title>Menu</title><style>body{margin:0;font:16px system-ui}#spacer{height:3000px}</style></head><body>
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
      return { result, logs };
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  };

  it("reloads when the recipe's own closing promise no longer holds", async () => {
    const openMenu = [
      { action: "click", target: { selector: "#menu" } },
      { action: "waitFor", selector: "#dropdown", state: "visible" },
    ];
    const { result, logs } = await run(scrollClosingMenu(false), {
      menu: openMenu,
      sub: [
        ...openMenu,
        { action: "click", target: { selector: "#sub" } },
        { action: "waitFor", selector: "#subpanel", state: "visible" },
      ],
    });
    expect(result.manifest.stats?.failures ?? [], logs.join("\n")).toEqual([]);
    expect(logs.join("\n")).toContain("1 more reloaded: the page had changed");
  }, 120_000);

  it("reloads when the open regions moved, even with no promise to check", async () => {
    const { result, logs } = await run(scrollClosingMenu(true), {
      menu: [{ action: "click", target: { selector: "#menu" } }],
      sub: [
        { action: "click", target: { selector: "#menu" } },
        { action: "click", target: { selector: "#sub" } },
        { action: "waitFor", selector: "#subpanel", state: "visible" },
      ],
    });
    expect(result.manifest.stats?.failures ?? [], logs.join("\n")).toEqual([]);
    expect(logs.join("\n")).toContain("1 more reloaded: the page had changed");
  }, 120_000);

  it("still reuses the page when nothing changed under it", async () => {
    // The same menu minus the scroll listener: reuse is the point of all this, and a
    // check that declined every time would be a correct but useless one.
    const html = scrollClosingMenu(true).replace(
      'addEventListener("scroll", () => set(false));',
      "",
    );
    const { result, logs } = await run(html, {
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
