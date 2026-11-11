import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../../src/shared/config";
import { capturePipeline, crawlPipeline } from "../../src/crawl/orchestrator";
import type { Manifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir } from "./helpers";

/**
 * A React app's ids come from `useId()`, numbered in render order, so the same
 * dialog is `_r_6_` on one load and `_r_9_` on the next. Recipes that waited for
 * those ids timed out on every capture after discovery (a real admin app lost 29
 * shots this way). This page renders its ids from a fresh offset on every load,
 * the way a different device layout or a longer table shifts them.
 */
const SHIFTING_IDS = `<!doctype html><html><head><meta charset="utf-8"><title>Shifting</title>
<style>[hidden]{display:none} [role=dialog]{position:fixed;inset:40px;background:#fff;border:1px solid}</style>
</head><body><h1>Settings</h1>
<button type="button" class="open">Edit profile</button>
<button type="button" class="toggle" aria-expanded="false">Details</button>
<div class="panel" hidden><p>More about this account.</p></div>
<script>
  // Not Math.random: capture seeds it, and the point is that loads differ.
  let n = crypto.getRandomValues(new Uint32Array(1))[0] % 500;
  const useId = () => "_r_" + (n++).toString(32) + "_";
  const open = document.querySelector(".open");
  const toggle = document.querySelector(".toggle");
  const panel = document.querySelector(".panel");
  open.id = "base-ui-" + useId();
  toggle.id = "base-ui-" + useId();
  panel.id = "base-ui-" + useId();
  toggle.setAttribute("aria-controls", panel.id);
  toggle.onclick = () => {
    const on = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(on));
    panel.hidden = !on;
  };
  open.onclick = () => {
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    d.id = useId();
    const title = document.createElement("h2");
    title.id = useId();
    title.textContent = "Edit profile";
    d.setAttribute("aria-labelledby", title.id);
    d.append(title);
    document.body.append(d);
  };
</script></body></html>`;

const GENERATED = /_r_[0-9a-v]*_/;

let site: { url: string; close: () => Promise<void> };
let siteDir: string;
let out: string;

const config = (dir: string) =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    scope: { maxPages: 1, maxDepth: 0 },
    devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
    discovery: { mobileStates: false },
    stabilize: { waitStrategy: "load", extraDelayMs: 25, lazyScroll: false },
    politeness: { minDelayMs: 0, concurrency: 2, retries: 0 },
  });

beforeAll(async () => {
  const served = await serveFiles({ "index.html": SHIFTING_IDS });
  site = served.server;
  siteDir = served.dir;
  out = await tempDir("generated-ids");
});

afterAll(async () => {
  await site?.close();
  await fs.rm(siteDir, { recursive: true, force: true });
  await fs.rm(out, { recursive: true, force: true });
});

describe("ids generated at render time", () => {
  it("records states that capture on a later load, whatever the ids are then", async () => {
    const { manifest } = await crawlPipeline({
      config: config(out),
      baseUrl: site.url,
      log: silent,
    });
    const states = (manifest as Manifest).routes[0].states.filter((s) => s.kind !== "default");
    expect(states.map((s) => s.kind).sort()).toEqual(["accordion", "modal"]);
    for (const s of states) {
      // Nothing in the recipe or the signature leans on a generated id…
      expect(JSON.stringify(s.recipe), s.id).not.toMatch(GENERATED);
      expect(s.signature ?? "", s.id).not.toMatch(GENERATED);
      // …so the capture, on a fresh load with fresh ids, finds what it waits for.
      expect(s.shots.small?.error, s.id).toBeUndefined();
      expect(s.shots.small?.full, s.id).toBeTruthy();
    }
  }, 120000);

  it("still captures a state recorded with a generated id, from an older routes file", async () => {
    const { manifest } = await capturePipeline({
      config: config(out),
      baseUrl: site.url,
      log: silent,
      inputManifest: {
        routes: [
          {
            id: "home",
            url: "/",
            depth: 0,
            states: [
              {
                id: "modal-edit-profile",
                kind: "modal",
                label: "Edit profile",
                recipe: [
                  { action: "click", target: { role: "button", name: "Edit profile" } },
                  // The id this dialog had when it was discovered.
                  { action: "waitFor", selector: '[id="_r_1i5_"]', state: "visible" },
                ],
                shots: {},
              },
            ] as never,
          },
        ],
      },
    });
    const shot = (manifest as Manifest).routes[0].states[0].shots.small;
    expect(shot?.error).toBeUndefined();
    expect(shot?.full).toBeTruthy();
  }, 60000);
});
