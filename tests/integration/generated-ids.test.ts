import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
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

/**
 * A framework nobody listed. Its widgets take a random id on every load
 * (`widget-48213`, then `widget-907`), and its dialogs are numbered by a counter
 * that keeps counting each time one opens (`dlg-12`, `dlg-13`…), starting wherever
 * the page's render left it. Nothing in the built-in patterns matches either; the
 * crawl has to notice them itself.
 */
const UNKNOWN_FRAMEWORK = `<!doctype html><html><head><meta charset="utf-8"><title>Unknown</title>
<style>[hidden]{display:none} [role=dialog]{position:fixed;inset:40px;background:#fff;border:1px solid}</style>
</head><body><h1>Account</h1>
<button type="button" class="toggle" aria-expanded="false">Details</button>
<div class="panel" hidden><p>More about this account.</p></div>
<button type="button" class="open">Preferences</button>
<script>
  const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] % 100000;
  let dialogs = rand() % 50;
  const toggle = document.querySelector(".toggle");
  const panel = document.querySelector(".panel");
  const open = document.querySelector(".open");
  toggle.id = "widget-" + rand();
  panel.id = "widget-" + rand();
  open.id = "widget-" + rand();
  toggle.setAttribute("aria-controls", panel.id);
  toggle.onclick = () => {
    const on = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(on));
    panel.hidden = !on;
  };
  open.onclick = () => {
    const n = ++dialogs;
    const d = document.createElement("div");
    d.setAttribute("role", "dialog");
    d.id = "dlg-" + n;
    const title = document.createElement("h2");
    title.id = "dlg-title-" + n;
    title.textContent = "Preferences";
    d.setAttribute("aria-labelledby", title.id);
    d.append(title);
    document.body.append(d);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll("[role=dialog]").forEach((d) => d.remove());
  });
</script></body></html>`;

describe("ids generated by a framework nobody listed", () => {
  let unknown: { url: string; close: () => Promise<void> };
  let unknownDir: string;
  let unknownOut: string;

  beforeAll(async () => {
    const served = await serveFiles({ "index.html": UNKNOWN_FRAMEWORK });
    unknown = served.server;
    unknownDir = served.dir;
    unknownOut = await tempDir("unknown-ids");
  });

  afterAll(async () => {
    await unknown?.close();
    await fs.rm(unknownDir, { recursive: true, force: true });
    await fs.rm(unknownOut, { recursive: true, force: true });
  });

  it("notices them, avoids them, and says so", async () => {
    const { manifest, runDir } = await crawlPipeline({
      config: config(unknownOut),
      baseUrl: unknown.url,
      log: silent,
    });
    const m = manifest as Manifest;
    // Random per load: seen by loading the page twice. Counted per opening: seen by
    // opening the dialog twice.
    expect(m.hints?.unstableIds).toEqual(
      expect.arrayContaining(["^widget\\-\\d+$", "^dlg\\-\\d+$"]),
    );
    const states = m.routes[0].states.filter((s) => s.kind !== "default");
    expect(states.map((s) => s.kind).sort()).toEqual(["accordion", "modal"]);
    for (const s of states) {
      expect(JSON.stringify(s.recipe), s.id).not.toMatch(/widget-|dlg-/);
      expect(s.signature ?? "", s.id).not.toMatch(/widget-|dlg-\d/);
      expect(s.shots.small?.error, s.id).toBeUndefined();
      expect(s.shots.small?.full, s.id).toBeTruthy();
    }
    // The report tells the agent what to put in the config.
    const report = await fs.readFile(path.join(runDir, "crawl-report.md"), "utf8");
    expect(report).toContain("## Generated ids");
    expect(report).toContain("`^dlg\\-\\d+$`");
  }, 120000);

  it("captures a recipe that waits for an id nobody knew was generated", async () => {
    // Recorded on another load, under another number; no pattern covers `dlg-`
    // here. The click still opens the dialog, and that is what's waited for.
    const { manifest } = await capturePipeline({
      config: config(unknownOut),
      baseUrl: unknown.url,
      log: silent,
      inputManifest: {
        routes: [
          {
            id: "home",
            url: "/",
            depth: 0,
            states: [
              {
                id: "modal-preferences",
                kind: "modal",
                label: "Preferences",
                recipe: [
                  { action: "click", target: { role: "button", name: "Preferences" } },
                  { action: "waitFor", selector: '[id="dlg-7"]', state: "visible" },
                ],
                shots: {},
              },
              {
                // A click that opens nothing, waiting for an id that isn't there:
                // still a failure, not a shot of the wrong thing.
                id: "modal-nothing",
                kind: "modal",
                label: "Nothing",
                recipe: [
                  { action: "click", target: { role: "heading", name: "Account" } },
                  {
                    action: "waitFor",
                    selector: '[id="dlg-8"]',
                    state: "visible",
                    timeoutMs: 1500,
                  },
                ],
                shots: {},
              },
            ] as never,
          },
        ],
      },
    });
    const [ok, missing] = (manifest as Manifest).routes[0].states;
    expect(ok.shots.small?.error).toBeUndefined();
    expect(ok.shots.small?.full).toBeTruthy();
    expect(missing.shots.small?.error).toMatch(/Timeout/);
  }, 60000);
});
