import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../src/shared/config";
import {
  approveRun,
  baselineDir,
  hasBaseline,
  mergeApproved,
  readBaselineInfo,
} from "../src/baseline";
import type { Manifest, RouteNode } from "../src/shared/types";

const route = (url: string, states: string[], tag: string): RouteNode => ({
  id: url,
  url,
  depth: 0,
  title: tag,
  states: states.map((id) => ({
    id,
    kind: "default",
    label: id,
    recipe: [],
    shots: {
      desktop: { full: `screenshots/${url === "/" ? "home" : url.slice(1)}/${id}/desktop.png` },
    },
  })),
});

const manifest = (runId: string, routes: RouteNode[]): Manifest => ({
  version: 1,
  site: { baseUrl: "https://x.test", origin: "https://x.test", runId, generatedAt: "t" },
  devices: [{ name: "desktop", width: 100, height: 100, dpr: 1 }],
  routes,
});

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vc-baseline-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Write a run directory whose every shot file contains `tag`. */
async function writeRun(name: string, m: Manifest, tag: string): Promise<string> {
  const dir = path.join(tmp, "runs", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "crawl-map.json"), JSON.stringify(m));
  for (const r of m.routes) {
    for (const s of r.states) {
      const file = path.join(dir, s.shots.desktop.full!);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, tag);
    }
  }
  return dir;
}

const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), "utf8");

describe("baselineDir", () => {
  it("defaults to a folder inside the output directory, outside runs/", () => {
    const c = ConfigSchema.parse({ output: { dir: "/tmp/out" } });
    expect(baselineDir(c)).toBe(path.resolve("/tmp/out/baseline"));
    const custom = ConfigSchema.parse({ baseline: { dir: "visual-baseline" } });
    expect(baselineDir(custom)).toBe(path.resolve("visual-baseline"));
  });
});

describe("mergeApproved", () => {
  it("replaces, adds and drops only the routes the globs match", () => {
    const base = manifest("r1", [
      route("/", ["default"], "old"),
      route("/blog", ["default"], "old"),
      route("/blog/gone", ["default"], "old"),
      route("/about", ["default"], "old"),
    ]);
    const run = manifest("r2", [
      route("/", ["default"], "new"),
      route("/blog", ["default", "menu"], "new"),
      route("/blog/fresh", ["default"], "new"),
      route("/about", ["default"], "new"),
    ]);
    const { manifest: merged, replaced, dropped } = mergeApproved(base, run, ["/blog/**"]);
    const titles = Object.fromEntries(merged.routes.map((r) => [r.url, r.title]));
    expect(titles).toEqual({ "/": "old", "/blog": "new", "/about": "old", "/blog/fresh": "new" });
    expect(replaced.map((r) => r.url)).toEqual(["/blog"]);
    // Approving a run in which a page is gone approves that it's gone.
    expect(dropped.map((r) => r.url)).toEqual(["/blog/gone"]);
  });
});

describe("approveRun", () => {
  it("copies a whole run and records where it came from", async () => {
    const run = await writeRun("r1", manifest("r1", [route("/", ["default"], "a")]), "one");
    const dir = path.join(tmp, "baseline");
    expect(await hasBaseline(dir)).toBe(false);

    const result = await approveRun({ runDir: run, baselineDir: dir });
    expect(result).toMatchObject({ runId: "r1", routes: 1, shots: 1, partial: false });
    expect(await hasBaseline(dir)).toBe(true);
    expect(await read(dir, "screenshots/home/default/desktop.png")).toBe("one");
    expect((await readBaselineInfo(dir))?.runId).toBe("r1");
  });

  it("replaces the previous baseline wholesale, leaving nothing stale behind", async () => {
    const dir = path.join(tmp, "baseline");
    const first = await writeRun(
      "r1",
      manifest("r1", [route("/", ["default"], "a"), route("/old", ["default"], "a")]),
      "one",
    );
    await approveRun({ runDir: first, baselineDir: dir });
    const second = await writeRun("r2", manifest("r2", [route("/", ["default"], "b")]), "two");
    await approveRun({ runDir: second, baselineDir: dir });

    expect(await read(dir, "screenshots/home/default/desktop.png")).toBe("two");
    await expect(read(dir, "screenshots/old/default/desktop.png")).rejects.toThrow();
  });

  it("approves some routes and leaves the rest of the baseline as it was", async () => {
    const dir = path.join(tmp, "baseline");
    const first = await writeRun(
      "r1",
      manifest("r1", [
        route("/", ["default"], "a"),
        route("/blog", ["default", "stale"], "a"),
        route("/blog/post", ["default"], "a"),
      ]),
      "one",
    );
    await approveRun({ runDir: first, baselineDir: dir });
    const second = await writeRun(
      "r2",
      manifest("r2", [
        route("/", ["default"], "b"),
        route("/blog", ["default"], "b"),
        route("/blog/post", ["default"], "b"),
      ]),
      "two",
    );
    // Only /blog itself — not the post nested under its folder.
    const result = await approveRun({ runDir: second, baselineDir: dir, routes: ["/blog"] });
    expect(result).toMatchObject({ routes: 1, shots: 1, partial: true });

    expect(await read(dir, "screenshots/home/default/desktop.png")).toBe("one");
    expect(await read(dir, "screenshots/blog/default/desktop.png")).toBe("two");
    // The state the new run no longer has is gone from the baseline too…
    await expect(read(dir, "screenshots/blog/stale/desktop.png")).rejects.toThrow();
    // …and the nested route's shots, which share the folder, are untouched.
    expect(await read(dir, "screenshots/blog/post/default/desktop.png")).toBe("one");

    const saved = JSON.parse(await read(dir, "crawl-map.json")) as Manifest;
    expect(saved.routes.find((r) => r.url === "/blog")?.title).toBe("b");
    expect(saved.routes.find((r) => r.url === "/")?.title).toBe("a");
    expect((await readBaselineInfo(dir))?.routes).toEqual(["/blog"]);
  });

  it("refuses a directory that isn't a run", async () => {
    await expect(
      approveRun({ runDir: path.join(tmp, "nope"), baselineDir: path.join(tmp, "b") }),
    ).rejects.toThrow(/no run manifest/);
  });
});
