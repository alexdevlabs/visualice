import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serveDirectory } from "../../src/shared/static-server";
import type { StaticServer } from "../../src/shared/file-serve";
import type { ChangesReport } from "../../src/crawl/changes";
import type { Manifest } from "../../src/shared/types";
import { FIXTURE_DIR, tempDir } from "./helpers";

const exec = promisify(execFile);

const REPO = path.resolve(import.meta.dirname, "..", "..");
const BIN = path.join(REPO, "cli", "visualice.mjs");

/**
 * The update loop end to end, through the real CLI in a real git repository, the
 * way a project uses it: a full crawl records the commit it shot; `changes` reads
 * that record back out of the routes file and diffs against it; the partial crawl
 * it suggests shoots the changed pages and carries the rest; and a change that
 * reaches every page asks for a full run. The unit tests cover each piece; this
 * covers the hand-offs between them (routes-file line, run manifests, the CLI).
 */

let site: string;
let server: StaticServer;

const env = { ...process.env, NO_COLOR: "1", VISUALICE_NO_UPDATE_CHECK: "1" };

const git = async (...args: string[]) =>
  (await exec("git", args, { cwd: site, env })).stdout.trim();

const visualice = async (...args: string[]) =>
  (await exec(process.execPath, [BIN, ...args], { cwd: site, env, maxBuffer: 1 << 26 })).stdout;

const changes = async (): Promise<ChangesReport> =>
  JSON.parse(await visualice("changes", "--json", "--quiet")) as ChangesReport;

const commit = async (message: string) => {
  await git("add", "-A");
  await git("commit", "-q", "-m", message);
};

const sourceLine = async () =>
  /visualice-source commit=([0-9a-f]+)/.exec(
    await fs.readFile(path.join(site, "visualice.routes.md"), "utf8"),
  )?.[1];

beforeAll(async () => {
  site = await tempDir("update-flow");
  await fs.cp(FIXTURE_DIR, site, { recursive: true });
  await fs.rm(path.join(site, "crawl-map.input.json"), { force: true });
  await fs.writeFile(path.join(site, ".gitignore"), ".visualice/\n");
  // Small and quick: one device, few interactions. The site is the repository.
  await fs.writeFile(
    path.join(site, "visualice.config.json"),
    JSON.stringify(
      {
        scope: { maxPages: 6, maxDepth: 1 },
        devices: [{ name: "small", width: 420, height: 640, dpr: 1 }],
        discovery: { interactions: { maxPerPage: 1 }, mobileStates: false },
        stabilize: { extraDelayMs: 50 },
        politeness: { minDelayMs: 0, concurrency: 4 },
      },
      null,
      2,
    ),
  );
  await git("init", "-q");
  // A Windows runner converts line endings by default, which would make every
  // checked-out file look modified.
  await git("config", "core.autocrlf", "false");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await commit("site");
  server = await serveDirectory(site);
}, 60000);

afterAll(async () => {
  await server?.close();
  if (site) await fs.rm(site, { recursive: true, force: true });
});

describe("updating a catalogue after code changes", () => {
  it("records, diffs, reruns only what changed, and asks for everything when it should", async () => {
    // 1. A full crawl records the commit it shot in the routes file.
    const first = JSON.parse(await visualice("crawl", server.url, "--json", "--quiet"));
    expect(first.shots).toBeGreaterThan(0);
    expect(first.failed).toBe(0);
    expect(await sourceLine()).toBe(await git("rev-parse", "HEAD"));
    const firstManifest = JSON.parse(await fs.readFile(first.manifest, "utf8")) as Manifest;
    const pages = firstManifest.routes.map((r) => r.url);
    expect(pages).toContain("/about");

    // 2. Committing the catalogue changes nothing that counts.
    await commit("catalogue");
    expect((await changes()).verdict).toBe("none");

    // 3. One page edited, one added: partial, with exactly those pages.
    const about = path.join(site, "about.html");
    const before = await fs.readFile(about, "utf8");
    const edited = before.replace("</body>", "<p>We now roast on Sundays too.</p></body>");
    expect(edited).not.toBe(before);
    await fs.writeFile(about, edited);
    await fs.writeFile(
      path.join(site, "pricing.html"),
      "<!doctype html><html><head><title>Pricing</title></head><body><h1>Pricing</h1></body></html>",
    );
    await commit("about + pricing");
    const partial = await changes();
    expect(partial.verdict).toBe("partial");
    expect(partial.global).toEqual([]);
    expect(partial.candidates.map((c) => c.file).sort()).toEqual(["about.html", "pricing.html"]);
    expect(partial.suggest?.only?.sort()).toEqual(["/about", "/pricing"]);
    expect(partial.suggest?.command).toBe("visualice crawl --replay --only=/about,/pricing");

    // 4. The suggested run shoots those two pages and carries every other one.
    const part = JSON.parse(
      await visualice(
        "crawl",
        server.url,
        "--replay",
        `--only=${partial.suggest!.only!.join(",")}`,
        "--json",
        "--quiet",
      ),
    );
    expect(part.failed).toBe(0);
    expect(part.carried).toBeGreaterThan(0);
    const m = JSON.parse(await fs.readFile(part.manifest, "utf8")) as Manifest;
    expect(m.partial?.carriedFrom).toBe(first.runId);
    const urls = m.routes.map((r) => r.url);
    expect(urls).toEqual(expect.arrayContaining([...pages, "/pricing"]));
    for (const route of m.routes) {
      const shots = route.states.flatMap((s) => Object.values(s.shots));
      const fresh = route.url === "/about" || route.url === "/pricing";
      for (const ref of shots) {
        if (fresh) expect(ref.carried).toBeUndefined();
        else expect(ref.carried?.runId).toBe(first.runId);
      }
    }
    expect(await sourceLine()).toBe(await git("rev-parse", "HEAD"));

    // 5. With the new catalogue committed, it's up to date again.
    await commit("catalogue after partial");
    const after = await changes();
    expect(after.verdict).toBe("none");

    // 6. A change every page sees asks for a full run.
    await fs.appendFile(path.join(site, "assets", "tailwind.css"), "\nbody{color:red}\n");
    const full = await changes();
    expect(full.verdict).toBe("full");
    expect(full.global.map((g) => g.path)).toContain("assets/tailwind.css");
    expect(full.suggest?.command).toBe("visualice crawl");
  }, 240000);
});
