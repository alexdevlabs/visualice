import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "vite";
import { chromium, type Browser, type Locator, type Page } from "playwright";
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
const OTHER_RUN = "2026-01-02T03-04-05-006Z";

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
    server = await serveViewer({
      runDir: run.runDir,
      viewerDist,
      outRoot: out,
      site: "localhost",
      runId,
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

/**
 * Run `fn` with a second site beside the first — a copy of its run under another
 * name. Only for as long as `fn` runs: with two sites the page opens on the
 * dashboard, which every other test would have to click past.
 */
async function withOtherSite(fn: () => Promise<void>): Promise<void> {
  const siteRoot = path.join(out, "sites", "other.test");
  const other = path.join(siteRoot, "runs", OTHER_RUN);
  await fs.cp(path.join(out, "sites", "localhost", "runs", runId), other, { recursive: true });
  const data = JSON.parse(await fs.readFile(path.join(other, "viewer-data.json"), "utf8"));
  data.site = { ...data.site, origin: "https://other.test", runId: OTHER_RUN };
  await fs.writeFile(path.join(other, "viewer-data.json"), JSON.stringify(data));
  try {
    await fn();
  } finally {
    await fs.rm(siteRoot, { recursive: true, force: true });
  }
}

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
  p.on("requestfailed", (r) => errors.push(`failed: ${r.url()} (${r.failure()?.errorText})`));
  p.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()}: ${r.url()}`));
  await p.goto((opts.base ?? server.url) + query);
  // The page is blank until it knows whether to show the dashboard or a run; wait
  // for one of them to start before waiting out the viewer's loader.
  await p.locator('[role="status"][aria-label="Loading"], a[data-site]').first().waitFor();
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
  it("switches between sites, each with its own versions", () =>
    withOtherSite(async () => {
      const { page: p, errors } = await open(`?site=localhost&run=${runId}`);
      try {
        const pickSite = async (key: string) => {
          await p.getByRole("button", { name: "Site" }).click();
          await p.getByRole("listbox", { name: "Site" }).getByRole("option", { name: key }).click();
        };
        await p.getByRole("button", { name: "Site" }).click();
        const selected = p.getByRole("option", { selected: true });
        expect(await selected.textContent()).toContain("localhost");
        await p.keyboard.press("Escape");
        await expect.poll(() => p.getByRole("listbox").count()).toBe(0);
        await pickSite("other.test");
        await expect.poll(() => p.getByText("other.test", { exact: true }).count()).toBe(1);
        const url = new URL(p.url());
        expect(url.searchParams.get("site")).toBe("other.test");
        expect(url.searchParams.get("run")).toBe(OTHER_RUN);
        await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(6);

        // Back again: the URL names the run, so a reload opens it and not the dashboard.
        await pickSite("localhost");
        await expect.poll(() => new URL(p.url()).searchParams.get("site")).toBe("localhost");
        expect(new URL(p.url()).searchParams.get("run")).toBe(runId);
        expect(errors).toEqual([]);
      } finally {
        await p.context().close();
      }
    }));

  it("opens on a dashboard of every site when there is more than one", () =>
    withOtherSite(async () => {
      const { page: p, errors } = await open();
      try {
        const cards = p.locator("a[data-site]");
        await expect.poll(() => cards.count()).toBe(2);
        expect(await p.locator("a[data-site] img").count()).toBe(2);
        expect(await p.getByText("2 sites · 2 versions").count()).toBe(1);

        // Hiding previews swaps them for placeholders, and the choice survives a reload.
        const previews = p.getByRole("button", { name: "Previews" });
        expect(await previews.getAttribute("aria-pressed")).toBe("true");
        await previews.click();
        await expect.poll(() => p.locator("[data-placeholder]").count()).toBe(2);
        await p.reload();
        await expect.poll(() => p.locator("[data-placeholder]").count()).toBe(2);
        expect(await p.locator("a[data-site] img").count()).toBe(0);
        expect(await previews.getAttribute("aria-pressed")).toBe("false");
        await previews.click();
        await expect.poll(() => p.locator("a[data-site] img").count()).toBe(2);

        // Search narrows the cards.
        await p.getByRole("searchbox", { name: "Search sites" }).fill("other");
        await expect.poll(() => cards.count()).toBe(1);

        // A card opens that site's latest run; the logo comes back, and so does Back.
        await p.locator('a[data-site="other.test"]').click();
        // The viewer's boot loader holds for a couple of seconds.
        const tiles = () => p.locator("[data-tile-id]").count();
        await expect.poll(tiles, { timeout: 10_000 }).toBe(6);
        expect(new URL(p.url()).searchParams.get("site")).toBe("other.test");
        await p.getByRole("link", { name: "All sites" }).click();
        await expect.poll(() => cards.count()).toBe(2);
        await p.goBack();
        await expect.poll(tiles, { timeout: 10_000 }).toBe(6);
        expect(errors).toEqual([]);
      } finally {
        await p.context().close();
      }
    }));

  it("deletes a site from the dashboard, after asking", () =>
    withOtherSite(async () => {
      const { page: p, errors } = await open();
      try {
        const cards = p.locator("a[data-site]");
        await expect.poll(() => cards.count()).toBe(2);
        expect(await p.getByText("Add a site").count()).toBe(0);
        // The site being served can't go: `/data/` points into it.
        expect(await p.getByRole("button", { name: "Delete localhost" }).isDisabled()).toBe(true);

        const remove = p.getByRole("button", { name: "Delete other.test" });
        await p.locator('a[data-site="other.test"]').hover();
        await remove.click();
        const ask = p.getByRole("alertdialog", { name: "Delete other.test?" });
        await ask.getByRole("button", { name: "Cancel" }).click();
        expect(await ask.count()).toBe(0);
        await expect.poll(() => cards.count()).toBe(2);

        await p.locator('a[data-site="other.test"]').hover();
        await remove.click();
        await ask.getByRole("button", { name: "Delete site" }).click();
        // One site left, so the page is that site's run.
        await expect.poll(() => p.locator("[data-tile-id]").count(), { timeout: 10_000 }).toBe(6);
        const otherDir = path.join(out, "sites", "other.test");
        expect(await fs.stat(otherDir).catch(() => null)).toBeNull();
        expect(errors).toEqual([]);
      } finally {
        await p.context().close();
      }
    }));

  it("boots on a run and shows every shot", async () => {
    const { page: p, errors } = await open();
    try {
      await expect.poll(() => p.locator("[data-tile-id]").count()).toBe(6);
      await expect
        .poll(() => p.getByRole("navigation", { name: "Routes" }).getByRole("listitem").count())
        .toBe(3);
      expect(await loaded(p, "[data-tile-id] img")).toBeGreaterThan(0);
      // The accessibility finding on the home page is flagged in its tile's caption.
      expect(await p.locator("[data-caption-for]", { hasText: "a11y" }).count()).toBeGreaterThan(0);
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

  it("floats the shot's actions under a clicked shot", async () => {
    const { page: p, errors } = await open("");
    try {
      const tile = p.locator('[data-tile-id="home__default__desktop"]');
      const box = (await tile.boundingBox())!;
      await p.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 10));
      const bar = p.getByRole("toolbar", { name: "Shot actions" });
      await bar.waitFor();
      for (const name of ["Full image", "Download"])
        await bar.getByRole("link", { name }).waitFor();

      // The bar and the details panel offer the same actions, 1:1 (see ShotActions).
      const actions = (root: Locator) =>
        root
          .locator("a, button")
          .filter({ hasText: /^(Full screen|Live page|Copy link|Copied|Download|Full image)$/ })
          .allInnerTexts();
      const panel = p.getByRole("complementary", { name: "Shot details" });
      const order = ["Full screen", "Live page", "Copy link", "Download", "Full image"];
      expect(await actions(bar)).toEqual(order);
      expect(await actions(panel)).toEqual(order);

      // Its buttons work without the click reaching the canvas and dropping the selection.
      await bar.getByRole("button", { name: /Copy link|Copied/ }).click();
      expect(p.url()).toContain("tile=home__default__desktop");

      // The bar sits under the shot once it has glided into focus.
      await expect
        .poll(async () => {
          const shot = (await p.locator('[data-tile-id="home__default__desktop"]').boundingBox())!;
          const b = (await bar.boundingBox())!;
          return b.y > shot.y + shot.height - 1;
        })
        .toBe(true);

      // Dragged by its grip, it stays where it's put, even for another shot;
      // a double-click on the grip puts it back under the shot.
      const grip = bar.getByRole("button", { name: /Move the bar/ });
      const g = (await grip.boundingBox())!;
      await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await p.mouse.down();
      await p.mouse.move(g.x + 40, g.y - 200, { steps: 5 });
      await p.mouse.up();
      const moved = (await bar.boundingBox())!;
      expect(moved.y).toBeLessThan(g.y - 150);
      expect(p.url()).toContain("tile=home__default__desktop");
      await p.reload();
      await bar.waitFor();
      expect(Math.abs((await bar.boundingBox())!.y - moved.y)).toBeLessThan(2);
      await bar.getByRole("button", { name: /Move the bar/ }).dblclick();
      await expect
        .poll(async () => {
          const shot = (await p.locator('[data-tile-id="home__default__desktop"]').boundingBox())!;
          const b = (await bar.boundingBox())!;
          return b.y > shot.y + shot.height - 1;
        })
        .toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await p.context().close();
    }
  });

  it("opens a shot full screen under the viewer's own header and toolbar", async () => {
    const { page: p, errors } = await open("?tile=home__default__desktop");
    try {
      const details = p.getByRole("complementary", { name: "Shot details" });
      await details.getByRole("button", { name: "Full screen" }).click();
      const full = p.getByRole("region", { name: "Full screen" });
      await full.waitFor();
      expect(p.url()).toContain("full=1");
      // Only the body changes: the same header and toolbar, no sidebar or details.
      await p.getByRole("radiogroup", { name: "Mode" }).waitFor();
      expect(await p.getByRole("navigation", { name: "Routes" }).count()).toBe(0);
      expect(await details.count()).toBe(0);
      // Devices is the canvas's own: checkboxes, both devices on.
      const devices = p.getByRole("group", { name: "Devices" });
      expect(await devices.getByRole("checkbox").count()).toBe(2);
      // The tab over the body says so, and offers the way out.
      await full.getByRole("button", { name: "Exit Esc", exact: true }).waitFor();
      // The bar under the shot starts with the way out.
      await full
        .getByRole("toolbar", { name: "Shot actions" })
        .getByRole("button", { name: "Exit full screen" })
        .waitFor();

      // The state on every device that's on, side by side; turning the selected
      // shot's device off leaves it on the other one, alone.
      await expect.poll(() => full.locator("[data-tile-id]").count()).toBe(2);
      await devices.getByRole("checkbox", { name: /desktop/ }).click();
      await expect.poll(() => p.url()).toContain("tile=home__default__mobile");
      expect(await full.locator("[data-tile-id]").count()).toBe(1);
      expect(p.url()).toContain("devices=mobile");

      // The arrows step through that device's shots.
      await p.keyboard.press("ArrowRight");
      await expect.poll(() => p.url()).not.toContain("tile=home__default__mobile");
      expect(p.url()).toMatch(/tile=[^&]*__mobile/);

      await p.keyboard.press("Escape");
      await details.waitFor();
      expect(p.url()).not.toContain("full=1");
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
      runDir: path.join(out, "sites", "localhost", "runs", runId),
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
