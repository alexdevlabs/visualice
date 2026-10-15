import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveViewer } from "../src/serve";
import type { StaticServer } from "../src/shared/file-serve";

let tmp: string;
let server: StaticServer;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vc-serve-"));
  const runs = path.join(tmp, "runs");
  const runDir = path.join(runs, "latest");
  const sibling = path.join(runs, "latest-evil"); // shares the "latest" name prefix
  const viewer = path.join(tmp, "viewer");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.mkdir(viewer, { recursive: true });
  await fs.writeFile(path.join(runDir, "viewer-data.json"), '{"ok":true}');
  await fs.writeFile(path.join(sibling, "secret.txt"), "TOP SECRET");
  await fs.writeFile(path.join(viewer, "index.html"), "<!doctype html><title>v</title>");
  server = await serveViewer({ runDir, viewerDist: viewer });
});

afterAll(async () => {
  await server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("serveViewer path confinement", () => {
  it("serves a legitimate file under /data", async () => {
    const res = await fetch(`${server.url}/data/viewer-data.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Plain `..`/`%2e%2e` is normalized away by `new URL`; the traversal that actually
  // reaches the file server is smuggled through an encoded slash (%2f), which the URL
  // parser keeps opaque and decodeURIComponent then expands. The separator guard blocks it.
  it("blocks encoded-slash traversal into a sibling run dir", async () => {
    const res = await fetch(`${server.url}/data/%2e%2e%2flatest-evil%2fsecret.txt`);
    expect(res.status).toBe(404);
  });

  it("blocks encoded-slash traversal above the run root", async () => {
    const res = await fetch(`${server.url}/data/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    expect(res.status).toBe(404);
  });

  it("serves the viewer index and SPA-falls-back", async () => {
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    expect((await fetch(`${server.url}/some/spa/route`)).status).toBe(200);
  });
});

describe("serveViewer sites and runs", () => {
  const ID = "2026-01-01T00-00-00-000Z";
  const OTHER = "2026-02-01T00-00-00-000Z";
  let root: string;
  let withRuns: StaticServer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vc-serve-runs-"));
    const runDir = path.join(root, "sites", "example.com", "runs", ID);
    const other = path.join(root, "sites", "shop.test", "runs", OTHER);
    const viewer = path.join(root, "viewer");
    for (const dir of [runDir, other, viewer]) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(runDir, "viewer-data.json"), '{"ok":true}');
    await fs.writeFile(path.join(other, "viewer-data.json"), '{"other":true}');
    await fs.writeFile(path.join(root, "sites", "secret.txt"), "TOP SECRET");
    await fs.writeFile(path.join(viewer, "index.html"), "<!doctype html><title>v</title>");
    withRuns = await serveViewer({
      runDir,
      viewerDist: viewer,
      outRoot: root,
      site: "example.com",
      runId: ID,
    });
  });

  afterAll(async () => {
    await withRuns.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists every site and its runs, which is what the pickers offer", async () => {
    const res = await fetch(`${withRuns.url}/sites.json`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      current: { site: "example.com", run: ID },
      sites: [
        { key: "example.com", latest: ID, runs: [ID] },
        { key: "shop.test", latest: OTHER, runs: [OTHER] },
      ],
    });
  });

  it("summarizes each site's latest run for the dashboard", async () => {
    const dir = path.join(root, "sites", "shop.test", "runs", OTHER);
    const shot = (name: string) => ({ mid: `screenshots/${name}/default/desktop.mid.webp` });
    await fs.writeFile(
      path.join(dir, "crawl-map.json"),
      JSON.stringify({
        site: { title: "Shop", origin: "https://shop.test" },
        devices: [{ name: "mobile", mobile: true }, { name: "desktop" }],
        routes: [
          { url: "/about", states: [{ kind: "default", shots: { desktop: shot("about") } }] },
          { url: "/", states: [{ kind: "default", shots: { desktop: shot("home") } }] },
        ],
        stats: { routes: 2, states: 2, shots: 4, failed: 1 },
      }),
    );
    const list = await (await fetch(`${withRuns.url}/sites.json`)).json();
    expect(list.sites[1].summary).toEqual({
      title: "Shop",
      origin: "https://shop.test",
      routes: 2,
      states: 2,
      shots: 4,
      failed: 1,
      // The home page, on the desktop, whichever order the map lists them in.
      thumb: "screenshots/home/default/desktop.mid.webp",
    });
    // A run with no map yet has nothing to summarize.
    expect(list.sites[0].summary).toBeUndefined();
    await fs.rm(path.join(dir, "crawl-map.json"));
  });

  it("serves any site's runs, and the current site's under their old path too", async () => {
    const other = await fetch(`${withRuns.url}/sites/shop.test/runs/${OTHER}/viewer-data.json`);
    expect(await other.json()).toEqual({ other: true });
    const own = await fetch(`${withRuns.url}/runs/${ID}/viewer-data.json`);
    expect(await own.json()).toEqual({ ok: true });
    // `/runs/` is the current site only: another site's run isn't there.
    expect((await fetch(`${withRuns.url}/runs/${OTHER}/viewer-data.json`)).status).toBe(404);
  });

  it("keeps a site path inside that site's runs", async () => {
    for (const url of [
      "/sites/%2e%2e/runs/x",
      "/sites/example.com/secret.txt",
      `/sites/example.com/runs/%2e%2e%2f%2e%2e%2fsecret.txt`,
    ]) {
      expect((await fetch(withRuns.url + url)).status).toBe(404);
    }
  });

  it("pins a run's images by id, but never through an alias for the newest run", async () => {
    // `/data/` and `runs/latest/` put a different run's pixels behind the same URL
    // after every crawl; caching them as immutable is what showed stale screenshots.
    const runsDir = path.join(root, "sites", "example.com", "runs");
    await fs.writeFile(path.join(runsDir, ID, "shot.png"), "PNG");
    await fs.symlink(ID, path.join(runsDir, "latest"), "dir").catch(() => {});
    const header = async (url: string) => {
      const res = await fetch(withRuns.url + url);
      await res.arrayBuffer();
      return res.headers.get("cache-control");
    };
    const pinned = `/sites/example.com/runs/${ID}/shot.png`;
    expect(await header(pinned)).toBe("public, max-age=31536000, immutable");
    expect(await header(`/runs/${ID}/shot.png`)).toBe("public, max-age=31536000, immutable");
    expect(await header("/data/shot.png")).toBe("no-cache");
    if (await fs.readlink(path.join(runsDir, "latest")).catch(() => undefined)) {
      expect(await header("/sites/example.com/runs/latest/shot.png")).toBe("no-cache");
    }
    // A run that is still being written (or awaits --resume) isn't final either.
    await fs.writeFile(path.join(runsDir, ID, ".incomplete"), "");
    expect(await header(pinned)).toBe("no-cache");
    await fs.rm(path.join(runsDir, ID, ".incomplete"));
  });
});
