import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { serveDirectory } from "../../src/shared/static-server";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import { applyContextInit } from "../../src/crawl/stabilize";
import type { InputManifest } from "../../src/shared/types";
import { FIXTURE_DIR, serveFiles, silent, tempDir } from "./helpers";

/**
 * M6: with stabilization on, two runs of the same page must produce identical
 * pixels. The control case (stabilization off) proves the test page really is
 * non-deterministic, so a passing run means the shims did the work.
 */

const FROZEN = "2025-01-01T00:00:00.000Z";

const stable = (over: Partial<Config["stabilize"]> = {}) =>
  ConfigSchema.parse({
    routesFile: false,
    devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
    stabilize: {
      freezeTime: FROZEN,
      seedRandom: 42,
      waitStrategy: "load",
      extraDelayMs: 50,
      ...over,
    },
    politeness: { minDelayMs: 0 },
  });

const homeOnly: InputManifest = {
  routes: [
    {
      id: "home",
      url: "/",
      depth: 0,
      states: [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }],
    },
  ],
};

/** Capture `/` once and return the sha256 of the resulting full-size shot. */
async function captureHash(baseUrl: string, config: Config, out: string): Promise<string> {
  const { runDir, manifest } = await capturePipeline({
    config: { ...config, output: { ...config.output, dir: out } },
    inputManifest: structuredClone(homeOnly),
    baseUrl,
    log: silent,
  });
  const shot = manifest.routes[0].states[0].shots.small?.full;
  expect(shot, "capture produced no screenshot").toBeTruthy();
  const buf = await fs.readFile(path.join(runDir, shot!));
  return createHash("sha256").update(buf).digest("hex");
}

// Renders a fresh timestamp and random number on every load, and animates a box.
const VOLATILE = `<!doctype html><html><head><meta charset="utf-8"><title>Volatile</title>
<style>
  body { font: 16px/1.5 monospace; padding: 24px; }
  .box { width: 80px; height: 80px; background: #333; animation: slide 1.2s linear infinite; }
  @keyframes slide { from { transform: translateX(0) } to { transform: translateX(200px) } }
</style></head><body>
<h1>Volatile</h1>
<p id="t"></p><p id="r"></p><div class="box"></div>
<script>
  document.getElementById('t').textContent = 'now: ' + new Date().toISOString();
  document.getElementById('r').textContent = 'rand: ' + Math.random();
</script></body></html>`;

describe("stabilization shims", () => {
  it("freezes the clock and seeds Math.random in the page", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await applyContextInit(context, stable().stabilize);
      const page = await context.newPage();
      await page.goto("about:blank");
      const first = await page.evaluate(() => ({
        iso: new Date().toISOString(),
        now: Date.now(),
        rand: [Math.random(), Math.random()],
      }));
      expect(first.iso).toBe(FROZEN);
      expect(first.now).toBe(Date.parse(FROZEN));

      // A second page in the same context must draw the same random sequence.
      const page2 = await context.newPage();
      await page2.goto("about:blank");
      const second = await page2.evaluate(() => [Math.random(), Math.random()]);
      expect(second).toEqual(first.rand);
      expect(first.rand[0]).not.toBe(first.rand[1]); // still a usable generator
    } finally {
      await browser.close();
    }
  });

  it("leaves the monotonic clock running so rAF/timeout loops still resolve", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await applyContextInit(context, stable().stabilize);
      const page = await context.newPage();
      await page.goto("about:blank");
      const advanced = await page.evaluate(async () => {
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, 40));
        return performance.now() - t0;
      });
      expect(advanced).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });
});

describe("determinism", () => {
  it("produces byte-identical shots of a volatile page across runs", async () => {
    const { server, dir } = await serveFiles({ "index.html": VOLATILE });
    const out = await tempDir("determinism");
    try {
      const config = stable();
      const a = await captureHash(server.url, config, out);
      const b = await captureHash(server.url, config, out);
      expect(b).toBe(a);

      // Control: the same page is *not* reproducible without the shims.
      const loose = ConfigSchema.parse({
        routesFile: false,
        devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
        stabilize: { animations: "allow", waitStrategy: "load", extraDelayMs: 50 },
        politeness: { minDelayMs: 0 },
      });
      const c = await captureHash(server.url, loose, out);
      const d = await captureHash(server.url, loose, out);
      expect(d).not.toBe(c);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  it("produces byte-identical shots of the bundled fixture across runs", async () => {
    const server = await serveDirectory(FIXTURE_DIR);
    const out = await tempDir("determinism-fixture");
    try {
      const config = stable({ waitStrategy: "networkidle" });
      const a = await captureHash(server.url, config, out);
      const b = await captureHash(server.url, config, out);
      expect(b).toBe(a);
    } finally {
      await server.close();
      await fs.rm(out, { recursive: true, force: true });
    }
  });
});
