import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { serveDirectory } from "../../src/shared/static-server";
import type { StaticServer } from "../../src/shared/file-serve";
import { ConfigSchema } from "../../src/shared/config";
import { crawlPipeline } from "../../src/crawl/orchestrator";
import type { Manifest, ViewerData } from "../../src/shared/types";
import { FIXTURE_DIR, silent, tempDir, walk } from "./helpers";

/**
 * End-to-end: discover → capture → manifest/report/viewer-data, against the
 * bundled fixture site. This is the contract the Claude skill and the viewer
 * both depend on, so it asserts shapes and files, not pixel content.
 */

let server: StaticServer;
let out: string;
let runDir: string;
let manifest: Manifest;

const config = ConfigSchema.parse({
  scope: { maxPages: 3, maxDepth: 1 },
  devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
  discovery: { interactions: { maxPerPage: 3 } },
  screenshot: { alsoViewport: true, thumbnail: { width: 120 } },
  stabilize: { freezeTime: "2025-01-01T00:00:00Z", seedRandom: 42, extraDelayMs: 50 },
  politeness: { minDelayMs: 0, concurrency: 4 },
});

beforeAll(async () => {
  server = await serveDirectory(FIXTURE_DIR);
  out = await tempDir("crawl");
  const res = await crawlPipeline({
    config: { ...config, output: { ...config.output, dir: out } },
    baseUrl: server.url,
    log: silent,
  });
  runDir = res.runDir;
  manifest = res.manifest;
});

afterAll(async () => {
  await server.close();
  await fs.rm(out, { recursive: true, force: true });
});

describe("crawl pipeline", () => {
  it("discovers routes within the configured scope", () => {
    expect(manifest.routes.length).toBeGreaterThan(1);
    expect(manifest.routes.length).toBeLessThanOrEqual(3);
    expect(manifest.routes.map((r) => r.url)).toContain("/");
    for (const r of manifest.routes) {
      expect(r.status).toBe(200);
      expect(r.title).toBeTruthy();
    }
  });

  it("finds interactive states beyond the default render", () => {
    const kinds = new Set(manifest.routes.flatMap((r) => r.states.map((s) => s.kind)));
    expect(kinds.has("default")).toBe(true);
    expect([...kinds].some((k) => k !== "default")).toBe(true);

    for (const route of manifest.routes) {
      expect(route.states[0].id).toBe("default");
      expect(route.states.length - 1).toBeLessThanOrEqual(3); // maxPerPage
      for (const s of route.states.slice(1)) {
        expect(s.recipe.length).toBeGreaterThan(0);
        expect(s.recipe[0]).toMatchObject({ action: "click" });
        expect(s.source).toBe("auto");
      }
    }
  });

  it("captures every route × state × device", async () => {
    const expected = manifest.routes.reduce((n, r) => n + r.states.length, 0);
    expect(manifest.stats).toMatchObject({ shots: expected, states: expected });

    const files = await walk(path.join(runDir, "screenshots"));
    for (const route of manifest.routes) {
      for (const state of route.states) {
        const shot = state.shots.small;
        expect(shot?.full, `${route.id}/${state.id}`).toBeTruthy();
        expect(shot!.width).toBeGreaterThan(0);
        expect(shot!.height).toBeGreaterThan(0);
        for (const rel of [shot!.full!, shot!.thumb!, shot!.meta!, shot!.viewport!]) {
          expect(files).toContain(rel.replace(/^screenshots\//, ""));
        }
      }
    }
  });

  it("lays the output out as <path>/<state>/<device>.<ext>", async () => {
    const files = await walk(path.join(runDir, "screenshots"));
    expect(files).toContain("home/default/small.png");
    expect(files).toContain("home/default/small.thumb.webp");
    expect(files).toContain("home/default/small.json");
    expect(files).toContain("home/default/small.viewport.png");
  });

  it("writes a sidecar describing each shot", async () => {
    const meta = JSON.parse(
      await fs.readFile(path.join(runDir, "screenshots", "home", "default", "small.json"), "utf8"),
    );
    expect(meta).toMatchObject({
      route: "home",
      routeUrl: "/",
      state: "default",
      device: "small",
      viewport: { width: 420, height: 640, dpr: 1 },
    });
  });

  it("writes the manifest, report and viewer data", async () => {
    const files = await walk(runDir);
    expect(files).toContain("crawl-map.json");
    expect(files).toContain("crawl-report.md");
    expect(files).toContain("viewer-data.json");

    const report = await fs.readFile(path.join(runDir, "crawl-report.md"), "utf8");
    expect(report).toContain("# Crawl report");
    expect(report).toContain(`${manifest.stats!.shots} shots`);

    const viewer: ViewerData = JSON.parse(
      await fs.readFile(path.join(runDir, "viewer-data.json"), "utf8"),
    );
    expect(viewer.tiles).toHaveLength(manifest.stats!.shots);
    expect(viewer.groups.map((g) => g.routeId).sort()).toEqual(
      manifest.routes.map((r) => r.id).sort(),
    );
    for (const t of viewer.tiles) {
      expect(t.full).toMatch(/^screenshots\//);
      expect(t.width).toBeGreaterThan(0);
    }
  });

  it("caches a reusable, host-independent site model", async () => {
    const cache = JSON.parse(await fs.readFile(path.join(out, "crawl-map.cache.json"), "utf8"));
    expect(cache.routes).toHaveLength(manifest.routes.length);
    // Paths, not absolute URLs — that is what makes the cache portable.
    for (const r of cache.routes) expect(r.url.startsWith("/")).toBe(true);
    expect(JSON.stringify(cache)).not.toContain(server.url);
  });

  it("replays the cached model without re-discovering", async () => {
    const replay = await crawlPipeline({
      config: { ...config, output: { ...config.output, dir: out } },
      baseUrl: server.url,
      replay: true,
      log: silent,
    });
    expect(replay.manifest.routes.map((r) => r.id)).toEqual(manifest.routes.map((r) => r.id));
    expect(replay.manifest.stats!.shots).toBe(manifest.stats!.shots);
    expect(replay.runDir).not.toBe(runDir);
  });
});
