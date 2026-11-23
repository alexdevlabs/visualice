import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseConfig, type Config } from "../../src/shared/config";
import { crawlPipeline } from "../../src/crawl/orchestrator";
import { appHost, closeAppHosts } from "../../src/crawl/app/host";
import { setAppRoot } from "../../src/shared/url";
import type { Manifest } from "../../src/shared/types";
import { silent, tempDir } from "./helpers";

/**
 * An Android app's WebView crawled end to end on an emulator. Needs a running
 * emulator (or device) on adb, so it only runs when VISUALICE_ANDROID=1: CI has a
 * job that starts one. The fixture APK is built by tests/fixture-android/build.sh.
 */

const APK = path.resolve(import.meta.dirname, "..", "fixture-android", "fixture.apk");

const configFor = (out: string, over: Record<string, unknown> = {}, rest = {}): Config =>
  parseConfig(
    {
      app: { android: { package: "com.visualice.fixture", apk: APK, ...over } },
      routesFile: false,
      output: { dir: out },
      politeness: { minDelayMs: 0 },
      stabilize: { waitStrategy: "load" },
      ...rest,
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

describe.skipIf(process.env.VISUALICE_ANDROID !== "1")("an Android WebView app", () => {
  it("is crawled like a site: routes, states, the write left out", async () => {
    const out = await tempDir("android");
    dirs.push(out);
    const manifest = await crawl(configFor(out));
    expect(manifest.routes.map((r) => r.url)).toEqual(["/index.html", "/index.html#/settings"]);
    const home = manifest.routes[0];
    expect(home.states.map((s) => s.kind)).toContain("modal");
    expect(manifest.stats?.wrote?.[0]).toMatchObject({ requests: ["POST /drafts"], blocked: true });
    // The WebView's page, at the phone's width in device pixels (412 × 2.625).
    const shot = home.states[0].shots.phone;
    expect(Math.abs((shot?.width ?? 0) - 1082)).toBeLessThanOrEqual(2);
  });

  it("shoots the whole screen at each device's size when asked", async () => {
    await closeAppHosts();
    const out = await tempDir("android-screen");
    dirs.push(out);
    const manifest = await crawl(
      configFor(
        out,
        { frame: "screen" },
        {
          devices: [
            { name: "phone", width: 412, height: 915, dpr: 2.625, mobile: true, touch: true },
            { name: "tablet", width: 800, height: 1280, dpr: 2, mobile: true, touch: true },
          ],
          discovery: { interactions: { auto: false } },
        },
      ),
    );
    const shots = manifest.routes[0].states[0].shots;
    expect(shots.phone).toMatchObject({ width: 1082, height: 2402 });
    expect(shots.tablet).toMatchObject({ width: 1600, height: 2560 });
  });
});
