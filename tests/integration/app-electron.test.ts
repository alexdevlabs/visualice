import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseConfig, type Config } from "../../src/shared/config";
import { capturePipeline, crawlPipeline } from "../../src/crawl/orchestrator";
import { probePage, type ProbeOutcome } from "../../src/crawl/probe";
import { appHost, closeAppHosts } from "../../src/crawl/app/host";
import { setAppRoot } from "../../src/shared/url";
import type { Manifest } from "../../src/shared/types";
import { silent, tempDir } from "./helpers";

/**
 * An Electron app crawled end to end: started by Playwright and, for apps built with
 * the Node inspector switched off, over CDP. The fixture is a page loaded from disk,
 * with hash routes, a dialog and a button that writes to a server.
 */

const FIXTURE = path.resolve(import.meta.dirname, "..", "fixture-electron");
// Electron's sandbox helper needs setuid root, which a CI runner's checkout doesn't have.
const args = process.platform === "linux" ? ["--no-sandbox"] : [];

const configFor = (out: string, over: Record<string, unknown> = {}): Config =>
  parseConfig(
    {
      app: { electron: { executable: FIXTURE, args, ...over } },
      routesFile: false,
      output: { dir: out },
      politeness: { minDelayMs: 0 },
      stabilize: { waitStrategy: "load" },
    },
    silent,
  );

async function crawl(config: Config): Promise<Manifest> {
  const baseUrl = await appHost(config)!.startUrl();
  return (await crawlPipeline({ config, baseUrl, log: silent })).manifest;
}

const dirs: string[] = [];
afterAll(async () => {
  await closeAppHosts();
  setAppRoot(undefined);
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("an Electron app, launched", () => {
  let config: Config;
  let manifest: Manifest;

  beforeAll(async () => {
    const out = await tempDir("electron");
    dirs.push(out);
    config = configFor(out, { connect: "launch" });
    manifest = await crawl(config);
  });

  it("names its pages from the app's folder", () => {
    expect(manifest.routes.map((r) => r.url)).toEqual(["/index.html", "/index.html#/settings"]);
    expect(manifest.routes[0].title).toBe("Fixture App");
  });

  it("finds the dialog and leaves out the button that writes", () => {
    const home = manifest.routes[0];
    expect(home.states.map((s) => s.kind)).toContain("modal");
    // Found by their stable ids, which recipes prefer to a role and name.
    const recipes = JSON.stringify(home.states.map((s) => s.recipe));
    expect(recipes).toContain("#show-dialog");
    expect(recipes).not.toContain("#save");
    expect(manifest.stats?.wrote).toMatchObject([
      { trigger: expect.stringContaining("Save draft"), requests: ["POST /drafts"], blocked: true },
    ]);
  });

  it("shoots each state at the device's size and pixel ratio", () => {
    const shots = manifest.routes.flatMap((r) => r.states.map((s) => s.shots.desktop));
    expect(shots.length).toBeGreaterThanOrEqual(3);
    for (const shot of shots) {
      // Full-page shots: as wide as the window, and at least as tall (a page a pixel
      // taller than the window, as fonts render on Windows, is shot whole).
      expect(shot?.width).toBe(2560);
      expect(shot?.height).toBeGreaterThanOrEqual(1600);
    }
  });

  it("probes a recipe in the app like on a page", async () => {
    const outcome = (await probePage({
      config,
      baseUrl: await appHost(config)!.startUrl(),
      url: "/index.html",
      recipe: [{ action: "click", target: { role: "button", name: "Open dialog" } }],
    })) as ProbeOutcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.appeared.join(" ")).toContain("A dialog inside the app");
  });
});

describe("an Electron app, connected over CDP", () => {
  it("is crawled the same way, at the device's size", async () => {
    await closeAppHosts();
    const out = await tempDir("electron-cdp");
    dirs.push(out);
    const config = configFor(out, { connect: "cdp" });
    const manifest = await crawl({
      ...config,
      discovery: {
        ...config.discovery,
        interactions: { ...config.discovery.interactions, auto: false },
      },
    });
    expect(manifest.routes.map((r) => r.url)).toEqual(["/index.html", "/index.html#/settings"]);
    const shot = manifest.routes[0].states[0].shots.desktop;
    expect(shot?.width).toBe(2560);
    expect(shot?.height).toBeGreaterThanOrEqual(1600);
  });
});

describe("an Electron app started from a profile", () => {
  it("runs on a copy of the profile, and leaves the profile as it was", async () => {
    await closeAppHosts();
    const source = await tempDir("electron-profile");
    dirs.push(source);
    await fs.writeFile(path.join(source, "greeting.txt"), "Signed in as Ada");
    const config = configFor(source, { connect: "launch", profile: source });
    const host = appHost(config)!;
    await host.startUrl();
    const page = await host.newContext().newPage();
    const seen = (await page.evaluate(() => ({
      ...(window as unknown as { fixture: { userData: string; greeting: string } }).fixture,
      shown: document.getElementById("greeting")?.textContent,
    }))) as { userData: string; greeting: string; shown?: string };
    expect(seen.shown).toBe("Signed in as Ada");
    expect(path.resolve(seen.userData)).not.toBe(path.resolve(source));

    await closeAppHosts();
    // The app wrote its own files into the copy, not into the profile it came from,
    // and the copy is gone with the app.
    expect(await fs.readdir(source)).toEqual(["greeting.txt"]);
    await expect(fs.stat(seen.userData)).rejects.toThrow();
  });
});

describe("an isolated state in an Electron app", () => {
  it("gets a copy of its own, and the state after it a fresh one", async () => {
    await closeAppHosts();
    const out = await tempDir("electron-isolate");
    dirs.push(out);
    const base = configFor(out, { connect: "launch" });
    // No retries: a state handed a closed copy would fail, not be retried into passing.
    const config = { ...base, politeness: { ...base.politeness, retries: 0 } };
    const host = appHost(config)!;
    const baseUrl = await host.startUrl();
    const launches = vi.spyOn(
      (host as unknown as { driver: { launch: (d: unknown) => Promise<unknown> } }).driver,
      "launch",
    );
    const dialog = { action: "click", target: { role: "button", name: "Open dialog" } } as const;
    const { manifest } = await capturePipeline({
      config,
      baseUrl,
      inputManifest: {
        routes: [
          {
            id: "/index.html",
            url: "/index.html",
            depth: 0,
            states: [
              { id: "default", kind: "default", label: "Default", recipe: [], shots: {} },
              {
                id: "dialog-alone",
                kind: "modal",
                label: "Dialog, isolated",
                isolate: true,
                recipe: [dialog],
                shots: {},
              },
              { id: "dialog", kind: "modal", label: "Dialog", recipe: [dialog], shots: {} },
            ],
          },
        ],
      },
      log: silent,
    });
    expect(manifest.stats?.failures).toEqual([]);
    const shots = manifest.routes[0].states.map((s) => s.shots.desktop);
    expect(shots.every((s) => s && !("error" in s))).toBe(true);
    // The first state used the copy that found the start page; the isolated state
    // and the state after it each started one.
    expect(launches).toHaveBeenCalledTimes(2);
  });
});
