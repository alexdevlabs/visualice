import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import { compareImages } from "../../src/diff/pixels";
import type { InputManifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir } from "./helpers";

/**
 * Capture reuses one page per worker instead of one per shot. That makes anything
 * the browser keeps *on the page* — rather than in the document — leak from one
 * state into the next. Pointer position is the one that bites: the browser
 * re-applies `:hover` at the last cursor position to each newly loaded document,
 * so a hover state captured earlier would paint a phantom hover into an unrelated
 * screenshot.
 */

const HOVER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Hover</title><style>
  body{margin:0;font:16px system-ui}
  #mark{width:300px;height:200px;background:#eee}
  #mark:hover{background:#c00}
</style></head><body><div id="mark"></div></body></html>`;

const config = (dir: string): Config =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    devices: [{ name: "small", width: 400, height: 300, dpr: 1 }],
    // One worker, so every state in the run shares a single page.
    politeness: { concurrency: 1, minDelayMs: 0 },
    stabilize: { waitStrategy: "load", extraDelayMs: 25, lazyScroll: false },
  });

const state = (id: string, recipe: unknown[] = []) => ({
  id,
  kind: "default" as const,
  label: id,
  recipe: recipe as never,
  shots: {},
});

describe("page reuse", () => {
  it("does not leak a hover state into the next shot on the same page", async () => {
    const { server, dir: siteDir } = await serveFiles({
      "index.html": HOVER_PAGE,
      "second.html": HOVER_PAGE,
    });
    const out = await tempDir("pool");
    try {
      const cfg = config(out);

      // A run whose first state hovers the element, then captures a second page.
      const withHover: InputManifest = {
        routes: [
          {
            id: "home",
            url: "/",
            depth: 0,
            states: [state("hovered", [{ action: "hover", target: { selector: "#mark" } }])],
          },
          { id: "second", url: "/second.html", depth: 0, states: [state("default")] },
        ],
      };
      const dirty = await capturePipeline({
        config: cfg,
        inputManifest: withHover,
        baseUrl: server.url,
        log: silent,
      });

      // The same second page, captured by itself — nothing hovered anything.
      const clean = await capturePipeline({
        config: cfg,
        inputManifest: {
          routes: [{ id: "second", url: "/second.html", depth: 0, states: [state("default")] }],
        },
        baseUrl: server.url,
        log: silent,
      });

      const shotOf = (result: { runDir: string; manifest: { routes: unknown[] } }, route: number) =>
        path.join(
          result.runDir,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result.manifest.routes[route] as any).states[0].shots.small.full as string,
        );

      // The hover *was* captured where it was asked for…
      const hovered = await compareImages(shotOf(dirty, 0), shotOf(clean, 0));
      expect(hovered.ratio).toBeGreaterThan(0.1);

      // …and did not survive into the next page's shot.
      const next = await compareImages(shotOf(dirty, 1), shotOf(clean, 0));
      expect(next.changedPixels).toBe(0);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps capturing after a state fails, on a fresh page", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": HOVER_PAGE });
    const out = await tempDir("pool");
    try {
      const result = await capturePipeline({
        config: { ...config(out), politeness: { ...config(out).politeness, retries: 0 } },
        inputManifest: {
          routes: [
            {
              id: "home",
              url: "/",
              depth: 0,
              states: [
                // A recipe that can never succeed, between two that can.
                state("first"),
                state("broken", [
                  { action: "waitFor", selector: "#nope", state: "visible", timeoutMs: 500 },
                ]),
                state("last"),
              ],
            },
          ],
        },
        baseUrl: server.url,
        log: silent,
      });

      const states = result.manifest.routes[0].states;
      expect(states[0].shots.small.full).toBeTruthy();
      expect(states[1].shots.small.error).toBeTruthy();
      expect(states[2].shots.small.full).toBeTruthy();
      expect(result.manifest.stats?.failed).toBe(1);
      expect(result.manifest.stats?.shots).toBe(2);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  }, 120_000);
});
