import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import { exportRun } from "../../src/export";
import { serveViewer } from "../../src/serve";
import { serveDirectory } from "../../src/shared/static-server";
import type { StaticServer } from "../../src/shared/file-serve";
import type { InputManifest } from "../../src/shared/types";
import { serveFiles, silent, tempDir } from "./helpers";

/**
 * The viewer, driven the way a person drives it.
 *
 * Its pure halves (layout, LOD, URL state) have unit tests; this covers what they
 * can't — that the built app boots against real run data, that the controls do what
 * their labels say, and that it works from a static export. It builds the viewer from the current sources into a scratch
 * directory, so it never passes against a stale `viewer/dist`.
 */

const REPO = path.resolve(import.meta.dirname, "..", "..");

const page = (title: string, box: string, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:24px}.box{width:200px;height:120px;background:${box}}</style>
</head><body><h1>${title}</h1><div class="box"></div>${extra}</body></html>`;

/** An image with no alt text: the one accessibility violation on the site. */
const NO_ALT = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;

let out: string;
let siteDir: string;
let viewerDist: string;
let server: StaticServer;
let browser: Browser;
let runId: string;

const config = (dir: string): Config =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    devices: [
      { name: "desktop", width: 800, height: 600, dpr: 1 },
      { name: "mobile", width: 390, height: 600, dpr: 2, mobile: true, touch: true },
    ],
    stabilize: { waitStrategy: "load", extraDelayMs: 25 },
    politeness: { minDelayMs: 0 },
    checks: { accessibility: true },
  });

const model = (): InputManifest => ({
  routes: ["/", "/about.html", "/pricing.html"].map((url) => ({
    id: url === "/" ? "home" : url.slice(1).replace(".html", ""),
    url,
    depth: 0,
    states: [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }],
  })),
});

beforeAll(async () => {
  out = await tempDir("viewer-out");
  viewerDist = path.join(out, "viewer-dist");
  await build({
    root: path.join(REPO, "viewer"),
    configFile: path.join(REPO, "viewer", "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: viewerDist, emptyOutDir: true },
  });

  const site = await serveFiles({
    "index.html": page("Home", "#2b6", NO_ALT),
    "about.html": page("About", "#36c"),
    "pricing.html": page("Pricing", "#c63"),
  });
  siteDir = site.dir;
  try {
    const run = await capturePipeline({
      config: config(out),
      inputManifest: model(),
      baseUrl: site.server.url,
      log: silent,
    });
    runId = run.manifest.site.runId;
    server = await serveViewer({ runDir: run.runDir, viewerDist, outRoot: out, runId });
  } finally {
    await site.server.close();
  }
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await fs.rm(out, { recursive: true, force: true });
  await fs.rm(siteDir, { recursive: true, force: true });
});

/** Open the viewer and wait out the boot loader. Collects what the page complains about. */
async function open(
  query = "",
  opts: { base?: string; viewport?: { width: number; height: number } } = {},
): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const p = await context.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("requestfailed", (r) => errors.push(`failed: ${r.url()}`));
  p.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()}: ${r.url()}`));
  await p.goto((opts.base ?? server.url) + query);
  await p.getByRole("status", { name: "Loading" }).waitFor({ state: "detached", timeout: 15_000 });
  return { page: p, errors };
}

const loaded = (p: Page, selector: string) =>
  p
    .locator(selector)
    .first()
    .evaluate((img: HTMLImageElement) =>
      img.decode().then(
        () => img.naturalWidth,
        () => 0,
      ),
    );

describe("viewer", () => {
  it("boots on a run and shows every shot", async () => {
    const { page: p, errors } = await open();
    try {
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(6);
      await expect
        .poll(() => p.getByRole("navigation", { name: "Routes" }).getByRole("listitem").count())
        .toBe(3);
      expect(await loaded(p, "[data-tile-id] img")).toBeGreaterThan(0);
      // The accessibility finding on the home page is flagged on its tile.
      expect(await p.locator("[data-tile-id]", { hasText: "a11y" }).count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);

      // Picking a route leaves only that route on the canvas, and the link keeps it.
      const routes = p.getByRole("navigation", { name: "Routes" });
      const total = await p.locator("[data-tile-id]").count();
      await routes.getByRole("listitem").first().getByRole("button").click();
      await expect.poll(() => p.url()).toContain("route=");
      const ids = await p
        .locator("[data-tile-id]")
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tileId!.split("__")[0]));
      expect(new Set(ids).size).toBe(1);
      await routes.getByRole("button", { name: /All routes/ }).click();
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(total);
    } finally {
      await p.context().close();
    }
  });

  it("filters, searches and keeps the view in the URL", async () => {
    const { page: p } = await open();
    try {
      await p
        .getByRole("searchbox")
        .or(p.getByLabel("Search routes and states"))
        .first()
        .fill("pricing");
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(2);
      await expect.poll(() => p.url()).toContain("q=pricing");

      // Opening the same address lands on the same view.
      const { page: again } = await open(new URL(p.url()).search);
      await expect.poll(() => again.locator("[data-tile-id]").count()).toBe(2);
      await again.context().close();

      await p.getByLabel("Search routes and states").fill("");
      await p.getByRole("group", { name: "Devices" }).getByText("mobile").click();
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(3);
    } finally {
      await p.context().close();
    }
  });

  it("remembers the theme and the minimap, both off by default", async () => {
    const { page: p } = await open();
    try {
      expect(await p.locator("html").getAttribute("data-theme")).toBe("light");
      expect(await p.getByTestId("minimap").count()).toBe(0);

      await p.getByRole("button", { name: "Switch to dark mode" }).click();
      expect(await p.locator("html").getAttribute("data-theme")).toBe("dark");
      await p.getByRole("button", { name: "Minimap" }).click();
      await p.getByTestId("minimap").waitFor();

      await p.reload();
      await p.getByRole("status", { name: "Loading" }).waitFor({ state: "detached" });
      expect(await p.locator("html").getAttribute("data-theme")).toBe("dark");
      await p.getByTestId("minimap").waitFor();

      // …and the keyboard toggles it back off.
      await p.mouse.click(640, 400);
      await p.keyboard.press("m");
      await expect.poll(() => p.getByTestId("minimap").count()).toBe(0);
    } finally {
      await p.context().close();
    }
  });

  it("opens a shot's details, with its accessibility findings and a download", async () => {
    const { page: p, errors } = await open("?tile=home__default__desktop");
    try {
      const details = p.getByRole("complementary", { name: "Shot details" });
      await details.waitFor();
      await details.getByRole("heading", { name: "Default" }).waitFor();

      const download = details.getByRole("link", { name: "Download" });
      expect(await download.getAttribute("download")).toBe("home--default--desktop.png");
      const [file] = await Promise.all([p.waitForEvent("download"), download.click()]);
      expect(file.suggestedFilename()).toBe("home--default--desktop.png");

      const a11y = details.getByRole("region", { name: "Accessibility" });
      await a11y.getByText("Images must have alternative text").waitFor();
      await a11y.getByText("critical").waitFor();

      // Stepping moves to the next shot and the URL follows.
      await details.getByRole("button", { name: "Next shot" }).click();
      await expect.poll(() => p.url()).not.toContain("tile=home__default__desktop");
      expect(errors).toEqual([]);
    } finally {
      await p.context().close();
    }
  });

  it("lays out for a phone", async () => {
    const { page: p, errors } = await open("", { viewport: { width: 390, height: 780 } });
    try {
      await p.getByRole("button", { name: "View and filters" }).click();
      await p.getByRole("dialog", { name: "View and filters" }).waitFor();
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally {
      await p.context().close();
    }
  });

  it("works from a static export, with no server of its own", async () => {
    const dest = path.join(out, "site");
    const result = await exportRun({
      runDir: path.join(out, "runs", runId),
      runId,
      viewerDist,
      dest,
    });
    expect(result.runId).toBe(runId);
    // Any dumb file server will do — that is the point of an export.
    const plain = await serveDirectory(dest);
    try {
      const { page: p, errors } = await open("", { base: plain.url });
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(6);
      expect(await loaded(p, "[data-tile-id] img")).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      await p.context().close();
    } finally {
      await plain.close();
    }
  });
});
