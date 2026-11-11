import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { serveDirectory } from "../../src/shared/static-server";
import type { StaticServer } from "../../src/shared/file-serve";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { crawlPipeline, planCrawl } from "../../src/crawl/orchestrator";
import type { ViewerData } from "../../src/shared/types";
import { markRunIncomplete } from "../../src/crawl/runs";
import { FIXTURE_DIR, silent, tempDir } from "./helpers";

/**
 * `crawl --only` end-to-end against the fixture: a full crawl, then a partial one that
 * shoots one page and carries the rest, so the new run is still the whole site.
 */

let server: StaticServer;
let out: string;
let config: Config;

beforeAll(async () => {
  server = await serveDirectory(FIXTURE_DIR);
  out = await tempDir("partial");
  const base = ConfigSchema.parse({
    scope: { maxPages: 3, maxDepth: 1 },
    devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
    discovery: { interactions: { maxPerPage: 2 }, mobileStates: false },
    stabilize: { extraDelayMs: 50 },
    politeness: { minDelayMs: 0, concurrency: 4 },
  });
  config = { ...base, routesFile: false, output: { ...base.output, dir: out } };
}, 30000);

afterAll(async () => {
  await server.close();
  await fs.rm(out, { recursive: true, force: true });
});

describe("partial runs", () => {
  it("shoot the named pages and carry the rest from the last run", async () => {
    const full = await crawlPipeline({ config, baseUrl: server.url, log: silent });
    const pages = full.manifest.routes.map((r) => r.url);
    expect(pages.length).toBeGreaterThan(1);
    const named = pages.find((p) => p !== "/")!;

    const plan = await planCrawl({ config, baseUrl: server.url, replay: true, only: [named] });
    expect(plan.partial?.capture).toEqual([named]);
    expect(plan.partial?.carriedFrom).toBe(full.manifest.site.runId);

    const part = await crawlPipeline({
      config,
      baseUrl: server.url,
      replay: true,
      only: [named],
      log: silent,
    });
    const m = part.manifest;
    expect(m.partial).toEqual({ only: [named], carriedFrom: full.manifest.site.runId });
    expect(m.routes.map((r) => r.url)).toEqual(pages);
    expect(m.stats?.carried).toBeGreaterThan(0);
    expect(m.stats!.shots + m.stats!.carried!).toBe(full.manifest.stats!.shots);

    for (const route of m.routes) {
      for (const state of route.states) {
        for (const ref of Object.values(state.shots)) {
          if (route.url === named) expect(ref.carried).toBeUndefined();
          else expect(ref.carried?.runId).toBe(full.manifest.site.runId);
          // Every shot's file is in the new run, carried or not.
          await expect(fs.stat(path.join(part.runDir, ref.full!))).resolves.toBeTruthy();
        }
      }
    }

    const data = JSON.parse(
      await fs.readFile(path.join(part.runDir, "viewer-data.json"), "utf8"),
    ) as ViewerData;
    expect(data.tiles.filter((t) => t.updated).every((t) => t.routeUrl === named)).toBe(true);
    expect(data.tiles.some((t) => t.carried)).toBe(true);

    // Interrupted, then resumed without repeating --only: still the same partial run.
    await markRunIncomplete(part.runDir);
    const resumed = await crawlPipeline({
      config,
      baseUrl: server.url,
      replay: true,
      resume: true,
      log: silent,
    });
    expect(resumed.runDir).toBe(part.runDir);
    expect(resumed.manifest.partial).toEqual({
      only: [named],
      carriedFrom: full.manifest.site.runId,
    });
    expect(resumed.manifest.stats?.carried).toBeGreaterThan(0);
  }, 180000);
});
