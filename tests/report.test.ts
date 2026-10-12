import { describe, expect, it } from "vitest";
import { renderReport } from "../src/crawl/report";
import type { Manifest } from "../src/shared/types";

const makeManifest = (): Manifest => ({
  version: 1,
  site: {
    baseUrl: "https://x.dev",
    origin: "https://x.dev",
    title: "X",
    runId: "r1",
    generatedAt: "2026-01-01T00:00:00Z",
  },
  devices: [{ name: "desktop", width: 1440, height: 900, dpr: 2 }],
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
          shots: { desktop: { full: "screenshots/home/default/desktop.png" } },
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
  ],
  stats: {
    routes: 1,
    states: 2,
    shots: 1,
    failed: 1,
    durationMs: 4200,
    failures: [
      {
        route: "/",
        state: "modal-login",
        device: "desktop",
        error: "timeout waiting for [role=dialog]",
      },
    ],
  },
});

describe("renderReport", () => {
  it("lists failures in a dedicated section", () => {
    const md = renderReport(makeManifest());
    expect(md).toContain("## Failures");
    expect(md).toContain("modal-login");
    expect(md).toContain("timeout waiting for [role=dialog]");
    expect(md).toContain("**1 failed**");
  });

  it("counts only real shots per route, not failed attempts", () => {
    const md = renderReport(makeManifest());
    const row = md.split("\n").find((l) => l.startsWith("| `/`"));
    expect(row).toBeDefined();
    // states col lists both, shots col counts 1, failed col counts 1
    expect(row).toContain("default, modal-login");
    expect(row).toMatch(/\| 1 \| 1 \|$/);
  });

  it("omits the failures section when everything succeeded", () => {
    const m = makeManifest();
    m.routes[0].states[1].shots = { desktop: { full: "x.png" } };
    m.stats = { ...m.stats!, failed: 0, failures: [], shots: 2 };
    const md = renderReport(m);
    expect(md).not.toContain("## Failures");
  });

  it("says which setting cropped a clamped shot", () => {
    const m = makeManifest();
    m.routes[0].states[0].shots = { desktop: { full: "x.png", clamped: true } };
    expect(renderReport(m)).toContain(
      "- **Clamped:** 1 shot(s) hit the `screenshot.maxHeight` or `maxScreens` limit and were cropped",
    );
  });
});
