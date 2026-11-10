import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import type { SourceInfo } from "../shared/types";

// The code a catalogue was shot from: the git commit checked out in the project when
// the crawl ran. Recorded in the routes file (committed) and each run's manifest, so
// a later run can ask git what changed since and recapture only what that touches.

/** Run git in `cwd`; resolves to stdout, or undefined when git fails or isn't there. */
export function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

/** The repository's top-level directory, if `cwd` is inside one. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || undefined;
}

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0|[^.]+\.localhost|.+\.local)$/i;

/**
 * Is `target` served from this machine? Only then is HEAD known to be what was shot;
 * a staging or production URL runs whatever was last deployed there.
 */
export function isLocalTarget(target: string): boolean {
  try {
    return LOOPBACK.test(new URL(target).hostname);
  } catch {
    return false;
  }
}

/** Files listed by `git status --porcelain=v1 -z`, repo-relative. */
export function parsePorcelain(out: string): string[] {
  const files: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push(entry.slice(3));
    // A rename or copy is followed by its original path, as its own NUL-terminated field.
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return files;
}

/** Does `file` (repo-relative, `/`-separated) sit at or under one of `paths`? */
export function isUnder(file: string, paths: string[]): boolean {
  return paths.some((p) => p && (file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`)));
}

/** Most dirty files a record keeps; past it, `dirty` still says how many there were. */
const MAX_DIRTY = 200;

/**
 * Read the commit checked out in `cwd`. `ignore` lists repo-relative paths whose
 * changes don't count as a dirty tree (the routes file the crawl itself rewrites, the
 * output folder). Undefined outside a git repository, or without git.
 */
export async function readSource(
  cwd: string,
  opts: { target?: string; ignore?: string[]; configFile?: string; now?: Date } = {},
): Promise<SourceInfo | undefined> {
  const root = await repoRoot(cwd);
  if (!root) return undefined;
  const head = (await git(root, ["rev-parse", "HEAD"]))?.trim();
  if (!head) return undefined; // a repository with no commits yet
  const [branchOut, dateOut, statusOut] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(root, ["show", "-s", "--format=%cI", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const ignore = (opts.ignore ?? []).map((p) => toRepoPath(root, p)).filter(Boolean) as string[];
  const dirtyFiles = parsePorcelain(statusOut ?? "").filter((f) => !isUnder(f, ignore));
  const config = opts.configFile ? await hashFile(opts.configFile) : undefined;
  return {
    commit: head,
    branch: branchOut?.trim() || undefined,
    committedAt: dateOut?.trim() || undefined,
    dirty: dirtyFiles.length,
    ...(dirtyFiles.length ? { dirtyFiles: dirtyFiles.slice(0, MAX_DIRTY) } : {}),
    capturedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.target ? { target: opts.target, local: isLocalTarget(opts.target) } : {}),
    ...(config ? { config } : {}),
  };
}

/** The first 12 hex digits of a file's SHA-256, or undefined when it can't be read. */
export async function hashFile(file: string): Promise<string | undefined> {
  const data = await fs.readFile(file).catch(() => undefined);
  return data ? createHash("sha256").update(data).digest("hex").slice(0, 12) : undefined;
}

/** Config files picked up from the working directory when `--config` isn't given, in order. */
export const CONFIG_FILES = [
  "visualice.config.ts",
  "visualice.config.mjs",
  "visualice.config.js",
  "visualice.config.json",
];

/**
 * The config file a command uses: `explicit` (`--config`) when given, else the first
 * of CONFIG_FILES in `cwd`. Absolute; undefined when there is none.
 */
export async function findConfigFile(cwd: string, explicit?: string): Promise<string | undefined> {
  if (explicit) return path.resolve(cwd, explicit);
  for (const name of CONFIG_FILES) {
    const file = path.join(cwd, name);
    if (await fs.stat(file).catch(() => undefined)) return file;
  }
  return undefined;
}

/** An absolute or cwd-relative path as a repo-relative, `/`-separated one (or undefined outside it). */
export function toRepoPath(root: string, p: string): string | undefined {
  // git reports the real path of the repository; `p` may come through a symlink
  // (macOS's /var → /private/var), so compare real paths.
  const rel = path.relative(realPath(root), realPath(path.resolve(p)));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/*
 * The routes file carries the record as one comment line under its title:
 *
 *   <!-- visualice-source commit=3f2a9c1… branch=main dirty=0 captured=2026-11-09T10:00:00.000Z -->
 *
 * One line of key=value pairs: readable in a diff, and parsed back by `changes`.
 */

const SOURCE_LINE = /^<!--\s*visualice-source\s+(.*?)\s*-->\s*$/;

export function renderSourceLine(s: SourceInfo): string {
  const pairs: [string, string | number | undefined][] = [
    ["commit", s.commit],
    ["branch", s.branch],
    ["dirty", s.dirty],
    ["captured", s.capturedAt],
    ["target", s.target],
    ["config", s.config],
  ];
  const body = pairs
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, "%20")}`)
    .join(" ");
  return `<!-- visualice-source ${body} -->`;
}

/** The record in a routes-file line, or undefined when the line isn't one. */
export function parseSourceLine(line: string): SourceInfo | undefined {
  const m = SOURCE_LINE.exec(line);
  if (!m) return undefined;
  const kv = new Map<string, string>();
  for (const token of m[1].split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) kv.set(token.slice(0, eq), token.slice(eq + 1).replace(/%20/g, " "));
  }
  const commit = kv.get("commit");
  if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return undefined;
  const dirty = Number(kv.get("dirty") ?? 0);
  const target = kv.get("target");
  const config = kv.get("config");
  return {
    commit,
    branch: kv.get("branch") || undefined,
    dirty: Number.isFinite(dirty) && dirty > 0 ? Math.floor(dirty) : 0,
    capturedAt: kv.get("captured") ?? "",
    ...(target ? { target, local: isLocalTarget(target) } : {}),
    ...(config ? { config } : {}),
  };
}

/** The real path of `p`, resolving through its nearest existing parent when it doesn't exist. */
function realPath(p: string): string {
  try {
    // `.native` asks the OS: on Windows it also expands 8.3 short names
    // (C:\Users\RUNNER~1), which git never reports and the JS version leaves alone.
    return realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}
