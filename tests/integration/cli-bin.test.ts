import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serveDirectory } from "../../src/shared/static-server";
import { FIXTURE_DIR, serveFiles, tempDir } from "./helpers";

const exec = promisify(execFile);

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/**
 * A home page with one state to find (a search dialog) and a page nothing links
 * to, which only a seed reaches.
 */
const SITE = {
  "index.html": html(
    "Home",
    `<h1>Home</h1>
     <button id="open" aria-haspopup="dialog" aria-controls="search">Search</button>
     <dialog id="search"><p>Search the shop</p><button id="close">Close</button></dialog>
     <script>
       document.getElementById('open').addEventListener('click', () =>
         document.getElementById('search').showModal());
       document.getElementById('close').addEventListener('click', () =>
         document.getElementById('search').close());
     </script>`,
  ),
  "orphan.html": html("Orphan", "<h1>Not linked from anywhere</h1>"),
};

interface Plan {
  dryRun: boolean;
  routes: { url: string; states: string[] }[];
  states: number;
  shots: number;
  devices: string[];
}
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
      const runs = path.join(dir, ".visualice", "sites", "localhost", "runs");
      expect(await fs.readdir(runs)).toContain("latest");
      // …and the routes file was generated there too.
      expect(await fs.readFile(path.join(dir, "visualice.routes.md"), "utf8")).toContain("- /");
      // Nothing was written into the install.
      expect(
        await fs
          .access(
            path.join(
              REPO,
              ".visualice",
              "sites",
              "localhost",
              "runs",
              path.basename(summary.runDir),
            ),
          )
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("--dry-run lists what a crawl would capture, and captures nothing", async () => {
    const dir = await tempDir("bin");
    const { server, dir: siteDir } = await serveFiles(SITE);
    try {
      const { stdout } = await run(
        ["crawl", server.url, "--dry-run", "--seed=/orphan", "--json", "--quiet"],
        dir,
      );
      const plan = JSON.parse(stdout) as Plan;
      expect(plan.dryRun).toBe(true);
      expect(plan.routes.map((r) => r.url).sort()).toEqual(["/", "/orphan"]);
      const home = plan.routes.find((r) => r.url === "/")!;
      expect(home.states.length).toBeGreaterThan(1);
      // Each state on both default devices.
      expect(plan.devices).toEqual(["desktop", "mobile"]);
      expect(plan.shots).toBe(plan.states * 2);
      // Discovery ran and was cached, but no run was made and no config written.
      expect(await exists(path.join(dir, ".visualice", "crawl-map.cache.json"))).toBe(true);
      expect(await exists(path.join(dir, ".visualice", "sites"))).toBe(false);
      expect(await exists(path.join(dir, "visualice.config.json"))).toBe(false);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("--no-states captures pages only, into the --site folder, and keeps cached states", async () => {
    const dir = await tempDir("bin");
    const { server, dir: siteDir } = await serveFiles(SITE);
    const common = ["--seed=/orphan", "--devices=desktop", "--json", "--quiet"];
    try {
      // A full discovery first, so the cache holds the dialog state.
      await run(["discover", server.url, "--seed=/orphan", "--json", "--quiet"], dir);
      const cache = path.join(dir, ".visualice", "crawl-map.cache.json");
      const statesIn = async () => {
        const model = JSON.parse(await fs.readFile(cache, "utf8")) as {
          routes: { url: string; states: { id: string }[] }[];
        };
        return model.routes.find((r) => r.url === "/")!.states.length;
      };
      const found = await statesIn();
      expect(found).toBeGreaterThan(1);

      const { stdout } = await run(
        ["crawl", server.url, "--no-states", "--site=staging", ...common],
        dir,
      );
      const summary = JSON.parse(stdout) as {
        runDir: string;
        routes: number;
        states: number;
        shots: number;
      };
      expect(summary.routes).toBe(2);
      expect(summary.states).toBe(2);
      expect(summary.shots).toBe(2);
      expect(summary.runDir).toContain(path.join(".visualice", "sites", "staging", "runs"));
      // The pages-only pass looked for no states, so it didn't drop the ones cached.
      expect(await statesIn()).toBe(found);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("still takes the renamed flags, warning about each", async () => {
    const dir = await tempDir("bin");
    const { server, dir: siteDir } = await serveFiles(SITE);
    try {
      const { stdout, stderr } = await run(
        [
          "crawl",
          `--base=${server.url}`,
          "--out=out",
          "--timeout=20000",
          "--no-states",
          "--devices=desktop",
          "--json",
          "--quiet",
        ],
        dir,
      );
      expect(stderr).toContain("--base is deprecated — use --target");
      expect(stderr).toContain("--out is deprecated — use --dir");
      expect(stderr).toContain("--timeout is deprecated — use --timeout-ms");
      const summary = JSON.parse(stdout) as { runDir: string };
      expect(summary.runDir).toContain(path.join("out", "sites", "localhost", "runs"));

      // The viewer's own screenshot, under its new name and its old one.
      const shot = path.join(dir, "viewer.png");
      await run(["serve", "--dir=out", `--screenshot=${shot}`, "--quiet"], dir);
      expect((await fs.stat(shot)).size).toBeGreaterThan(10_000);
      const old = path.join(dir, "viewer-old.png");
      const legacy = await run(["serve", "--dir=out", `--shoot=${old}`, "--quiet"], dir);
      expect(legacy.stderr).toContain("--shoot is deprecated — use --screenshot");
      expect(await exists(old)).toBe(true);
    } finally {
      await server.close();
      await fs.rm(siteDir, { recursive: true, force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("rejects an unknown flag with exit code 2", async () => {
    const dir = await tempDir("bin");
    try {
      const err = (await run(["crawl", "--dryrun"], dir).catch((e: unknown) => e)) as {
        code: number;
        stderr: string;
      };
      expect(err.code).toBe(2);
      expect(err.stderr).toContain("unknown flag --dryrun for 'crawl'");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

const exists = (p: string) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);
