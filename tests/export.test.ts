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

/** An output root with two runs. */
async function scaffold(): Promise<void> {
  await write("viewer/index.html", "<html>viewer</html>");
  await write("viewer/assets/app.js");
  for (const run of ["r1", "r2"]) {
    await write(`out/runs/${run}/viewer-data.json`, "{}");
    await write(`out/runs/${run}/crawl-map.json`, "{}");
    await write(`out/runs/${run}/screenshots/home/default/desktop.png`, run);
  }
  await write("out/runs/r2/.incomplete", "");
}

const run = (over: Partial<Parameters<typeof exportRun>[0]> = {}) =>
  exportRun({
    runDir: path.join(tmp, "out/runs/r2"),
    runId: "r2",
    site: "example.com",
    viewerDist: path.join(tmp, "viewer"),
    dest: path.join(tmp, "site"),
    ...over,
  });

describe("exportRun", () => {
  it("writes the viewer and the run", async () => {
    await scaffold();
    const result = await run();
    expect(result.runId).toBe("r2");

    expect(await exists("site/index.html")).toBe(true);
    expect(await exists("site/assets/app.js")).toBe(true);
    expect(await exists("site/data/viewer-data.json")).toBe(true);
    expect(await exists("site/data/screenshots/home/default/desktop.png")).toBe(true);
    expect(await exists("site/data/.incomplete")).toBe(false);

    const sites = JSON.parse(await fs.readFile(path.join(tmp, "site/sites.json"), "utf8"));
    expect(sites).toEqual({
      current: { site: "example.com", run: "r2" },
      sites: [{ key: "example.com", latest: "r2", runs: ["r2"] }],
    });
    // Only the exported run, not its siblings.
    expect(await exists("site/runs")).toBe(false);
  });

  it("leaves out a run the viewer build carries in its own data/", async () => {
    await scaffold();
    // What a build of the viewer with dev data in viewer/public/ used to contain.
    await write("viewer/data/viewer-data.json", "other");
    await write("viewer/data/screenshots/rentals/default/desktop.png", "other");
    await run();
    expect(await fs.readFile(path.join(tmp, "site/data/viewer-data.json"), "utf8")).toBe("{}");
    expect(await exists("site/data/screenshots/rentals")).toBe(false);
    expect(await exists("site/data/screenshots/home/default/desktop.png")).toBe(true);
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
