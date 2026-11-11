import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  countCarryFailures,
  crawlOwnFiles,
  sameSource,
  toViewerData,
} from "../src/crawl/orchestrator";
import { ConfigSchema } from "../src/shared/config";
import { mergeRollups } from "../src/crawl/accessibility";
import type { CaptureFailure, Manifest, RouteNode, ShotRef } from "../src/shared/types";

/** What a partial run reports: its failures, and which shots it says it took. */

const route = (url: string, shot: ShotRef): RouteNode =>
  ({
    id: url.slice(1) || "home",
    url,
    depth: 0,
    states: [
      { id: "default", kind: "default", label: "Default", recipe: [], shots: { small: shot } },
    ],
  }) as RouteNode;

const shot = (name: string): ShotRef => ({
  full: `screenshots/${name}.png`,
  width: 10,
  height: 10,
});

describe("a partial run's results", () => {
  it("counts a shot it couldn't carry as a failure", () => {
    const stats = {
      failed: 1,
      failures: [{ route: "/x", state: "a", device: "small", error: "e" }],
    };
    countCarryFailures(stats as { failed: number; failures: CaptureFailure[] }, [
      route("/kept", { ...shot("kept"), carried: { runId: "r1" } }),
      route("/lost", { error: "couldn't carry the shot from run r1: ENOENT" }),
    ]);
    expect(stats.failed).toBe(2);
    expect(stats.failures[1]).toEqual({
      route: "/lost",
      state: "default",
      device: "small",
      error: "couldn't carry the shot from run r1: ENOENT",
    });
  });

  it("calls a shot updated only when --only named its page and it was taken", () => {
    const m = {
      version: 1,
      site: { baseUrl: "http://x", origin: "http://x", runId: "r2", generatedAt: "" },
      devices: [{ name: "small", width: 10, height: 10, dpr: 1 }],
      partial: { only: ["/pricing"], carriedFrom: "r1" },
      routes: [
        route("/pricing", shot("pricing")),
        // Shot because the earlier run didn't have it, not because it changed.
        route("/new", shot("new")),
        // A carry that failed: neither shot nor changed.
        route("/about", { error: "couldn't carry the shot from run r1" }),
        route("/home", { ...shot("home"), carried: { runId: "r1" } }),
      ],
    } as unknown as Manifest;
    const tiles = toViewerData(m).tiles;
    expect(tiles.filter((t) => t.updated).map((t) => t.routeUrl)).toEqual(["/pricing"]);
    expect(tiles.find((t) => t.routeUrl === "/home")?.carried).toEqual({ runId: "r1" });
  });
});

describe("the commit record", () => {
  const at = {
    commit: "a".repeat(40),
    branch: "main",
    dirty: 0,
    capturedAt: "2026-11-09T00:00:00Z",
  };

  it("is kept for a rerun of the same clean commit", () => {
    expect(sameSource(at, { ...at, capturedAt: "2026-11-10T00:00:00Z" })).toBe(true);
    expect(sameSource(at, { ...at, commit: "b".repeat(40) })).toBe(false);
  });

  it("is written again when other files were dirty, though as many", () => {
    const dirty = { ...at, dirty: 1, dirtyHash: "aaaaaaaaaaaa" };
    expect(sameSource(dirty, { ...dirty, capturedAt: "2026-11-10T00:00:00Z" })).toBe(true);
    expect(sameSource(dirty, { ...dirty, dirtyHash: "bbbbbbbbbbbb" })).toBe(false);
    // A record from before the hash was kept is written again, once.
    expect(sameSource({ ...at, dirty: 1 }, dirty)).toBe(false);
  });

  it("leaves the crawl's own files out, the .gitignore a first crawl edits among them", () => {
    const own = crawlOwnFiles(ConfigSchema.parse({}), "custom.config.json");
    expect(own).toContain(path.resolve(".gitignore"));
    expect(own).toContain(path.resolve("visualice.routes.md"));
    expect(own).toContain(path.resolve("visualice.config.json"));
    expect(own).toContain(path.resolve("custom.config.json"));
    expect(own).toContain(path.resolve(".visualice"));
  });
});

describe("accessibility totals of a partial run", () => {
  it("add the carried pages' violations to the ones just found", () => {
    const merged = mergeRollups(
      [{ id: "color-contrast", impact: "serious", help: "Contrast", shots: 1, elements: 2 }],
      [
        { id: "color-contrast", impact: "serious", help: "Contrast", shots: 3, elements: 7 },
        { id: "image-alt", impact: "critical", help: "Alt text", shots: 2, elements: 2 },
      ],
    );
    expect(merged.map((r) => [r.id, r.shots, r.elements])).toEqual([
      ["image-alt", 2, 2],
      ["color-contrast", 4, 9],
    ]);
  });
});
