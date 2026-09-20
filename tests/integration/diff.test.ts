import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import { diffRuns } from "../../src/diff";
import type { InputManifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir } from "./helpers";

/**
 * The regression-detection contract end to end: crawl, change the site, crawl again,
 * and have the diff name exactly what moved. Everything upstream (determinism,
 * stable slugs) has to hold for this to work, which is the point of testing it here
 * rather than only unit-testing the comparison.
 */

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Site</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:24px}.box{width:200px;height:120px;background:#2b6}</style>
</head><body>${body}</body></html>`;

const HOME = page(`<h1>Home</h1><div class="box"></div><p><a href="/about.html">About</a></p>`);
const HOME_CHANGED = page(
  `<h1>Home</h1><div class="box" style="background:#d33"></div><p><a href="/about.html">About</a></p>`,
);
const ABOUT = page(`<h1>About</h1><p>Static copy that never changes.</p>`);

const config = (dir: string): Config =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    devices: [{ name: "small", width: 400, height: 300, dpr: 1 }],
    stabilize: {
      freezeTime: "2025-01-01T00:00:00.000Z",
      seedRandom: 1,
      waitStrategy: "load",
      extraDelayMs: 25,
    },
    politeness: { minDelayMs: 0 },
  });

const model = (routes: string[]): InputManifest => ({
  routes: routes.map((url) => ({
    id: url,
    url,
    depth: 0,
    states: [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }],
  })),
});

describe("run diff", () => {
  it("finds the one page that changed, and ignores the one that didn't", async () => {
    const { server, dir: siteDir } = await serveFiles({
      "index.html": HOME,
      "about.html": ABOUT,
    });
    const out = await tempDir("diff-out");
    try {
      const cfg = config(out);
      const routes = model(["/", "/about.html"]);

      const before = await capturePipeline({
        config: cfg,
        inputManifest: structuredClone(routes),
        baseUrl: server.url,
        log: silent,
      });

      // Repaint the box on the home page only.
      await fs.writeFile(path.join(siteDir, "index.html"), HOME_CHANGED);

      const after = await capturePipeline({
        config: cfg,
        inputManifest: structuredClone(routes),
        baseUrl: server.url,
        log: silent,
      });

      const diffDir = path.join(out, "diffs", "test");
      const diff = await diffRuns({
        fromDir: before.runDir,
        toDir: after.runDir,
        outDir: diffDir,
        log: silent,
      });

      expect(diff.summary).toMatchObject({ changed: 1, unchanged: 1, added: 0, removed: 0 });
      const changed = diff.shots.find((s) => s.status === "changed")!;
      expect(changed.route).toBe("home");
      expect(changed.device).toBe("small");
      // The box is 200×120 of a 400×300 viewport — a sizable but partial change.
      expect(changed.ratio).toBeGreaterThan(0.1);
      expect(changed.ratio).toBeLessThan(0.5);
      expect(changed.sizeChanged).toBeUndefined();

      // A diff image was rendered for the change, and none for the untouched page.
      const image = path.join(diffDir, changed.image!);
      expect((await fs.stat(image)).size).toBeGreaterThan(0);
      const unchanged = diff.shots.find((s) => s.status === "unchanged")!;
      expect(unchanged.image).toBeUndefined();
      expect(await fs.readdir(path.join(diffDir, "images"))).toEqual(["home"]);

      const report = await fs.readFile(path.join(diffDir, "diff-report.md"), "utf8");
      expect(report).toContain("## Changed");
      expect(report).toContain("home");
      expect(report).not.toContain("about");

      // The machine-readable twin carries the same verdict.
      const json = JSON.parse(await fs.readFile(path.join(diffDir, "diff.json"), "utf8"));
      expect(json.summary.changed).toBe(1);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("reports added and removed pages rather than diffing them", async () => {
    const { server, dir: siteDir } = await serveFiles({
      "index.html": HOME,
      "about.html": ABOUT,
    });
    const out = await tempDir("diff-out");
    try {
      const cfg = config(out);
      const before = await capturePipeline({
        config: cfg,
        inputManifest: model(["/", "/about.html"]),
        baseUrl: server.url,
        log: silent,
      });
      const after = await capturePipeline({
        config: cfg,
        inputManifest: model(["/", "/new.html"]),
        baseUrl: server.url,
        log: silent,
      });

      const diff = await diffRuns({
        fromDir: before.runDir,
        toDir: after.runDir,
        log: silent,
      });

      expect(diff.summary).toMatchObject({ added: 1, removed: 1, changed: 0, unchanged: 1 });
      expect(diff.routes).toEqual({ added: ["new.html"], removed: ["about.html"] });
      expect(diff.shots.find((s) => s.status === "added")?.route).toBe("new.html");
      expect(diff.shots.find((s) => s.status === "removed")?.route).toBe("about.html");
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
