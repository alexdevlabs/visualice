import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { ConfigSchema, type Config } from "../../src/shared/config";
import { capturePipeline } from "../../src/crawl/orchestrator";
import { diffRuns } from "../../src/diff";
import { approveRun } from "../../src/baseline";
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
 * their labels say, and that a comparison's pictures actually load from the three
 * places they live. It builds the viewer from the current sources into a scratch
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
let fromId: string;
let toId: string;

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
    const cfg = config(out);
    const before = await capturePipeline({
      config: cfg,
      inputManifest: model(),
      baseUrl: site.server.url,
      log: silent,
    });
    await approveRun({ runDir: before.runDir, baselineDir: path.join(out, "baseline") });
    await fs.writeFile(path.join(siteDir, "index.html"), page("Home", "#d33", NO_ALT));
    const after = await capturePipeline({
      config: cfg,
      inputManifest: model(),
      baseUrl: site.server.url,
      log: silent,
    });
    fromId = before.manifest.site.runId;
    toId = after.manifest.site.runId;
    await diffRuns({
      fromDir: before.runDir,
      toDir: after.runDir,
      outDir: path.join(out, "diffs", `${fromId}__${toId}`),
    });
    await diffRuns({
      fromDir: path.join(out, "baseline"),
      toDir: after.runDir,
      fromBaseline: true,
      outDir: path.join(out, "diffs", `baseline__${toId}`),
    });
    server = await serveViewer({
      runDir: after.runDir,
      viewerDist,
      outRoot: out,
      runId: toId,
      baselineDir: path.join(out, "baseline"),
    });
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
        .poll(() => p.getByRole("navigation", { name: "Routes" }).getByRole("button").count())
        .toBe(3);
      expect(await loaded(p, "[data-tile-id] img")).toBeGreaterThan(0);
      // The accessibility finding on the home page is flagged on its tile.
      expect(await p.locator("[data-tile-id]", { hasText: "a11y" }).count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
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

  it("reviews a comparison in every mode, from the run and from the baseline", async () => {
    for (const id of [`${fromId}__${toId}`, `baseline__${toId}`]) {
      const { page: p, errors } = await open(`?diff=${encodeURIComponent(id)}`);
      try {
        const review = p.getByRole("region", { name: "Review" });
        await review.waitFor();
        // Two devices of the one page that changed.
        await expect
          .poll(() =>
            p.getByRole("navigation", { name: "Changed shots" }).getByRole("button").count(),
          )
          .toBe(2);
        await review.getByText("of pixels changed").waitFor();

        const prefix = id.startsWith("baseline") ? "./baseline/" : `./runs/${fromId}/`;
        const srcs = await review
          .locator("img")
          .evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src") ?? ""));
        expect(srcs.some((s) => s.startsWith(prefix))).toBe(true);
        expect(srcs.some((s) => s.startsWith(`./runs/${toId}/`))).toBe(true);

        for (const mode of ["Side by side", "Overlay", "Diff", "Swipe"]) {
          await review.getByRole("radio", { name: mode }).click();
          expect(await loaded(p, 'section[aria-label="Review"] img')).toBeGreaterThan(0);
        }
        await review.getByRole("radio", { name: "Diff" }).click();
        expect(await review.locator("img").first().getAttribute("src")).toContain(
          `./diffs/${id}/images/`,
        );

        await p.keyboard.press("j");
        await review.getByText("2 / 2").waitFor();
        expect(errors).toEqual([]);
      } finally {
        await p.context().close();
      }
    }
  });

  it("turns a dragged box into an ignore rule", async () => {
    const { page: p } = await open(`?diff=${encodeURIComponent(`${fromId}__${toId}`)}`);
    try {
      const review = p.getByRole("region", { name: "Review" });
      await review.getByRole("button", { name: "Mark a region to ignore in future diffs" }).click();
      const img = review.locator("img").first();
      await img.waitFor();
      const box = (await img.boundingBox())!;
      await p.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 4 });
      await p.mouse.up();

      await review.getByTestId("ignore-region").waitFor();
      const rule = JSON.parse((await review.locator("pre").textContent())!);
      expect(rule).toMatchObject({ route: "/", state: "default" });
      const [rect] = rule.ignore;
      // Half the width and a quarter of the height of the shot, in CSS px.
      const device = rule.device === "mobile" ? { w: 390, dpr: 2 } : { w: 800, dpr: 1 };
      expect(Math.abs(rect.x - device.w * 0.25)).toBeLessThanOrEqual(2);
      expect(Math.abs(rect.width - device.w * 0.5)).toBeLessThanOrEqual(2);
      expect(rect.height).toBeGreaterThan(0);

      await review.getByRole("button", { name: "Copy rule" }).click();
      await review.getByRole("button", { name: "Copied" }).waitFor();
      expect(JSON.parse(await p.evaluate(() => navigator.clipboard.readText()))).toEqual(rule);
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
      runDir: path.join(out, "runs", toId),
      runId: toId,
      viewerDist,
      outRoot: out,
      baselineDir: path.join(out, "baseline"),
      dest,
    });
    expect(result.diffs.sort()).toEqual([`${fromId}__${toId}`, `baseline__${toId}`].sort());
    // Any dumb file server will do — that is the point of an export.
    const plain = await serveDirectory(dest);
    try {
      const { page: p, errors } = await open("", { base: plain.url });
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(6);
      await p.getByRole("radio", { name: "Compare" }).click();
      const review = p.getByRole("region", { name: "Review" });
      await review.getByText("of pixels changed").waitFor();
      for (const mode of ["Side by side", "Diff"]) {
        await review.getByRole("radio", { name: mode }).click();
        expect(await loaded(p, 'section[aria-label="Review"] img')).toBeGreaterThan(0);
      }
      expect(errors).toEqual([]);
      await p.context().close();
    } finally {
      await plain.close();
    }
  });
});
