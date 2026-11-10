import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cacheFile,
  isNewer,
  knownUpdate,
  startUpdateCheck,
  updateCheckDisabled,
  updateNotice,
} from "../src/shared/update-check";

const DAY = 24 * 60 * 60 * 1000;

/** A fetch that answers with `version`, and counts its calls. */
function registry(version: string | Error) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (version instanceof Error) throw version;
    return new Response(JSON.stringify({ version }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("versions", () => {
  it("compares plain x.y.z versions", () => {
    expect(isNewer("0.2.0", "0.1.1")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
    expect(isNewer("0.3.0-beta.1", "0.2.0")).toBe(false);
    expect(isNewer("nonsense", "0.2.0")).toBe(false);
  });

  it("names both update commands", () => {
    const n = updateNotice("0.2.0", "0.3.0");
    expect(n).toContain("visualice 0.3.0 is available (you have 0.2.0)");
    expect(n).toContain("claude plugin update visualice@visualice");
    expect(n).toContain("npm i -g visualice@latest");
  });
});

describe("when it runs", () => {
  it("is off when opted out, in CI and in tests", () => {
    expect(updateCheckDisabled({})).toBe(false);
    expect(updateCheckDisabled({ VISUALICE_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" })).toBe(true);
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
  });

  it("caches under XDG_CACHE_HOME when set", () => {
    expect(cacheFile({ XDG_CACHE_HOME: "/c" })).toBe(
      path.join("/c", "visualice", "update-check.json"),
    );
  });
});

describe("startUpdateCheck", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-update-"));
    file = path.join(dir, "nested", "update-check.json");
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("says nothing on the first run, asks the registry, and tells the next run", async () => {
    const reg = registry("0.3.0");
    const first = await startUpdateCheck("0.2.0", { file, now: 1000, fetchFn: reg.fn });
    expect(first.notice).toBeUndefined();
    await first.refreshed;
    expect(reg.calls).toEqual(["https://registry.npmjs.org/visualice/latest"]);

    const next = await startUpdateCheck("0.2.0", { file, now: 2000, fetchFn: reg.fn });
    expect(next.notice).toContain("0.3.0 is available");
    await next.refreshed;
    expect(reg.calls).toHaveLength(1); // a fresh answer isn't asked for again
  });

  it("asks again once the answer is a day old, and says nothing when up to date", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ checkedAt: 0, latest: "0.2.0" }));
    const reg = registry("0.2.0");
    const check = await startUpdateCheck("0.2.0", { file, now: DAY + 1, fetchFn: reg.fn });
    expect(check.notice).toBeUndefined();
    await check.refreshed;
    expect(reg.calls).toHaveLength(1);
  });

  it("keeps the last answer when the registry can't be reached", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ checkedAt: 0, latest: "0.3.0" }));
    const check = await startUpdateCheck("0.2.0", {
      file,
      now: DAY + 1,
      fetchFn: registry(new Error("offline")).fn,
    });
    expect(check.notice).toContain("0.3.0");
    await expect(check.refreshed).resolves.toBeUndefined();
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(saved).toEqual({ checkedAt: DAY + 1, latest: "0.3.0" });
  });

  it("ignores a cache it can't read", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json");
    const check = await startUpdateCheck("0.2.0", { file, now: 1, fetchFn: registry("0.2.0").fn });
    expect(check.notice).toBeUndefined();
    await check.refreshed;
  });
});

describe("knownUpdate", () => {
  it("reads the cached answer for the viewer, without asking the registry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-known-"));
    const file = path.join(dir, "update-check.json");
    try {
      expect(await knownUpdate("0.2.0", file)).toBeUndefined();
      await fs.writeFile(file, JSON.stringify({ checkedAt: 0, latest: "0.3.0" }));
      expect(await knownUpdate("0.2.0", file)).toEqual({ current: "0.2.0", latest: "0.3.0" });
      expect(await knownUpdate("0.3.0", file)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
