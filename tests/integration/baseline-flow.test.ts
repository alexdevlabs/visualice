import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serveFiles, tempDir } from "./helpers";

const exec = promisify(execFile);
const BIN = path.resolve(import.meta.dirname, "..", "..", "bin", "visualice.mjs");

/**
 * The CI gate, end to end through the real CLI: approve a run, change the site,
 * and have `diff --fail-on-error` fail against the baseline until the change is
 * either ignored by a rule or approved. Run-vs-run diffing can't do this — after an
 * intended change, the run before it is never the right thing to compare against.
 */

const page = (boxColor: string, clock: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Site</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:24px}
.box{width:200px;height:120px;background:${boxColor}}
.clock{position:absolute;left:300px;top:200px;width:80px;height:40px;background:${clock}}</style>
</head><body><h1>Home</h1><div class="box"></div><div class="clock"></div></body></html>`;

const CONFIG = {
  routesFile: false,
  devices: [{ name: "small", width: 400, height: 300, dpr: 2 }],
  discovery: { interactions: { auto: false }, useSitemap: false },
  stabilize: { waitStrategy: "load", extraDelayMs: 25 },
  politeness: { minDelayMs: 0 },
};

describe("baseline workflow", () => {
  it("gates on the approved baseline, honours ignore rules, and exports the result", async () => {
    const { server, dir: siteDir } = await serveFiles({ "index.html": page("#2b6", "#111") });
    const project = await tempDir("baseline");
    const writeConfig = (extra: object = {}) =>
      fs.writeFile(
        path.join(project, "visualice.config.json"),
        JSON.stringify({ ...CONFIG, target: server.url, ...extra }),
      );
    /** Run the CLI; resolves with stdout and the exit code rather than throwing on 3. */
    const run = async (args: string[]) => {
      try {
        const { stdout } = await exec(process.execPath, [BIN, ...args, "--quiet"], {
          cwd: project,
        });
        return { code: 0, out: stdout };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        if (typeof err.code !== "number") throw e;
        return { code: err.code, out: err.stdout ?? "", err: err.stderr };
      }
    };
    const json = async (args: string[]) => {
      const r = await run([...args, "--json"]);
      return { code: r.code, data: JSON.parse(r.out) as Record<string, unknown> };
    };

    try {
      await writeConfig();
      const first = await json(["crawl"]);
      expect(first.data.shots).toBe(1);

      // With one run and no baseline there is nothing to compare against.
      expect((await run(["diff"])).code).toBe(2);

      const approved = await json(["approve"]);
      expect(approved.data).toMatchObject({ routes: 1, shots: 1, partial: false });
      // Inside the project's output directory, beside runs/ rather than under it.
      expect(
        path.relative(
          await fs.realpath(project),
          await fs.realpath(approved.data.baselineDir as string),
        ),
      ).toBe(path.join(".visualice", "baseline"));

      // The run it was approved from diffs clean against it.
      const clean = await json(["diff", "--fail-on-error"]);
      expect(clean.code).toBe(0);
      expect(clean.data).toMatchObject({ from: "baseline", baseline: true, changed: 0 });

      // Only the "clock" moves: noise, not a regression.
      await fs.writeFile(path.join(siteDir, "index.html"), page("#2b6", "#e0e"));
      await json(["crawl"]);
      const noisy = await json(["diff", "--fail-on-error"]);
      expect(noisy.code).toBe(3);
      expect(noisy.data).toMatchObject({ baseline: true, changed: 1 });

      // An ignore region over it (CSS px, on a dpr-2 device) — no re-crawl.
      await writeConfig({
        diff: { rules: [{ route: "/", ignore: [{ x: 290, y: 190, width: 100, height: 60 }] }] },
      });
      const ignored = await json(["diff", "--fail-on-error"]);
      expect(ignored.code).toBe(0);
      expect(ignored.data.changed).toBe(0);
      // The stale diff image from the noisy comparison is gone with the verdict.
      const diffDir = ignored.data.outDir as string;
      expect(await fs.readdir(diffDir)).not.toContain("images");

      // A real change is still caught with the rule in place…
      await fs.writeFile(path.join(siteDir, "index.html"), page("#d33", "#0aa"));
      await json(["crawl"]);
      const real = await json(["diff", "--fail-on-error"]);
      expect(real.code).toBe(3);
      expect(real.data.changed).toBe(1);
      const summary = await fs.readFile(real.data.summaryFile as string, "utf8");
      expect(summary).toContain("Visual diff: 1 difference");
      expect(summary).toContain("the approved baseline");
      const written = JSON.parse(
        await fs.readFile(path.join(real.data.outDir as string, "diff.json"), "utf8"),
      );
      const shot = written.shots[0];
      expect(shot.ignoredPixels).toBe(200 * 120);
      expect(
        (await fs.stat(path.join(real.data.outDir as string, shot.imageThumb))).size,
      ).toBeGreaterThan(0);

      // …and the comparison the previous run would have given is still available.
      const previous = await json(["diff", "--from=previous"]);
      expect(previous.data.baseline).toBe(false);

      // Exported while the change is still unapproved: what a reviewer would be sent.
      const site = path.join(project, "site");
      const exported = await json(["export", "site"]);
      expect(exported.data.diffs).toContain(`baseline__${real.data.to as string}`);
      expect(JSON.parse(await fs.readFile(path.join(site, "runs.json"), "utf8")).current).toBe(
        real.data.to,
      );
      await fs.access(path.join(site, "index.html"));
      await fs.access(path.join(site, "data", "viewer-data.json"));
      await fs.access(path.join(site, "baseline", shot.fromShot));
      await fs.access(path.join(site, "runs", real.data.to as string, shot.toShot));

      // Approving it makes it the new normal.
      await json(["approve"]);
      const after = await json(["diff", "--fail-on-error"]);
      expect(after.code).toBe(0);
      expect(after.data.changed).toBe(0);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(project, { recursive: true, force: true });
    }
  }, 240_000);
});
