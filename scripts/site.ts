/**
 * The docs site and its live demo, as GitHub Pages serves them.
 *
 *   npm run site           build everything, then serve it at http://localhost:4173/visualice/
 *   npm run site:dev       the docs only, with hot reload (the demo isn't built in dev)
 *   npm run site:build     build into site/.vitepress/dist (what .github/workflows/pages.yml deploys)
 *   npm run site:preview   serve an existing build
 *
 * The demo is visualice's own catalogue of the bundled "Third Pour" fixture blog
 * (tests/fixture): crawled with the CLI, exported with `visualice export` to /demo/,
 * and the blog itself copied to /demo-site/ so the viewer's "Live page" links lead
 * somewhere real.
 */
import path from "node:path";
import { promises as fs, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serveDirectory } from "../src/shared/static-server";
import { nodeBinCommand } from "../src/shared/node-bin";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const DIST = path.join(SITE, ".vitepress", "dist");
const PUBLIC = path.join(SITE, "public");
const WORK = path.join(SITE, ".vitepress", ".demo");
const FIXTURE = path.join(ROOT, "tests", "fixture");

/** Where Pages serves the site. Must match `base` in site/.vitepress/config.mts. */
const BASE = "/visualice/";
const ORIGIN = "https://alexdevlabs.github.io";
const DEMO_SITE = "third-pour";

function run(pkg: string, args: string[], cwd = ROOT): Promise<void> {
  const cmd = nodeBinCommand(pkg, args, ROOT);
  if (!cmd) throw new Error(`${pkg} isn't installed: run npm install`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd[1], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${pkg} ${args[0]} exited with ${code}`)),
    );
  });
}

/** The visualice CLI, from source. */
const visualice = (args: string[], cwd: string) =>
  run("tsx", [path.join(ROOT, "src", "cli.ts"), ...args], cwd);

/** Images the pages use, from the repo's assets (site/public/ is gitignored). */
async function prepare(): Promise<void> {
  await fs.mkdir(PUBLIC, { recursive: true });
  const copies: [string, string][] = [
    ["assets/logo/visualice-app-icon.svg", "mark.svg"],
    ["assets/logo/visualice-favicon.svg", "favicon.svg"],
    ["assets/viewer.webp", "viewer.webp"],
    ["assets/viewer-zoom.webp", "viewer-zoom.webp"],
    ["assets/og.png", "og.png"],
  ];
  for (const [from, to] of copies) await fs.copyFile(path.join(ROOT, from), path.join(PUBLIC, to));
}

/** Point the fixture's root-absolute URLs (`href="/about"`) at where it's hosted. */
function rebase(html: string, base: string): string {
  return html
    .replace(/(href|src)="\/(?!\/)/g, `$1="${base}`)
    .replace(/location\.href = '\//g, `location.href = '${base}`);
}

async function copyFixture(dest: string, base: string): Promise<void> {
  const files = await fs.readdir(FIXTURE, { recursive: true, withFileTypes: true });
  for (const f of files) {
    if (!f.isFile() || f.name === "crawl-map.input.json") continue;
    const from = path.join(f.parentPath, f.name);
    const to = path.join(dest, path.relative(FIXTURE, from));
    await fs.mkdir(path.dirname(to), { recursive: true });
    if (!f.name.endsWith(".html")) {
      await fs.copyFile(from, to);
      continue;
    }
    const html = rebase(await fs.readFile(from, "utf8"), base);
    await fs.writeFile(to, html);
    // `articles.html` beside an `articles/` folder: Pages may answer /articles by
    // redirecting into the folder, so the page is its index.html too.
    const folder = from.slice(0, -".html".length);
    if (existsSync(folder)) {
      const index = path.join(to.slice(0, -".html".length), "index.html");
      await fs.mkdir(path.dirname(index), { recursive: true });
      await fs.writeFile(index, html);
    }
  }
}

async function buildDemo(): Promise<void> {
  // Always fresh, as in CI: an old build on disk would put a stale viewer in the demo.
  await run("vite", ["build", "viewer"]);
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });

  // Crawl the fixture at the root of a local server, so routes read /about, not
  // /visualice/demo-site/about.
  const server = await serveDirectory(FIXTURE);
  try {
    console.log(`\n› crawling the demo site (${server.url})…`);
    await visualice(
      ["crawl", server.url, "--dir=out", `--site=${DEMO_SITE}`, "--no-save", "--quiet"],
      WORK,
    );
  } finally {
    await server.close();
  }

  const demo = path.join(DIST, "demo");
  await visualice(["export", demo, "--dir=out", `--site=${DEMO_SITE}`, "--quiet"], WORK);

  // "Live page" goes to the hosted copy of the blog, not the local server it was
  // crawled from: liveBase is where the viewer resolves routes when it's set.
  const dataFile = path.join(demo, "data", "viewer-data.json");
  const data = JSON.parse(await fs.readFile(dataFile, "utf8")) as {
    site: { origin: string; liveBase?: string };
    tiles: unknown[];
  };
  const hosted = `${BASE}demo-site`;
  data.site.liveBase = `${ORIGIN}${hosted}`;
  data.site.origin = `${ORIGIN}${hosted}`;
  await fs.writeFile(dataFile, JSON.stringify(data));

  await copyFixture(path.join(DIST, "demo-site"), `${hosted}/`);
  console.log(`✓ demo: ${data.tiles.length} shots → ${path.relative(ROOT, demo)}`);
}

async function build(): Promise<void> {
  await prepare();
  await run("vitepress", ["build", "site"]);
  await buildDemo();
}

/** Serve the build under BASE, with Pages' rules: `/x` → `x.html`, `/x/` → `x/index.html`. */
async function preview(port: number): Promise<void> {
  if (!existsSync(path.join(DIST, "index.html"))) {
    throw new Error("nothing built yet: run npm run site:build");
  }
  const server = await serveDirectory(DIST, { port, base: BASE, notFound: "404.html" });
  console.log(`\n  docs  ${server.url}${BASE}\n  demo  ${server.url}${BASE}demo/\n`);
  console.log("press Ctrl-C to stop.");
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  await server.close();
}

const [command = "all", ...rest] = process.argv.slice(2);
const port = Number(rest.find((a) => a.startsWith("--port="))?.slice(7) ?? 4173);

try {
  if (command === "dev") {
    await prepare();
    await run("vitepress", ["dev", "site", "--port", String(port)]);
  } else if (command === "build") {
    await build();
  } else if (command === "preview") {
    await preview(port);
  } else if (command === "all") {
    await build();
    await preview(port);
  } else {
    throw new Error(`unknown command '${command}': dev, build, preview, or none for all`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
