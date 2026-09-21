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

describe("serveViewer comparisons", () => {
  let root: string;
  let withDiffs: StaticServer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vc-serve-diffs-"));
    const runDir = path.join(root, "runs", "2026-01-01T00-00-00-000Z");
    const viewer = path.join(root, "viewer");
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(viewer, { recursive: true });
    await fs.writeFile(path.join(runDir, "viewer-data.json"), '{"ok":true}');
    await fs.writeFile(path.join(viewer, "index.html"), "<!doctype html><title>v</title>");

    const diffs = path.join(root, "diffs");
    const good = path.join(diffs, "2026-01-01T00-00-00-000Z__2026-01-02T00-00-00-000Z");
    await fs.mkdir(path.join(good, "images"), { recursive: true });
    await fs.writeFile(path.join(good, "diff.json"), '{"shots":[]}');
    await fs.writeFile(path.join(good, "images", "a.png"), "PNG");
    // A directory that isn't a comparison — offering it would only fail to open.
    await fs.mkdir(path.join(diffs, "scratch"), { recursive: true });
    // …and one whose name is right but which was never written.
    await fs.mkdir(path.join(diffs, "aaa__bbb"), { recursive: true });

    withDiffs = await serveViewer({ runDir, viewerDist: viewer, outRoot: root });
  });

  afterAll(async () => {
    await withDiffs.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists only the directories that hold a comparison", async () => {
    const res = await fetch(`${withDiffs.url}/diffs.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diffs: { id: string; from: string; to: string }[] };
    expect(body.diffs).toEqual([
      {
        id: "2026-01-01T00-00-00-000Z__2026-01-02T00-00-00-000Z",
        from: "2026-01-01T00-00-00-000Z",
        to: "2026-01-02T00-00-00-000Z",
      },
    ]);
  });

  it("serves a comparison's own files", async () => {
    const id = "2026-01-01T00-00-00-000Z__2026-01-02T00-00-00-000Z";
    expect((await fetch(`${withDiffs.url}/diffs/${id}/diff.json`)).status).toBe(200);
    expect(await (await fetch(`${withDiffs.url}/diffs/${id}/images/a.png`)).text()).toBe("PNG");
  });

  it("serves the runs a comparison points at, which is what makes it renderable", async () => {
    const res = await fetch(`${withDiffs.url}/runs/2026-01-01T00-00-00-000Z/viewer-data.json`);
    expect(res.status).toBe(200);
  });

  it("confines diff paths to the diffs directory", async () => {
    const res = await fetch(`${withDiffs.url}/diffs/%2e%2e%2fruns%2fsecret.txt`);
    expect(res.status).toBe(404);
  });

  it("reports an empty list rather than an error when nothing was diffed", async () => {
    const body = (await (await fetch(`${server.url}/diffs.json`)).json()) as { diffs: unknown[] };
    expect(body.diffs).toEqual([]);
  });
});
