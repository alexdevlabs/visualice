import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import type { InputManifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir } from "./helpers";

const TALL = `<!doctype html><html><head><meta charset="utf-8"><title>Tall</title></head>
<body style="margin:0"><div style="height:9000px;background:linear-gradient(#fff,#000)"></div></body></html>`;

const PLAIN = `<!doctype html><html><head><meta charset="utf-8"><title>Plain</title></head>
<body style="margin:0"><h1>Hello</h1><p class="ad">ad slot</p></body></html>`;

const config = (dir: string, over: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    devices: [{ name: "small", width: 400, height: 300, dpr: 1 }],
    politeness: { concurrency: 1, minDelayMs: 0 },
    stabilize: { waitStrategy: "load", extraDelayMs: 0, lazyScroll: false },
    ...over,
  });

const single = (url = "/"): InputManifest => ({
  routes: [
    {
      id: "home",
      url,
      depth: 0,
      states: [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }],
    },
  ],
});

describe("screenshot safety", () => {
  it("crops an unbounded page to maxHeight and flags the shot", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": TALL });
    const out = await tempDir("safety");
    try {
      const clamped = await capturePipeline({
        config: config(out, { screenshot: { screens: false, maxHeight: 1000 } }),
        inputManifest: single(),
        baseUrl: server.url,
        log: silent,
      });
      const shot = clamped.manifest.routes[0].states[0].shots.small;
      expect(shot.clamped).toBe(true);
      expect(shot.height).toBe(1000);

      // Without the clamp the same page produces the full 9000px shot.
      const full = await capturePipeline({
        config: config(out, { screenshot: { screens: false, maxHeight: 0 } }),
        inputManifest: single(),
        baseUrl: server.url,
        log: silent,
      });
      const tall = full.manifest.routes[0].states[0].shots.small;
      expect(tall.clamped).toBeUndefined();
      expect(tall.height).toBeGreaterThan(8000);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("stops an unbounded page at maxScreens and flags the shot", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": TALL });
    const out = await tempDir("safety");
    try {
      const result = await capturePipeline({
        config: config(out, { screenshot: { maxScreens: 3 } }),
        inputManifest: single(),
        baseUrl: server.url,
        log: silent,
      });
      const shot = result.manifest.routes[0].states[0].shots.small;
      expect(shot.clamped).toBe(true);
      expect(shot.screens).toBe(3);
      // Three whole screens of the 300px-tall device, stacked.
      expect(shot.height).toBe(900);
      // Where each screen sat, so the viewer can join them: a step of the screen
      // less the overlap, and nothing pinned to cut.
      expect(shot.frames).toEqual([
        { y: 0, top: 0, bottom: 0 },
        { y: 260, top: 0, bottom: 0 },
        { y: 520, top: 0, bottom: 0 },
      ]);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("records the bars pinned to the window on every screen", async () => {
    const pinned = TALL.replace(
      '<body style="margin:0">',
      '<body style="margin:0"><header style="position:sticky;top:0;height:50px;background:red"></header>' +
        '<div style="position:fixed;bottom:0;left:0;right:0;height:30px;background:blue"></div>',
    );
    const { server, dir: siteDir } = await serveFiles({ "index.html": pinned });
    const out = await tempDir("safety");
    try {
      const result = await capturePipeline({
        config: config(out, { screenshot: { maxScreens: 3 } }),
        inputManifest: single(),
        baseUrl: server.url,
        log: silent,
      });
      const shot = result.manifest.routes[0].states[0].shots.small;
      expect(shot.frames).toHaveLength(3);
      for (const f of shot.frames!) expect(f).toMatchObject({ top: 50, bottom: 30 });
      // Each step leaves out what the bars cover, less the overlap: 300 − 50 − 30 − 40.
      expect(shot.frames!.map((f) => f.y)).toEqual([0, 180, 360]);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("takes one screen of a page whose scrolling is locked", async () => {
    // How an open modal usually locks the page: scripts can still move it, users can't.
    const locked = TALL.replace("<html>", '<html style="overflow:hidden">');
    const { server, dir: siteDir } = await serveFiles({ "index.html": locked });
    const out = await tempDir("safety");
    try {
      const result = await capturePipeline({
        config: config(out),
        inputManifest: single(),
        baseUrl: server.url,
        log: silent,
      });
      const shot = result.manifest.routes[0].states[0].shots.small;
      expect(shot.screens).toBeUndefined();
      expect(shot.frames).toBeUndefined();
      expect(shot.height).toBe(300);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects an invalid mask selector before capturing anything", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": PLAIN });
    const out = await tempDir("safety");
    try {
      await expect(
        capturePipeline({
          config: config(out, { stabilize: { maskSelectors: [".ad", "div:has-bogus("] } }),
          inputManifest: single(),
          baseUrl: server.url,
          log: silent,
        }),
      ).rejects.toThrow(/invalid selector\(s\)[\s\S]*maskSelectors "div:has-bogus\("/);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("resume", () => {
  it("keeps the shots an interrupted run already produced", async () => {
    const { server, dir: siteDir } = await serveFiles({
      "index.html": PLAIN,
      "second.html": PLAIN,
    });
    const out = await tempDir("resume");
    try {
      const cfg = config(out);
      const model: InputManifest = {
        routes: [
          ...single("/").routes,
          { id: "second", url: "/second.html", depth: 0, states: single().routes[0].states },
        ],
      };

      const first = await capturePipeline({
        config: cfg,
        inputManifest: structuredClone(model),
        baseUrl: server.url,
        log: silent,
      });
      const runId = first.manifest.site.runId;
      const kept = path.join(first.runDir, first.manifest.routes[0].states[0].shots.small.full!);
      const dropped = path.join(first.runDir, "screenshots", "second.html", "default");

      // Simulate a kill partway through: the second route's output is gone.
      await fs.rm(dropped, { recursive: true, force: true });
      const keptBefore = await fs.stat(kept);

      const logs: string[] = [];
      const resumed = await capturePipeline({
        config: cfg,
        inputManifest: structuredClone(model),
        baseUrl: server.url,
        resume: runId,
        log: (m) => logs.push(m),
      });

      // Same run directory, both shots present again…
      expect(resumed.runDir).toBe(first.runDir);
      expect(resumed.manifest.stats?.shots).toBe(2);
      expect(await fs.readdir(dropped)).toContain("small.png");
      // …and the surviving shot was adopted, not recaptured.
      expect((await fs.stat(kept)).mtimeMs).toBe(keptBefore.mtimeMs);
      expect(logs.join("\n")).toContain("1 shot(s) already on disk were kept");
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
