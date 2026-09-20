import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serveDirectory } from "../../src/shared/static-server";
import { FIXTURE_DIR, tempDir } from "./helpers";

const exec = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..", "..");
const BIN = path.join(REPO, "bin", "visualice.mjs");

/**
 * The distribution contract: the `bin` entry runs from *any* working directory and
 * writes its output into that directory, not into the install. A regression here is
 * what makes visualice "only works from its own repo" — exactly what the bin exists
 * to avoid, and invisible to every other test (they all call the pipelines directly).
 */
describe("visualice bin", () => {
  const run = (args: string[], cwd: string) =>
    exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });

  it("prints its version from an unrelated cwd", async () => {
    const dir = await tempDir("bin");
    try {
      const { stdout } = await run(["--version"], dir);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports readiness as JSON", async () => {
    const dir = await tempDir("bin");
    try {
      const { stdout } = await run(["doctor", "--json", "--quiet"], dir);
      const result = JSON.parse(stdout) as {
        ok: boolean;
        checks: { name: string; ok: boolean }[];
      };
      expect(result.ok).toBe(true);
      expect(result.checks.map((c) => c.name)).toEqual(["node", "chromium", "sharp", "viewer"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds the project files into the cwd", async () => {
    const dir = await tempDir("bin");
    try {
      await run(["init", "https://example.com", "--quiet"], dir);
      const config = JSON.parse(await fs.readFile(path.join(dir, "visualice.config.json"), "utf8"));
      expect(config.target).toBe("https://example.com");
      expect(await fs.readFile(path.join(dir, ".gitignore"), "utf8")).toContain(".visualice/");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("crawls into the cwd, not into the install", async () => {
    const dir = await tempDir("bin");
    const server = await serveDirectory(FIXTURE_DIR);
    try {
      const { stdout } = await run(
        ["crawl", server.url, "--max-pages=1", "--devices=desktop", "--json", "--quiet"],
        dir,
      );
      const summary = JSON.parse(stdout) as { runDir: string; shots: number };
      expect(summary.shots).toBeGreaterThan(0);
      // The run landed under the temp project…
      expect(summary.runDir.startsWith(await fs.realpath(dir))).toBe(true);
      expect(await fs.readdir(path.join(dir, ".visualice", "runs"))).toContain("latest");
      // …and the routes file was generated there too.
      expect(await fs.readFile(path.join(dir, "visualice.routes.md"), "utf8")).toContain("- /");
      // Nothing was written into the install.
      expect(
        await fs
          .access(path.join(REPO, ".visualice", "runs", path.basename(summary.runDir)))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
