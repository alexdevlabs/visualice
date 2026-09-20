import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../../src/shared/config";
import { capturePipeline, type CapturePipelineResult } from "../../src/crawl/orchestrator";
import type { CaptureFailure } from "../../src/shared/types";
import { serveFiles, tempDir } from "./helpers";

/**
 * A capture that fails is retried on a *fresh* page, because the failure may well
 * have wedged the renderer. Whether that retry actually re-runs the recipe (rather
 * than reusing the state the first attempt left behind) can only be shown against a
 * real browser: this page renders `#ready` from its second load onwards, so a state
 * waiting on `#ready` can only succeed if it genuinely navigated again.
 */
const FLAKY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Flaky</title></head>
<body><h1>flaky</h1><script>
  const n = Number(localStorage.getItem("loads") || 0);
  localStorage.setItem("loads", String(n + 1));
  if (n >= 1) {
    const d = document.createElement("div");
    d.id = "ready";
    d.textContent = "ready";
    document.body.appendChild(d);
  }
</script></body></html>`;

const waitFor = (selector: string) => [
  { action: "waitFor", selector, state: "visible", timeoutMs: 1000 },
];

let result: CapturePipelineResult;
let logs: string[];
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const { server, dir: siteDir } = await serveFiles({ "index.html": FLAKY_PAGE });
  const out = await tempDir("retry");
  cleanup = async () => {
    await server.close();
    await fs.rm(siteDir, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  };
  logs = [];

  result = await capturePipeline({
    config: ConfigSchema.parse({
      routesFile: false,
      output: { dir: out },
      devices: [{ name: "small", width: 400, height: 300, dpr: 1 }],
      politeness: { concurrency: 1, minDelayMs: 0, retries: 1 },
      stabilize: { waitStrategy: "load", extraDelayMs: 25, lazyScroll: false },
    }),
    inputManifest: {
      routes: [
        {
          id: "home",
          url: "/",
          depth: 0,
          states: [
            // Impossible on the first load, satisfied on the retry…
            { id: "flaky", kind: "default", label: "Flaky", recipe: waitFor("#ready"), shots: {} },
            // …and one that no number of retries can ever satisfy.
            {
              id: "doomed",
              kind: "default",
              label: "Doomed",
              recipe: waitFor("#never"),
              shots: {},
            },
          ] as never,
        },
      ],
    },
    baseUrl: server.url,
    log: (m) => logs.push(m),
  });
}, 120_000);

afterAll(async () => {
  await cleanup();
});

describe("capture retries", () => {
  it("re-runs a failed state on a fresh page and keeps the shot it finally gets", () => {
    const flaky = result.manifest.routes[0].states[0];
    expect(flaky.shots.small.full).toBeTruthy();
    expect(flaky.shots.small.error).toBeUndefined();
    expect(logs.join("\n")).toContain("↻ home / flaky");
  });

  it("gives up after politeness.retries and records why", () => {
    const doomed = result.manifest.routes[0].states[1];
    expect(doomed.shots.small.full).toBeUndefined();
    expect(doomed.shots.small.error).toMatch(/#never|[Tt]imeout/);
    expect(logs.join("\n")).toContain("✗ home / doomed");
  });

  it("counts the run by shots taken, not states attempted", () => {
    expect(result.manifest.stats).toMatchObject({ routes: 1, states: 2, shots: 1, failed: 1 });
  });

  it("names the route, state and device of every failure in the manifest", () => {
    const failures = result.manifest.stats!.failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject<Partial<CaptureFailure>>({
      route: "/",
      state: "doomed",
      device: "small",
    });
    expect(failures[0].error).toBe(result.manifest.routes[0].states[1].shots.small.error);
  });
});
