import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { LockedError, acquireLock } from "../src/shared/lock";

let dir: string;
const lockFile = () => path.join(dir, ".lock");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-lock-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates the lock file and removes it on release", async () => {
    const lock = await acquireLock(dir);
    const info = JSON.parse(await fs.readFile(lockFile(), "utf8"));
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe(os.hostname());

    await lock.release();
    await expect(fs.access(lockFile())).rejects.toThrow();
  });

  it("refuses a second run while the first holds it", async () => {
    const first = await acquireLock(dir);
    try {
      await expect(acquireLock(dir)).rejects.toBeInstanceOf(LockedError);
      await expect(acquireLock(dir)).rejects.toThrow(/another visualice run/);
    } finally {
      await first.release();
    }
    // Once released, the directory is free again.
    await (await acquireLock(dir)).release();
  });

  it("takes over a lock whose process is gone", async () => {
    // pid 0x7FFFFFFF is not a live process; the lock is ours to reclaim.
    await fs.writeFile(
      lockFile(),
      JSON.stringify({
        pid: 0x7fffffff,
        host: os.hostname(),
        startedAt: new Date().toISOString(),
        command: "crawl",
      }),
    );
    const messages: string[] = [];
    const lock = await acquireLock(dir, { log: (m) => messages.push(m) });
    expect(messages.join("\n")).toContain("stale lock");
    expect(JSON.parse(await fs.readFile(lockFile(), "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("waits out a fresh lock from another machine instead of stealing it", async () => {
    const foreign = {
      pid: process.pid, // live here, but that says nothing about the other host
      host: "some-other-machine",
      startedAt: new Date().toISOString(),
      command: "crawl",
    };
    await fs.writeFile(lockFile(), JSON.stringify(foreign));
    await expect(acquireLock(dir)).rejects.toThrow(/some-other-machine/);

    // …unless it has been sitting there far too long.
    await fs.writeFile(
      lockFile(),
      JSON.stringify({ ...foreign, startedAt: new Date(Date.now() - 86_400_000).toISOString() }),
    );
    await (await acquireLock(dir)).release();
  });

  it("discards a truncated lock file", async () => {
    await fs.writeFile(lockFile(), "{not json");
    const lock = await acquireLock(dir);
    expect(JSON.parse(await fs.readFile(lockFile(), "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  it("never deletes a lock that has since been taken over", async () => {
    const lock = await acquireLock(dir);
    // Simulate another run reclaiming the directory after declaring ours stale.
    const other = {
      pid: process.pid + 1,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      command: "crawl",
    };
    await fs.writeFile(lockFile(), JSON.stringify(other));

    await lock.release();
    expect(JSON.parse(await fs.readFile(lockFile(), "utf8")).pid).toBe(other.pid);
  });

  it("is safe to release twice", async () => {
    const lock = await acquireLock(dir);
    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
