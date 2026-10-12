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

describe("serveViewer sibling runs", () => {
  let root: string;
  let withRuns: StaticServer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vc-serve-runs-"));
    const runDir = path.join(root, "runs", "2026-01-01T00-00-00-000Z");
    const viewer = path.join(root, "viewer");
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(viewer, { recursive: true });
    await fs.writeFile(path.join(runDir, "viewer-data.json"), '{"ok":true}');
    await fs.writeFile(path.join(viewer, "index.html"), "<!doctype html><title>v</title>");
    withRuns = await serveViewer({ runDir, viewerDist: viewer, outRoot: root });
  });

  afterAll(async () => {
    await withRuns.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("serves the other runs, which is what the run switcher opens", async () => {
    const res = await fetch(`${withRuns.url}/runs/2026-01-01T00-00-00-000Z/viewer-data.json`);
    expect(res.status).toBe(200);
  });

  it("pins a run's images by id, but never through an alias for the newest run", async () => {
    // `/data/` and `runs/latest/` put a different run's pixels behind the same URL
    // after every crawl; caching them as immutable is what showed stale screenshots.
    const id = "2026-01-01T00-00-00-000Z";
    const runsDir = path.join(root, "runs");
    await fs.writeFile(path.join(runsDir, id, "shot.png"), "PNG");
    await fs.symlink(id, path.join(runsDir, "latest"), "dir").catch(() => {});
    const header = async (url: string) => {
      const res = await fetch(withRuns.url + url);
      await res.arrayBuffer();
      return res.headers.get("cache-control");
    };
    expect(await header(`/runs/${id}/shot.png`)).toBe("public, max-age=31536000, immutable");
    expect(await header("/data/shot.png")).toBe("no-cache");
    if (await fs.readlink(path.join(runsDir, "latest")).catch(() => undefined)) {
      expect(await header("/runs/latest/shot.png")).toBe("no-cache");
    }
    // A run that is still being written (or awaits --resume) isn't final either.
    await fs.writeFile(path.join(runsDir, id, ".incomplete"), "");
    expect(await header(`/runs/${id}/shot.png`)).toBe("no-cache");
    await fs.rm(path.join(runsDir, id, ".incomplete"));
  });
});
