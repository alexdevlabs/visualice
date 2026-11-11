import { describe, expect, it } from "vitest";
import { countCarryFailures, toViewerData } from "../src/crawl/orchestrator";
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
