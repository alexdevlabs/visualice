import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRunId } from "../src/crawl/orchestrator";
import {
  findResumableRun,
  latestRunId,
  listRuns,
  markRunComplete,
  markRunIncomplete,
  previousRunId,
  runDir,
  runIdTime,
  runsToPrune,
  sortRunIds,
} from "../src/crawl/runs";

describe("run ids", () => {
  it("round-trips makeRunId back to its timestamp", () => {
    const date = new Date("2026-09-20T17:24:05.683Z");
    const id = makeRunId(date);
    expect(id).toBe("2026-09-20T17-24-05-683Z");
    expect(runIdTime(id)).toBe(date.getTime());
  });

  it("rejects names that aren't run ids", () => {
    expect(runIdTime("latest")).toBeUndefined();
    expect(runIdTime("baseline")).toBeUndefined();
    expect(runIdTime("2026-09-20")).toBeUndefined();
  });

  it("orders runs chronologically", () => {
    const ids = [
      makeRunId(new Date("2026-09-20T17:24:05.683Z")),
      makeRunId(new Date("2026-01-02T03:04:05.006Z")),
      makeRunId(new Date("2026-09-20T17:24:05.007Z")),
    ];
    expect(sortRunIds(ids)).toEqual([
      "2026-01-02T03-04-05-006Z",
      "2026-09-20T17-24-05-007Z",
      "2026-09-20T17-24-05-683Z",
    ]);
  });

  it("keeps unparseable names last so pruning never eats them first", () => {
    const sorted = sortRunIds([
      "baseline",
      makeRunId(new Date("2026-01-02T03:04:05.006Z")),
      "keep",
    ]);
    expect(sorted).toEqual(["2026-01-02T03-04-05-006Z", "baseline", "keep"]);
  });
});

describe("run directories", () => {
  let out: string;

  const ID_1 = "2026-01-01T00-00-00-000Z";
  const ID_2 = "2026-02-02T00-00-00-000Z";
  const ID_3 = "2026-03-03T00-00-00-000Z";

  /** A run directory on disk, as a finished crawl would leave it. */
  async function makeRun(id: string): Promise<string> {
    const dir = runDir(out, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "crawl-map.json"), "{}");
    return dir;
  }

  const linkLatest = (id: string) => fs.symlink(id, path.join(out, "runs", "latest"), "dir");

  beforeEach(async () => {
    out = await fs.mkdtemp(path.join(os.tmpdir(), "vc-runs-"));
  });
  afterEach(async () => {
    await fs.rm(out, { recursive: true, force: true });
  });

  describe("listRuns", () => {
    it("lists run directories oldest → newest", async () => {
      for (const id of [ID_3, ID_1, ID_2]) await makeRun(id);
      expect(await listRuns(out)).toEqual([ID_1, ID_2, ID_3]);
    });

    it("leaves out the `latest` symlink and any loose files", async () => {
      await makeRun(ID_1);
      await linkLatest(ID_1);
      await fs.writeFile(path.join(out, "runs", "notes.md"), "hi");
      expect(await listRuns(out)).toEqual([ID_1]);
    });

    it("returns nothing when the output directory has never been crawled into", async () => {
      expect(await listRuns(out)).toEqual([]);
      expect(await listRuns(path.join(out, "does-not-exist"))).toEqual([]);
    });
  });

  describe("latestRunId", () => {
    it("resolves the `latest` symlink to the run it points at", async () => {
      await makeRun(ID_1);
      await makeRun(ID_2);
      await linkLatest(ID_1); // deliberately not the newest
      expect(await latestRunId(out)).toBe(ID_1);
    });

    it("falls back to the newest run when there is no symlink to read", async () => {
      // A copied tree, or Windows without developer mode: `latest` is a real directory.
      await makeRun(ID_1);
      await makeRun(ID_2);
      await fs.mkdir(path.join(out, "runs", "latest"), { recursive: true });
      expect(await latestRunId(out)).toBe(ID_2);
    });

    it("has no answer before the first run", async () => {
      expect(await latestRunId(out)).toBeUndefined();
    });
  });

  describe("resume markers", () => {
    it("marks a run incomplete while it is being written, and clears it when done", async () => {
      const dir = await makeRun(ID_1);
      const marker = path.join(dir, ".incomplete");

      await markRunIncomplete(dir);
      expect(await fs.readFile(marker, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      await markRunComplete(dir);
      await expect(fs.stat(marker)).rejects.toThrow();
    });

    it("completing a run that was never marked is a no-op, not an error", async () => {
      const dir = await makeRun(ID_1);
      await expect(markRunComplete(dir)).resolves.toBeUndefined();
    });

    it("picks the newest unfinished run to resume", async () => {
      await markRunIncomplete(await makeRun(ID_1));
      await makeRun(ID_2); // finished
      await markRunIncomplete(await makeRun(ID_3));
      expect(await findResumableRun(out)).toBe(ID_3);
    });

    it("has nothing to resume once every run finished", async () => {
      await makeRun(ID_1);
      await makeRun(ID_2);
      expect(await findResumableRun(out)).toBeUndefined();
    });

    it("has nothing to resume when no run exists at all", async () => {
      expect(await findResumableRun(out)).toBeUndefined();
    });
  });
});

describe("previousRunId", () => {
  const [a, b, c] = [
    "2026-01-01T00-00-00-000Z",
    "2026-01-02T00-00-00-000Z",
    "2026-01-03T00-00-00-000Z",
  ];

  it("is the run just before the newest one by default", () => {
    expect(previousRunId([a, b, c], c)).toBe(b);
  });

  it("picks an older baseline for an older --to, never a newer one", () => {
    // The regression: "newest run that isn't --to" picked c here, which compared the
    // newest run against yesterday's and reported every change backwards.
    expect(previousRunId([a, b, c], b)).toBe(a);
  });

  it("has nothing to offer for the oldest run", () => {
    expect(previousRunId([a, b, c], a)).toBeUndefined();
    expect(previousRunId([a], a)).toBeUndefined();
  });

  it("places a run passed by path where its id sorts", () => {
    expect(previousRunId([a, c], b)).toBe(a);
    // A hand-named directory sorts after every generated id, so the newest is its baseline.
    expect(previousRunId([a, b], "baseline-copy")).toBe(b);
  });
});

describe("runsToPrune", () => {
  const ids = ["r1", "r2", "r3", "r4", "r5"].map((_, i) => `2026-01-0${i + 1}T00-00-00-000Z`);

  it("keeps the newest `keep` when the current run is the newest", () => {
    expect(runsToPrune(ids, 3, ids[4])).toEqual(ids.slice(0, 2));
  });

  it("counts an older current run against the budget instead of on top of it", () => {
    // The regression: the old window deleted only ids[1] here and kept four runs.
    const kept = ids.filter((id) => !runsToPrune(ids, 3, ids[0]).includes(id));
    expect(kept).toEqual([ids[0], ids[3], ids[4]]);
  });

  it("never deletes the current run, even at keep=1", () => {
    expect(runsToPrune(ids, 1, ids[0])).toEqual(ids.slice(1));
  });

  it("deletes nothing while under budget", () => {
    expect(runsToPrune(ids, 5, ids[4])).toEqual([]);
    expect(runsToPrune(ids, 9, ids[0])).toEqual([]);
  });

  it("spends no slot on a current run that isn't in the list", () => {
    expect(runsToPrune(ids, 3, "hand-named")).toEqual(ids.slice(0, 2));
    expect(runsToPrune(ids, 3)).toEqual(ids.slice(0, 2));
  });
});
