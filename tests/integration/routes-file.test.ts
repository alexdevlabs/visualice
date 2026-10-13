import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { serveDirectory } from "../../src/shared/static-server";
import type { StaticServer } from "../../src/shared/file-serve";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { crawlPipeline, discoverOnlyPipeline } from "../../src/crawl/orchestrator";
import { parseRoutesFile } from "../../src/crawl/routes-file";
import { FIXTURE_DIR, silent, tempDir } from "./helpers";

/**
 * The routes-file loop end-to-end against the fixture: a crawl generates the
 * file; editing it (skip: + [ ] wanted) steers the next crawl; regeneration is
 * idempotent and preserves the edits.
 */

let server: StaticServer;
let out: string;
let routesFile: string;
let config: Config;

beforeAll(async () => {
  server = await serveDirectory(FIXTURE_DIR);
  out = await tempDir("routes");
  routesFile = path.join(out, "visualice.routes.md");
  const base = ConfigSchema.parse({
    scope: { maxPages: 3, maxDepth: 1 },
    devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
    discovery: { interactions: { maxPerPage: 3 }, mobileStates: false },
    stabilize: { extraDelayMs: 50 },
    politeness: { minDelayMs: 0, concurrency: 4 },
  });
  config = { ...base, routesFile, output: { ...base.output, dir: out } };
}, 30000);

afterAll(async () => {
  await server.close();
  await fs.rm(out, { recursive: true, force: true });
});

describe("routes file loop", () => {
  it("a crawl generates the routes file from the discovered model", async () => {
    await crawlPipeline({ config, baseUrl: server.url, log: silent });
    const text = await fs.readFile(routesFile, "utf8");
    expect(text).toContain(`# Routes — ${server.url}`);
    const intent = parseRoutesFile(text);
    expect(intent.routes.map((r) => r.path)).toContain("/");
    // the fixture home page has interactive states beyond default
    expect(intent.routes.find((r) => r.path === "/")!.states.length).toBeGreaterThan(0);
    expect(text).not.toContain("- default"); // default state stays implicit
  }, 60000);

  it("edits steer the next run: skip: excludes capture, [ ] surfaces as wanted", async () => {
    const before = await fs.readFile(routesFile, "utf8");
    const intent = parseRoutesFile(before);
    const home = intent.routes.find((r) => r.path === "/")!;
    const victim = home.states[0].id;

    const victimLine = new RegExp(`^  - ${victim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "m");
    const edited = before.replace(
      victimLine,
      `  - skip: ${victim}\n  - [ ] cmdk-search — the ⌘K overlay`,
    );
    await fs.writeFile(routesFile, edited);

    const { manifest } = await crawlPipeline({ config, baseUrl: server.url, log: silent });

    const homeRoute = manifest.routes.find((r) => r.url === "/")!;
    expect(homeRoute.states.map((s) => s.id)).not.toContain(victim);
    expect(manifest.stats?.wanted).toEqual([
      { route: "/", state: "cmdk-search", description: "the ⌘K overlay" },
    ]);

    const after = await fs.readFile(routesFile, "utf8");
    expect(after).toContain(`  - skip: ${victim}`);
    expect(after).toContain("  - [ ] cmdk-search — the ⌘K overlay");
  }, 60000);

  it("regeneration is idempotent when nothing changed", async () => {
    const before = await fs.readFile(routesFile, "utf8");
    await crawlPipeline({ config, baseUrl: server.url, replay: true, log: silent });
    const after = await fs.readFile(routesFile, "utf8");
    expect(after).toBe(before);
  }, 60000);

  it("a page added to the file is discovered on replay, the rest replayed as is", async () => {
    const cachePath = path.join(out, "crawl-map.cache.json");
    const cachedBefore = JSON.parse(await fs.readFile(cachePath, "utf8"));
    expect(cachedBefore.routes.map((r: { url: string }) => r.url)).not.toContain("/dashboard");
    await fs.appendFile(routesFile, "- /dashboard\n");

    const { manifest } = await crawlPipeline({
      config,
      baseUrl: server.url,
      replay: true,
      log: silent,
    });

    const urls = manifest.routes.map((r) => r.url);
    expect(urls).toEqual([...cachedBefore.routes.map((r: { url: string }) => r.url), "/dashboard"]);
    const cachedAfter = JSON.parse(await fs.readFile(cachePath, "utf8"));
    expect(cachedAfter.routes.at(-1).url).toBe("/dashboard");
    expect(await fs.readFile(routesFile, "utf8")).toMatch(/^- \/dashboard — /m);
  }, 60000);

  it("discover alone merges into the cache instead of overwriting it", async () => {
    const cachePath = path.join(out, "crawl-map.cache.json");
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    cached.hints = { skipTriggers: [".js-logout"] };
    cached.routes[0].states.push({
      id: "authored-panel",
      kind: "other",
      label: "Authored",
      recipe: [{ action: "wait", ms: 10 }],
      source: "authored",
      shots: {},
    });
    await fs.writeFile(cachePath, JSON.stringify(cached));

    await discoverOnlyPipeline({ config, baseUrl: server.url, log: silent });

    const after = JSON.parse(await fs.readFile(cachePath, "utf8"));
    expect(after.hints).toEqual({ skipTriggers: [".js-logout"] });
    expect(after.routes[0].states.map((s: { id: string }) => s.id)).toContain("authored-panel");
  }, 60000);
});
