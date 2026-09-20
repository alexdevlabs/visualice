import path from "node:path";
import os from "node:os";
import { promises as fs, readFileSync, rmSync } from "node:fs";

/**
 * A cooperative lock over one output directory.
 *
 * Two crawls sharing `.visualice/` interleave writes to `crawl-map.cache.json` and
 * `auth.json` and corrupt each other — the second run's discovery overwrites the
 * first's cache mid-capture, and a re-login swaps the storage state out from under
 * a running browser. Concurrency *within* a run is the pool's job; this only stops
 * two runs from sharing one directory.
 */

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  command: string;
}

export interface Lock {
  release: () => Promise<void>;
}

export class LockedError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(
      `another visualice run is using this directory (pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}).\n` +
        `Wait for it to finish, or use --out=<dir> for a separate output directory.`,
    );
  }
}

const lockPath = (outRoot: string): string => path.join(outRoot, ".lock");

/** Is this pid still around? Only meaningful for locks taken on this host. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 tests for existence without touching the process
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as LockInfo;
  } catch {
    return undefined; // a truncated lock file is a dead lock
  }
}

/**
 * True when an existing lock can be taken over: same host and the process is gone
 * (a crashed or killed run). A lock from another machine is never stolen — on a
 * shared volume we can't tell a dead pid from a live one elsewhere.
 */
function isStale(info: LockInfo | undefined, maxAgeMs: number): boolean {
  if (!info) return true;
  if (info.host !== os.hostname()) {
    return Date.now() - Date.parse(info.startedAt) > maxAgeMs;
  }
  return !alive(info.pid);
}

export interface LockOptions {
  /** How long a foreign-host lock may sit before it's assumed abandoned. Default 6h. */
  maxAgeMs?: number;
  command?: string;
  log?: (msg: string) => void;
}

/**
 * Take the lock for `outRoot`, or throw `LockedError`. Always release in a
 * `finally` — the process-exit handler here is a backstop for hard kills, not a
 * substitute.
 */
export async function acquireLock(outRoot: string, opts: LockOptions = {}): Promise<Lock> {
  const file = lockPath(outRoot);
  const info: LockInfo = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    command: opts.command ?? (process.argv.slice(2).join(" ") || "crawl"),
  };
  await fs.mkdir(outRoot, { recursive: true });

  const write = async () => {
    // `wx` fails when the file exists — that atomicity is the whole lock.
    const handle = await fs.open(file, "wx");
    try {
      await handle.writeFile(JSON.stringify(info, null, 2));
    } finally {
      await handle.close();
    }
  };

  try {
    await write();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = await readLock(file);
    if (!isStale(holder, opts.maxAgeMs ?? 6 * 60 * 60 * 1000)) throw new LockedError(holder!);
    opts.log?.(
      holder
        ? `taking over a stale lock from pid ${holder.pid} (${holder.startedAt})`
        : "removing an unreadable lock file",
    );
    await fs.rm(file, { force: true });
    try {
      await write();
    } catch (raced) {
      if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced;
      // Someone else won the race to replace the stale lock.
      throw new LockedError((await readLock(file)) ?? info);
    }
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    process.off("exit", onExit);
    // Only remove the lock if it's still ours: a stale-takeover by another run
    // means this file now belongs to them.
    const current = await readLock(file);
    if (current?.pid === info.pid && current.startedAt === info.startedAt) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  };
  // Best effort on abrupt exit; `release()` in a finally is the real path.
  const onExit = () => {
    try {
      const current = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
      if (current.pid === info.pid) rmSync(file, { force: true });
    } catch {
      /* nothing we can do synchronously at exit */
    }
  };
  process.once("exit", onExit);

  return { release };
}
