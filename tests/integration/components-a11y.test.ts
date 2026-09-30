import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ConfigSchema } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import { serveFiles, tempDir } from "./helpers";

/**
 * Component shots and accessibility checks both hang off the capture of a state
 * that is already on screen — the first photographs one element of it, the second
 * audits it — so they are tested against the same small site.
 */

const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title>
<style>body{margin:0;font:16px system-ui}header{height:60px;background:#036;color:#fff}
.card{position:absolute;left:40px;top:120px;width:240px;height:100px;background:#c00}
.faint{margin-top:200px;color:#ddd;background:#fff}</style></head><body>
<header>Site</header><main><h1>Home</h1><div class="card" id="card"></div>
<p class="faint">Low contrast text that axe should flag.</p>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></main></body></html>`;

const ABOUT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title>
<style>body{margin:0;font:16px system-ui}header{height:60px;background:#036;color:#fff}</style>
</head><body><header>Site</header><main><h1>About</h1><p>Nothing wrong here.</p></main></body></html>`;

describe("component shots and accessibility checks", () => {
  it("photographs a component where it exists and audits every state", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": HOME, "about.html": ABOUT });
    const out = await tempDir("components");
    const logs: string[] = [];
    try {
      const config = ConfigSchema.parse({
        routesFile: false,
        output: { dir: out },
        devices: [{ name: "small", width: 400, height: 300, dpr: 1 }],
        stabilize: { waitStrategy: "load", extraDelayMs: 25 },
        politeness: { minDelayMs: 0, concurrency: 1 },
        components: [
          { name: "Header", selector: "header" },
          { name: "Card", selector: "#card" },
        ],
        checks: { accessibility: true },
      });
      const { manifest, runDir } = await capturePipeline({
        config,
        inputManifest: {
          routes: ["/", "/about.html"].map((url) => ({
            id: url,
            url,
            depth: 0,
            states: [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }],
          })),
        },
        baseUrl: server.url,
        log: (m) => logs.push(m),
      });

      expect(manifest.stats?.failures).toEqual([]);
      const [home, about] = manifest.routes;
      expect(home.states.map((s) => s.id)).toEqual([
        "default",
        "component-header",
        "component-card",
      ]);
      // About has no #card: the state is dropped, not failed and not left empty.
      expect(about.states.map((s) => s.id)).toEqual(["default", "component-header"]);
      expect(manifest.stats?.shots).toBe(5);

      // The component shot is the element, not the page.
      const card = home.states[2].shots.small;
      expect([card.width, card.height]).toEqual([240, 100]);
      const { data } = await sharp(path.join(runDir, card.full!))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([data[0], data[1], data[2]]).toEqual([204, 0, 0]);
      expect(home.states[1].shots.small).toMatchObject({ width: 400, height: 60 });

      // A component rides on the page its route already loaded.
      expect(logs.join("\n")).toMatch(/page reuse: 3 of 5 shot\(s\) needed no reload/);

      // Accessibility: the home page breaks rules, the about page doesn't.
      expect(home.states[0].shots.small.a11y).toBeGreaterThanOrEqual(2);
      expect(about.states[0].shots.small.a11y).toBe(0);
      const rules = manifest.stats?.accessibility?.map((r) => r.id) ?? [];
      expect(rules).toContain("image-alt");
      expect(rules).toContain("color-contrast");
      // Scoped to the element: the card itself has no violations of its own.
      expect(card.a11y).toBe(0);

      const sidecar = JSON.parse(
        await fs.readFile(path.join(runDir, home.states[0].shots.small.meta!), "utf8"),
      );
      const alt = sidecar.accessibility.find((v: { id: string }) => v.id === "image-alt");
      expect(alt).toMatchObject({ impact: "critical", count: 1 });
      expect(alt.targets[0]).toContain("img");

      const report = await fs.readFile(path.join(runDir, "crawl-report.md"), "utf8");
      expect(report).toContain("## Accessibility");
      expect(report).toContain("image-alt");

      const viewer = JSON.parse(await fs.readFile(path.join(runDir, "viewer-data.json"), "utf8"));
      const tile = viewer.tiles.find((t: { stateId: string }) => t.stateId === "component-card");
      expect(tile).toMatchObject({ stateKind: "component", a11y: 0 });
      expect(tile.meta).toMatch(/small\.json$/);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
