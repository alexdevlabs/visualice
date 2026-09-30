import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { exportRun } from "../src/export";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vc-export-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(rel: string, body = "x"): Promise<void> {
  const file = path.join(tmp, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

const exists = (rel: string) =>
  fs.stat(path.join(tmp, rel)).then(
    () => true,
    () => false,
  );

/** An output root with two runs, a baseline, and a comparison of each kind. */
async function scaffold(): Promise<void> {
  await write("viewer/index.html", "<html>viewer</html>");
  await write("viewer/assets/app.js");
  for (const run of ["r1", "r2"]) {
    await write(`out/runs/${run}/viewer-data.json`, "{}");
    await write(`out/runs/${run}/crawl-map.json`, "{}");
    await write(`out/runs/${run}/screenshots/home/default/desktop.png`, run);
    await write(`out/runs/${run}/screenshots/home/default/desktop.mid.webp`, run);
    await write(`out/runs/${run}/screenshots/about/default/desktop.png`, run);
  }
  await write("out/runs/r2/.incomplete", "");
  await write("out/baseline/screenshots/home/default/desktop.png", "base");
  const shot = {
    key: "home|default|desktop",
    route: "home",
    state: "default",
    stateLabel: "Default",
    device: "desktop",
    status: "changed",
    fromShot: "screenshots/home/default/desktop.png",
    toShot: "screenshots/home/default/desktop.png",
    fromPreview: "screenshots/home/default/desktop.mid.webp",
    toPreview: "screenshots/home/default/desktop.mid.webp",
    image: "images/home/default/desktop.png",
  };
  const diff = (from: object) =>
    JSON.stringify({ from, to: { runId: "r2", dir: "" }, shots: [shot], summary: {} });
  await write("out/diffs/r1__r2/diff.json", diff({ runId: "r1", dir: "" }));
  await write("out/diffs/r1__r2/images/home/default/desktop.png");
  await write("out/diffs/baseline__r2/diff.json", diff({ runId: "r0", dir: "", baseline: true }));
  await write("out/diffs/r0__r1/diff.json", diff({ runId: "r0", dir: "" }));
}

const run = (over: Partial<Parameters<typeof exportRun>[0]> = {}) =>
  exportRun({
    runDir: path.join(tmp, "out/runs/r2"),
    runId: "r2",
    viewerDist: path.join(tmp, "viewer"),
    outRoot: path.join(tmp, "out"),
    baselineDir: path.join(tmp, "out/baseline"),
    dest: path.join(tmp, "site"),
    ...over,
  });

describe("exportRun", () => {
  it("writes the viewer, the run and the comparisons made against it", async () => {
    await scaffold();
    const result = await run();
    expect(result.diffs.sort()).toEqual(["baseline__r2", "r1__r2"]);

    expect(await exists("site/index.html")).toBe(true);
    expect(await exists("site/assets/app.js")).toBe(true);
    expect(await exists("site/data/viewer-data.json")).toBe(true);
    expect(await exists("site/data/screenshots/about/default/desktop.png")).toBe(true);
    expect(await exists("site/data/.incomplete")).toBe(false);

    const runs = JSON.parse(await fs.readFile(path.join(tmp, "site/runs.json"), "utf8"));
    expect(runs).toEqual({ current: "r2", runs: ["r2"] });
    const diffs = JSON.parse(await fs.readFile(path.join(tmp, "site/diffs.json"), "utf8"));
    expect(diffs.diffs.map((d: { id: string }) => d.id).sort()).toEqual(["baseline__r2", "r1__r2"]);
    expect(await exists("site/diffs/r1__r2/images/home/default/desktop.png")).toBe(true);
  });

  it("copies only the shots a comparison shows, from wherever each side lives", async () => {
    await scaffold();
    await run();
    expect(await exists("site/runs/r1/screenshots/home/default/desktop.png")).toBe(true);
    expect(await exists("site/runs/r1/screenshots/home/default/desktop.mid.webp")).toBe(true);
    expect(await exists("site/runs/r2/screenshots/home/default/desktop.png")).toBe(true);
    // Not in any comparison, so not duplicated outside data/.
    expect(await exists("site/runs/r1/screenshots/about/default/desktop.png")).toBe(false);
    expect(
      await fs.readFile(
        path.join(tmp, "site/baseline/screenshots/home/default/desktop.png"),
        "utf8",
      ),
    ).toBe("base");
  });

  it("takes an explicit list of comparisons, including none", async () => {
    await scaffold();
    expect((await run({ diffs: [] })).diffs).toEqual([]);
    expect(await exists("site/diffs")).toBe(false);
    expect((await run({ diffs: ["r1__r2"] })).diffs).toEqual(["r1__r2"]);
    await expect(run({ diffs: ["nope"] })).rejects.toThrow(/no such comparison: nope/);
  });

  it("overwrites its own previous export but never someone else's directory", async () => {
    await scaffold();
    await run();
    await write("site/stale.txt");
    await run();
    expect(await exists("site/stale.txt")).toBe(false);

    await write("precious/notes.txt");
    await expect(run({ dest: path.join(tmp, "precious") })).rejects.toThrow(/not empty/);
    expect(await exists("precious/notes.txt")).toBe(true);
    await expect(run({ dest: path.join(tmp, "out/runs/r2/export") })).rejects.toThrow(/own source/);
  });
});
