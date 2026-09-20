import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, type Config, type VisualiceConfig } from "../src/shared/config";
import { latestRunId, listRuns } from "../src/crawl/runs";
import type { InputManifest, ShotRef, ViewerData } from "../src/shared/types";

/**
 * `toViewerData`, `updateLatest` and `pruneRuns` are module-private, so the way in
 * is `capturePipeline`. Capture is the only step of that pipeline that needs a
 * browser; stubbing it out leaves everything the orchestrator does *around* the
 * browser — the viewer's tile contract, the `latest` symlink, run pruning — reachable
 * from a fast unit test.
 */
vi.mock("../src/crawl/capture", () => ({ runCapture: vi.fn() }));

// Nothing in this file may reach Chromium. Fail loudly rather than hang if it tries.
vi.mock("playwright", () => ({
  chromium: {
    launch: () => {
      throw new Error("unit tests must not launch a browser");
    },
  },
}));

import { runCapture } from "../src/crawl/capture";
import { capturePipeline, type CapturePipelineOptions } from "../src/crawl/orchestrator";

const DEVICES = [
  { name: "desktop", width: 1440, height: 900, dpr: 2 },
  { name: "mobile", width: 390, height: 844, dpr: 3, mobile: true },
];

let out: string;

beforeEach(async () => {
  out = await fs.mkdtemp(path.join(os.tmpdir(), "vc-orch-"));
  stubCapture();
});

afterEach(async () => {
  vi.mocked(runCapture).mockReset();
  await fs.rm(out, { recursive: true, force: true });
});

const config = (over: Partial<VisualiceConfig> = {}): Config =>
  ConfigSchema.parse({
    routesFile: false, // a test must never read or write the repo's own routes file
    output: { dir: out },
    devices: DEVICES,
    ...over,
  });

/** What `runCapture` returns, minus the browser: the manifest it was handed, plus stats. */
function stubCapture(): void {
  vi.mocked(runCapture).mockImplementation(async (opts) => {
    const refs = opts.manifest.routes.flatMap((r) =>
      r.states.flatMap((s) => Object.values(s.shots)),
    );
    opts.manifest.stats = {
      routes: opts.manifest.routes.length,
      states: opts.manifest.routes.reduce((n, r) => n + r.states.length, 0),
      shots: refs.filter((r) => r.full).length,
      failed: refs.filter((r) => r.error).length,
      durationMs: 0,
      failures: [],
    };
    return {
      manifest: opts.manifest,
      shots: opts.manifest.stats.shots,
      failures: [],
      durationMs: 0,
    };
  });
}

const shot = (over: Partial<ShotRef> = {}): ShotRef => ({
  full: "screenshots/home/default/desktop.png",
  thumb: "screenshots/home/default/desktop.thumb.webp",
  width: 2880,
  height: 5000,
  ...over,
});

/** A captured site model covering every tile case the viewer has to render. */
const site = (): InputManifest => ({
  routes: [
    {
      id: "home",
      url: "/",
      depth: 0,
      states: [
        {
          id: "default",
          kind: "default",
          label: "Default",
          recipe: [],
          shots: {
            desktop: shot({
              mid: "screenshots/home/default/desktop.mid.webp",
              viewport: "screenshots/home/default/desktop.viewport.png",
              clamped: true,
            }),
            mobile: shot({
              full: "screenshots/home/default/mobile.png",
              width: 1170,
              height: 3000,
            }),
          },
        },
        {
          id: "modal-login",
          kind: "modal",
          label: "Login",
          recipe: [],
          shots: { desktop: { error: "timeout waiting for [role=dialog]" } },
        },
      ],
    },
    {
      id: "about",
      url: "/about/",
      title: "About us",
      depth: 1,
      // No intrinsic dims on the ref: the tile still needs a size to lay out with.
      states: [
        {
          id: "default",
          kind: "default",
          label: "Default",
          recipe: [],
          shots: { desktop: { full: "screenshots/about/default/desktop.png" } },
        },
      ],
    },
    {
      id: "empty",
      url: "/empty",
      depth: 1,
      states: [
        // Nothing was captured at all…
        { id: "default", kind: "default", label: "Default", recipe: [], shots: {} },
        // …and a ref that is neither an image nor a failure.
        {
          id: "meta-only",
          kind: "other",
          label: "Meta",
          recipe: [],
          shots: { desktop: { meta: "screenshots/empty/meta-only/desktop.json" } },
        },
      ],
    },
  ],
});

async function run(
  over: Partial<CapturePipelineOptions> = {},
): Promise<{ runDir: string; viewer: ViewerData }> {
  const { runDir } = await capturePipeline({
    config: config(),
    inputManifest: site(),
    baseUrl: "https://x.test",
    log: () => {},
    ...over,
  });
  const viewer = JSON.parse(
    await fs.readFile(path.join(runDir, "viewer-data.json"), "utf8"),
  ) as ViewerData;
  return { runDir, viewer };
}

/** An old run directory that a later crawl may or may not prune. */
async function fabricateRun(id: string): Promise<void> {
  const dir = path.join(out, "runs", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "crawl-map.json"), "{}");
}

describe("viewer data contract", () => {
  it("emits one tile per shot, keyed routeId__stateId__device", async () => {
    const { viewer } = await run();
    expect(viewer.tiles.map((t) => t.id)).toEqual([
      "home__default__desktop",
      "home__default__mobile",
      "home__modal-login__desktop",
      "about__default__desktop",
    ]);
  });

  it("describes each tile well enough to label it without the manifest", async () => {
    const { viewer } = await run();
    expect(viewer.tiles[0]).toMatchObject({
      routeId: "home",
      routeUrl: "/",
      routePath: "home",
      stateId: "default",
      stateLabel: "Default",
      stateKind: "default",
      device: "desktop",
    });
  });

  it("carries the mid tier, viewport crop and clamped flag through to the tile", async () => {
    const { viewer } = await run();
    expect(viewer.tiles[0]).toMatchObject({
      full: "screenshots/home/default/desktop.png",
      thumb: "screenshots/home/default/desktop.thumb.webp",
      mid: "screenshots/home/default/desktop.mid.webp",
      viewport: "screenshots/home/default/desktop.viewport.png",
      clamped: true,
      width: 2880,
      height: 5000,
    });
  });

  it("surfaces a failed capture as a tile carrying its reason, not as a gap", async () => {
    const { viewer } = await run();
    const failed = viewer.tiles.find((t) => t.id === "home__modal-login__desktop")!;
    expect(failed.error).toBe("timeout waiting for [role=dialog]");
    expect(failed.full).toBeUndefined();
    expect(failed.thumb).toBeUndefined();
    // …and it still reserves layout space, at the device's pixel size.
    expect(failed).toMatchObject({ width: 1440 * 2, height: 900 * 2 });
  });

  it("counts failed tiles so the viewer doesn't have to scan for them", async () => {
    expect((await run()).viewer.failed).toBe(1);

    const clean = site();
    clean.routes[0].states[1].shots = { desktop: shot() };
    expect((await run({ inputManifest: clean })).viewer.failed).toBe(0);
  });

  it("falls back to the device's pixel dimensions when the shot has none", async () => {
    const { viewer } = await run();
    const about = viewer.tiles.find((t) => t.id === "about__default__desktop")!;
    expect(about).toMatchObject({ width: 1440 * 2, height: 900 * 2 });
  });

  it("leaves the size unknown when the shot names a device that isn't configured", async () => {
    const model = site();
    model.routes[1].states[0].shots.retina = { full: "screenshots/about/default/retina.png" };
    const { viewer } = await run({ inputManifest: model });
    const tile = viewer.tiles.find((t) => t.id === "about__default__retina")!;
    expect(tile.width).toBeUndefined();
    expect(tile.height).toBeUndefined();
  });

  it("skips refs that are neither an image nor a failure", async () => {
    const { viewer } = await run();
    expect(viewer.tiles.filter((t) => t.routeId === "empty")).toEqual([]);
  });

  it("groups every route by its path slug, including ones with no tiles", async () => {
    const { viewer } = await run();
    expect(viewer.groups).toEqual([
      { path: "home", routeId: "home" },
      { path: "about", routeId: "about", title: "About us" },
      { path: "empty", routeId: "empty" },
    ]);
  });

  it("carries the site header and device list the viewer renders its chrome from", async () => {
    const { runDir, viewer } = await run();
    expect(viewer.site).toMatchObject({
      baseUrl: "https://x.test",
      origin: "https://x.test",
      runId: path.basename(runDir),
    });
    expect(viewer.devices.map((d) => d.name)).toEqual(["desktop", "mobile"]);
  });
});

describe("run bookkeeping", () => {
  it("writes the three run artifacts and clears the incomplete marker", async () => {
    const { runDir } = await run();
    expect((await fs.readdir(runDir)).sort()).toEqual([
      "crawl-map.json",
      "crawl-report.md",
      "viewer-data.json",
    ]);
  });

  it("points `latest` at the run it just finished", async () => {
    const { runDir } = await run();
    const id = path.basename(runDir);
    expect(await fs.readlink(path.join(out, "runs", "latest"))).toBe(id);
    expect(await latestRunId(out)).toBe(id);
  });

  it("prunes all but the newest keepRuns runs, sparing the one it just wrote", async () => {
    for (const id of [
      "2026-01-01T00-00-00-000Z",
      "2026-01-02T00-00-00-000Z",
      "2026-01-03T00-00-00-000Z",
    ]) {
      await fabricateRun(id);
    }
    const { runDir } = await run({ config: config({ output: { dir: out, keepRuns: 2 } }) });
    expect(await listRuns(out)).toEqual(["2026-01-03T00-00-00-000Z", path.basename(runDir)]);
  });

  it("never prunes a directory whose name isn't a run id", async () => {
    await fabricateRun("2026-01-01T00-00-00-000Z");
    await fabricateRun("baseline"); // a copied-in reference run, not something we made
    const { runDir } = await run({ config: config({ output: { dir: out, keepRuns: 1 } }) });
    expect(await listRuns(out)).toEqual([path.basename(runDir), "baseline"]);
  });

  it("reuses the interrupted run's directory when resuming", async () => {
    await fabricateRun("2026-01-01T00-00-00-000Z");
    const { runDir } = await run({ resume: "2026-01-01T00-00-00-000Z" });
    expect(path.basename(runDir)).toBe("2026-01-01T00-00-00-000Z");
    expect(vi.mocked(runCapture).mock.calls[0][0].resume).toBe(true);
  });

  it("does not tell capture to adopt existing shots on a fresh run", async () => {
    await run();
    expect(vi.mocked(runCapture).mock.calls[0][0].resume).toBe(false);
  });

  it("folds the cached model's hints into the config capture runs with", async () => {
    const model = site();
    model.hints = {
      flakyRegions: ["#clock"],
      stableSelectors: [".ready"],
      skipTriggers: ["#logout"],
    };
    const logs: string[] = [];
    await run({ inputManifest: model, log: (m) => logs.push(m) });

    const used = vi.mocked(runCapture).mock.calls[0][0].config;
    expect(used.stabilize.maskSelectors).toContain("#clock");
    expect(used.stabilize.waitForSelectors).toContain(".ready");
    expect(used.discovery.interactions.denySelectors).toContain("#logout");
    expect(logs.join("\n")).toContain("applying site hints");
  });

  it("redacts the config snapshot it writes into the crawl map", async () => {
    const cfg = config({
      output: { dir: out },
      http: { extraHTTPHeaders: { authorization: "Bearer hunter2", "x-env": "staging" } },
    });
    const { runDir } = await run({ config: cfg });
    const map = await fs.readFile(path.join(runDir, "crawl-map.json"), "utf8");
    expect(map).not.toContain("hunter2");
    expect(JSON.parse(map).configSnapshot.http.extraHTTPHeaders).toEqual({
      authorization: "[redacted]",
      "x-env": "staging",
    });
  });

  it("refuses to run while another process holds the output directory", async () => {
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(
      path.join(out, ".lock"),
      // This process is provably alive, so the lock is not stale.
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        command: "crawl",
      }),
    );
    await expect(run()).rejects.toThrow(/another visualice run is using this directory/);
    expect(runCapture).not.toHaveBeenCalled();
  });
});
