import path from "node:path";
import type { SourceInfo } from "../shared/types";
import { git, isUnder, parsePorcelain, repoRoot, toRepoPath } from "./source";
import { globToRegExp } from "../shared/glob";

// `visualice changes`: what changed in the project since the commit the catalogue
// was shot from, and what that means for the next run. The mechanical half: git
// knows which files changed, file-based routing says which pages some of them are,
// and a list of known global files says when only a full run will do. Which pages a
// shared component touches is the agent's call; this hands it the facts.

export type Verdict = "none" | "partial" | "full" | "unknown";

export interface ChangedFile {
  path: string;
  /** git's letter: A added, M modified, D deleted, R renamed, ? untracked. */
  status: string;
  /** For a rename, where it came from. */
  from?: string;
}

/** A changed file that file-based routing ties to pages. */
export interface PageCandidate {
  file: string;
  /** The route pattern the file serves: `/blog/*`, or `/docs/**` for a layout. */
  pattern: string;
  kind: "page" | "layout";
  /** Pages in the site model the pattern matches. */
  pages: string[];
}

export interface ChangesReport {
  /** The commit the catalogue was shot from, and where that record was read. */
  baseline?: SourceInfo & { from: "routes-file" | "run" };
  head?: { commit: string; branch?: string; dirty: number };
  verdict: Verdict;
  /** Why the verdict is what it is, most important first. */
  reasons: string[];
  /** Commits since the baseline (newest first, capped), and how many in all. */
  commits: { hash: string; subject: string }[];
  commitCount: number;
  /** Every changed file that counts (the crawl's own files left out). */
  files: ChangedFile[];
  /** Changed files that change every page: dependencies, global styles, root layouts. */
  global: { path: string; reason: string }[];
  /** Changed files that map to pages by their place in the routes folder. */
  candidates: PageCandidate[];
  /** Changed files that map to no page on their own: the agent traces their importers. */
  unmapped: string[];
  /** Pages found or gone since the catalogue, when a route discovery was run. */
  routes?: { added: string[]; removed: string[] };
  /** What to run next, when the facts alone settle it. */
  suggest?: { only?: string[]; command: string };
}

const MAX_COMMITS = 50;

/*
 * Global files: a change to one of these reaches every page, so a partial run would
 * leave most of the catalogue stale.
 */

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "Gemfile.lock",
]);

const BUILD_CONFIG =
  /^(tailwind|postcss|vite|next|nuxt|astro|svelte|remix|webpack|rollup|uno|panda|stitches|theme|app)\.config\.[cm]?[jt]s$/;

const GLOBAL_STYLE_NAME =
  /^(globals?|app|index|main|site|styles?|style|base|reset|normalize|theme|tokens|variables|vars|typography|fonts?|tailwind|bootstrap)\.(css|scss|sass|less|styl|pcss)$/i;

const GLOBAL_DIRS = new Set(["styles", "theme", "themes", "tokens", "design-tokens", "fonts"]);

const ROOT_LAYOUTS = [
  /^(src\/)?app\/(layout|template|global-error|not-found)\.[cm]?[jt]sx?$/,
  /^(src\/)?pages\/_(app|document)\.[cm]?[jt]sx?$/,
  /^(src\/)?app\.(vue|svelte|html)$/i,
  /^(src\/)?App\.(vue|svelte|[cm]?[jt]sx?)$/,
  /^(src\/)?(main|index)\.[cm]?[jt]sx?$/,
  /^src\/routes\/\+layout(\.server)?\.(svelte|[jt]s)$/,
  /^app\/root\.[cm]?[jt]sx?$/,
  /^(src\/)?layouts\/default\.vue$/,
  /^(public\/)?index\.html$/,
];

/** Shared chrome: a header or footer is on every page, whatever folder it's in. */
const CHROME_NAME =
  /^(layout|root-?layout|base-?layout|default-?layout|header|footer|nav|navbar|navigation|sidebar|topbar|top-?nav|site-?header|site-?footer|site-?nav|app-?shell|shell)\.(tsx|jsx|vue|svelte|astro|[cm]?[jt]s)$/i;

/** Why a change to `file` (repo-relative) reaches every page, or undefined. */
export function globalReason(file: string): string | undefined {
  const base = path.posix.basename(file);
  const segments = file.split("/");
  if (DEPENDENCY_FILES.has(base) && segments.length <= 2) return "dependencies";
  if (BUILD_CONFIG.test(base)) return "build or theme config";
  if (/^visualice\.config\.(json|[cm]?[jt]s)$/.test(base)) return "visualice config";
  if (ROOT_LAYOUTS.some((re) => re.test(file))) return "root layout or entry point";
  const inComponents = segments.some((s) => /^components?$/i.test(s));
  if (GLOBAL_STYLE_NAME.test(base) && !inComponents) return "global styles";
  if (segments.slice(0, -1).some((s) => GLOBAL_DIRS.has(s.toLowerCase())))
    return "global styles or theme";
  // A nested route layout (app/blog/layout.tsx) only wraps its own section: routing
  // maps it to that section's pages below, rather than to every page.
  if (CHROME_NAME.test(base) && guessRoute(file)?.kind !== "layout")
    return "shared page chrome (layout, header, footer, nav)";
  if (/^(src\/)?layouts\/[^/]+\.astro$/.test(file)) return "page layout";
  return undefined;
}

/*
 * File-based routing: the frameworks whose folder layout is the URL layout. Each
 * rule turns a file into route segments; `*` is one dynamic segment, `**` the rest.
 */

interface RouteGuess {
  segments: string[];
  kind: "page" | "layout";
}

const CODE = String.raw`(?:[cm]?[jt]sx?|mdx?|vue|svelte|astro|html)`;

/** `[slug]` → `*`, `[...rest]` / `[[...rest]]` → `**`, `(group)` / `@slot` → dropped. */
function bracketSegments(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (/^\(.*\)$/.test(p) || p.startsWith("@") || p.startsWith("_")) continue;
    if (/^\[\[?\.\.\..+\]\]?$/.test(p)) out.push("**");
    else if (/^\[.+\]$/.test(p)) out.push("*");
    else out.push(p);
  }
  return out;
}

/** The route a changed file serves, by the conventions of file-based routers. */
export function guessRoute(file: string): RouteGuess | undefined {
  let m: RegExpExecArray | null;

  // Next.js app router: app/blog/[slug]/page.tsx
  m = new RegExp(
    // The name is the whole file name: `app/components/homepage.tsx` is no page.
    String.raw`^(?:src/)?app/(?:(.*)/)?(page|layout|template|loading|error|not-found)\.${CODE}$`,
  ).exec(file);
  if (m && !/(^|\/)api(\/|$)/.test(m[1] ?? "")) {
    const segs = bracketSegments(m[1] ? m[1].split("/") : []);
    return { segments: segs, kind: m[2] === "page" ? "page" : "layout" };
  }
  // SvelteKit: src/routes/blog/[slug]/+page.svelte
  m = new RegExp(String.raw`^src/routes/(?:(.*)/)?\+(page|layout)(?:\.server)?\.${CODE}$`).exec(
    file,
  );
  if (m) {
    return {
      segments: bracketSegments(m[1] ? m[1].split("/") : []),
      kind: m[2] === "page" ? "page" : "layout",
    };
  }
  // Remix flat routes: app/routes/blog.$slug.tsx, app/routes/_index.tsx
  m = new RegExp(String.raw`^app/routes/([^/]+?)(?:/route)?\.${CODE}$`).exec(file);
  if (m) {
    const segs: string[] = [];
    for (const part of m[1].split(".")) {
      if (part === "_index" || part.startsWith("_") || /^\(.*\)$/.test(part)) continue;
      if (part === "$") segs.push("**");
      else if (part.startsWith("$")) segs.push("*");
      else segs.push(part.replace(/_$/, ""));
    }
    return { segments: segs, kind: "page" };
  }
  // Pages folders: Next.js pages/, Nuxt pages/, Astro src/pages/, Gatsby src/pages/.
  m = new RegExp(String.raw`^(?:src/)?pages/(.+)\.${CODE}$`).exec(file);
  if (m) {
    const parts = m[1].split("/");
    if (parts[0] === "api" || parts.some((p) => p.startsWith("_"))) return undefined;
    if (parts.at(-1) === "index") parts.pop();
    return { segments: bracketSegments(parts), kind: "page" };
  }
  // Plain HTML at the root or in public/: about.html, blog/index.html
  m = /^(?:public\/|static\/)?(.+)\.html?$/.exec(file);
  if (m && !file.includes("node_modules/")) {
    const parts = m[1].split("/");
    if (parts.at(-1) === "index") parts.pop();
    return { segments: parts, kind: "page" };
  }
  return undefined;
}

/** A guess as a route pattern string: `/blog/*`; a layout covers everything under it. */
export function guessPattern(g: RouteGuess): string {
  const base = `/${g.segments.join("/")}`;
  if (g.kind === "layout") return base === "/" ? "/**" : `${base}/**`;
  return base;
}

/** Does a site-model page match a guessed pattern? */
export function patternMatches(pattern: string, page: string): boolean {
  const pathOnly =
    (() => {
      try {
        return new URL(page, "http://_local_").pathname;
      } catch {
        return page;
      }
    })().replace(/\/+$/, "") || "/";
  const variants = new Set([
    pathOnly,
    pathOnly.replace(/\.html?$/, ""),
    pathOnly.replace(/\/index$/, "") || "/",
  ]);
  // The crawl's own glob rules, so `--only` matches here what it matches there.
  const rx = globToRegExp(pattern === "/" ? "/" : pattern.replace(/\/+$/, ""));
  return [...variants].some((v) => rx.test(v));
}

/** Parse `git diff --name-status -z`. */
export function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      files.push({ status: letter, from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: letter, path: parts[i + 1] });
      i += 1;
    }
  }
  return files.filter((f) => f.path);
}

export interface ChangesInput {
  cwd: string;
  /** The routes file's record, if it has one. */
  recorded?: SourceInfo;
  /** A run manifest's record, used when the routes file has none (and for its dirty files). */
  runSource?: SourceInfo;
  /**
   * The newest finished run on this computer: the one a partial run carries from.
   * When it was shot at another commit than the routes file records (a routes file
   * pulled from a teammate, a run on another branch), it is the baseline, so that
   * `changes` and `crawl --only` work from the same shots.
   */
  localRun?: SourceInfo;
  /** Paths whose changes don't count: the routes file, the output folder, the config. */
  ignore: string[];
  /** The config file now, and its hash: compared with the record's, not diffed. */
  config?: { file: string; hash?: string };
  /** Pages in the cached site model. */
  pages: string[];
  /** From a route discovery, when one ran. */
  routes?: { added: string[]; removed: string[] };
}

/** Work out what changed since the catalogue's commit, and the verdict. */
export async function computeChanges(input: ChangesInput): Promise<ChangesReport> {
  const report: ChangesReport = {
    verdict: "unknown",
    reasons: [],
    commits: [],
    commitCount: 0,
    files: [],
    global: [],
    candidates: [],
    unmapped: [],
    ...(input.routes ? { routes: input.routes } : {}),
  };
  const fullRun = "visualice crawl";

  const root = await repoRoot(input.cwd);
  if (!root) {
    report.reasons.push("not a git repository: nothing to diff against");
    report.suggest = { command: fullRun };
    return report;
  }
  const headCommit = (await git(root, ["rev-parse", "HEAD"]))?.trim();
  const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();

  const local =
    input.recorded && input.localRun && input.localRun.commit !== input.recorded.commit
      ? input.localRun
      : undefined;
  const record = local ?? input.recorded ?? input.runSource;
  const runSource = local ?? input.runSource;
  if (!record) {
    report.reasons.push(
      "no recorded commit: the catalogue predates commit tracking, or was never shot",
    );
    report.suggest = { command: fullRun };
    return report;
  }
  const dirtyFiles =
    runSource && runSource.commit === record.commit ? runSource.dirtyFiles : undefined;
  // A record keeps a capped list; past the cap, the files it left out can't be diffed.
  const dirtyListed = record.dirty === 0 || (dirtyFiles?.length ?? 0) >= record.dirty;
  report.baseline = {
    ...record,
    ...(dirtyFiles ? { dirtyFiles } : {}),
    from: input.recorded && !local ? "routes-file" : "run",
  };
  if (local && input.recorded) {
    report.reasons.push(
      `the routes file records commit ${input.recorded.commit.slice(0, 12)}, but the newest run on this computer was shot at ${local.commit.slice(0, 12)}: compared against that run, whose shots are the ones a partial run carries over`,
    );
  }

  if (!(await commitExists(root, record.commit))) {
    report.reasons.push(
      `commit ${record.commit.slice(0, 12)} isn't in this repository (rebased, squashed or not fetched): nothing to diff against`,
    );
    report.suggest = { command: fullRun };
    return report;
  }

  const ignore = input.ignore.map((p) => toRepoPath(root, p)).filter(Boolean) as string[];
  const counts = (f: string) => !isUnder(f, ignore);

  const [diffOut, untrackedOut, logOut, countOut, ancestor] = await Promise.all([
    git(root, ["diff", "--name-status", "-z", "-M", record.commit]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(root, ["log", "--format=%H%x09%s", `-n${MAX_COMMITS}`, `${record.commit}..HEAD`]),
    git(root, ["rev-list", "--count", `${record.commit}..HEAD`]),
    git(root, ["merge-base", "--is-ancestor", record.commit, "HEAD"]),
  ]);
  const files = parseNameStatus(diffOut ?? "").filter((f) => counts(f.path));
  for (const f of (untrackedOut ?? "").split("\0")) {
    if (f && counts(f) && !files.some((x) => x.path === f)) files.push({ path: f, status: "?" });
  }
  // Files that were dirty when the catalogue was shot: what was shot isn't the
  // commit's version of them, so they count as changed whatever the diff says.
  for (const f of dirtyFiles ?? []) {
    if (counts(f) && !files.some((x) => x.path === f)) files.push({ path: f, status: "M" });
  }
  report.files = files;
  report.commits = (logOut ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, ...rest] = l.split("\t");
      return { hash, subject: rest.join("\t") };
    });
  report.commitCount = Number(countOut?.trim() ?? report.commits.length) || 0;
  const headStatus = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  report.head = headCommit
    ? {
        commit: headCommit,
        branch: branch || undefined,
        dirty: parsePorcelain(headStatus ?? "").filter(counts).length,
      }
    : undefined;

  // The config is compared by hash: a first crawl scaffolds it, so it is usually not
  // committed yet when the catalogue is shot, and a diff would call it new.
  if (input.config && record.config && input.config.hash !== record.config) {
    const rel = toRepoPath(root, input.config.file) ?? path.basename(input.config.file);
    report.global.push({ path: rel, reason: "visualice config" });
  }

  // Classify every changed file, by its path inside the project: in a monorepo the
  // project is a folder of the repository (`apps/web`), and git's paths start there.
  const project = toRepoPath(root, input.cwd);
  for (const f of files) {
    const local = projectPath(f.path, project);
    if (local === undefined) {
      // Outside the project: a root lockfile reaches it; anything else (a shared
      // package, another app) is for whoever traces imports to say.
      if (globalReason(f.path) === "dependencies") {
        report.global.push({ path: f.path, reason: "dependencies" });
      } else report.unmapped.push(f.path);
      continue;
    }
    const from = f.from ? projectPath(f.from, project) : undefined;
    const reason = globalReason(local) ?? (from ? globalReason(from) : undefined);
    if (reason) {
      report.global.push({ path: f.path, reason });
      continue;
    }
    const guess = guessRoute(local);
    if (guess) {
      const pattern = guessPattern(guess);
      report.candidates.push({
        file: f.path,
        pattern,
        kind: guess.kind,
        pages: input.pages.filter((p) => patternMatches(pattern, p)),
      });
      continue;
    }
    report.unmapped.push(f.path);
  }

  // The verdict, and the reasons that carry it.
  if (ancestor === undefined && headCommit !== record.commit) {
    report.reasons.push(
      `commit ${record.commit.slice(0, 12)} isn't an ancestor of HEAD (another branch, or history rewritten): the diff is between the two trees`,
    );
  }
  if (record.target && record.local === false) {
    report.reasons.push(
      `the catalogue was shot from ${record.target}, not a local server: it shows what was deployed there, which may not be commit ${record.commit.slice(0, 12)}`,
    );
  }
  if (!dirtyListed) {
    report.reasons.push(
      `the catalogue was shot with ${record.dirty} uncommitted change(s) that can't all be listed now: a full run is the safe choice`,
    );
  }
  const removed = input.routes?.removed ?? [];
  const added = input.routes?.added ?? [];
  if (removed.length) {
    // The cached model still has them, and a partial run carries every page it doesn't
    // shoot: until the routes file skips them, their old shots carry on.
    report.reasons.push(
      `${removed.length} page(s) are gone from the site (${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ", …" : ""}): add a "- skip: <path>" line for each to the routes file, or partial runs keep carrying their old shots`,
    );
  }

  if (report.global.length) {
    report.verdict = "full";
    const kinds = [...new Set(report.global.map((g) => g.reason))];
    report.reasons.unshift(
      `${report.global.length} changed file(s) reach every page (${kinds.join("; ")}): ${report.global
        .slice(0, 5)
        .map((g) => g.path)
        .join(", ")}${report.global.length > 5 ? ", …" : ""}`,
    );
  } else if (!dirtyListed) {
    report.verdict = "full";
  } else if (!files.length && !added.length && !removed.length) {
    report.verdict = "none";
    report.reasons.unshift(
      headCommit === record.commit
        ? "HEAD is the commit the catalogue was shot from, and nothing has changed since"
        : `${report.commitCount} commit(s) since, but none of them change a file that counts`,
    );
  } else {
    report.verdict = "partial";
    report.reasons.unshift(
      `${files.length} file(s) changed in ${report.commitCount} commit(s)` +
        (report.unmapped.length
          ? `; ${report.unmapped.length} of them map to no page on their own — find the pages that import them`
          : ""),
    );
  }

  if (report.verdict === "full") {
    report.suggest = { command: fullRun };
  } else if (report.verdict === "partial") {
    const only = [
      ...new Set([
        ...report.candidates.flatMap((c) => (c.pages.length ? c.pages : [c.pattern])),
        ...added,
      ]),
    ];
    if (only.length && !report.unmapped.length) {
      report.suggest = {
        only,
        command: `visualice crawl --replay --only=${shellQuote(only.join(","))}`,
      };
    }
  }
  return report;
}

/**
 * A repo-relative path as one relative to the project folder (`project`, itself
 * repo-relative; undefined when the project is the repository root). Undefined for a
 * file outside the project.
 */
export function projectPath(file: string, project: string | undefined): string | undefined {
  if (!project) return file;
  return file.startsWith(`${project}/`) ? file.slice(project.length + 1) : undefined;
}

/** Quote a value for a POSIX shell when it holds anything a shell would expand. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function commitExists(root: string, commit: string): Promise<boolean> {
  return (await git(root, ["cat-file", "-t", commit]))?.trim() === "commit";
}
