import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, type Config } from "../src/shared/config";

/**
 * `ensureStorageState` decides *whether* to log in before it ever opens a browser.
 * That decision — reuse the saved session, refresh it, or crawl anonymously — is
 * what these tests pin down, so launching is replaced by a sentinel: reaching it at
 * all means "this run decided to re-authenticate".
 */
const LAUNCHED = "a login was attempted";

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => {
      throw new Error(LAUNCHED);
    },
  },
}));

import { ensureStorageState, storageStateExpiry } from "../src/crawl/auth";

const HOUR = 3.6e6;

let dir: string;
let logs: string[];
const log = (m: string) => logs.push(m);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-auth-"));
  logs = [];
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const statePath = () => path.join(dir, "auth.json");

/** A saved Playwright session, aged by `ageHours`. */
async function saveSession(ageHours: number): Promise<string> {
  const file = statePath();
  await fs.writeFile(file, '{"cookies":[],"origins":[]}');
  const when = new Date(Date.now() - ageHours * HOUR);
  await fs.utimes(file, when, when);
  return file;
}

const config = (auth: Record<string, unknown>): Config =>
  ConfigSchema.parse({ target: "https://x.test", auth });

const LOGIN = {
  url: "/login",
  steps: [{ action: "click", target: { role: "button", name: "Sign in" } }],
};

describe("ensureStorageState", () => {
  it("crawls anonymously when no storage state path is configured", async () => {
    expect(await ensureStorageState(config({}), log)).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("reuses a saved session that is still inside maxAgeHours", async () => {
    const file = await saveSession(1);
    const cfg = config({ storageStatePath: file, login: { ...LOGIN, maxAgeHours: 6 } });
    expect(await ensureStorageState(cfg, log)).toBe(file);
    expect(logs).toEqual([]); // no "authenticating" line — nothing was re-run
  });

  it("re-runs the login recipe once the saved session is past maxAgeHours", async () => {
    const file = await saveSession(7);
    const cfg = config({ storageStatePath: file, login: { ...LOGIN, maxAgeHours: 6 } });
    await expect(ensureStorageState(cfg, log)).rejects.toThrow(LAUNCHED);
    expect(logs.join("\n")).toContain("authenticating");
  });

  it("treats a session as fresh for 12 hours when the recipe sets no maxAgeHours", async () => {
    const cfg = (file: string) => config({ storageStatePath: file, login: LOGIN });

    expect(await ensureStorageState(cfg(await saveSession(11)), log)).toBe(statePath());
    await expect(ensureStorageState(cfg(await saveSession(13)), log)).rejects.toThrow(LAUNCHED);
  });

  it("keeps using a stale session when there is no recipe to refresh it with", async () => {
    // Nothing can be re-run, and an expired cookie jar still beats crawling logged out.
    const file = await saveSession(500);
    expect(await ensureStorageState(config({ storageStatePath: file }), log)).toBe(file);
  });

  it("crawls anonymously when nothing is saved and no recipe can create it", async () => {
    const cfg = config({ storageStatePath: statePath() });
    expect(await ensureStorageState(cfg, log)).toBeUndefined();
  });

  it("logs in when nothing is saved yet but a recipe exists", async () => {
    const cfg = config({ storageStatePath: statePath(), login: LOGIN });
    await expect(ensureStorageState(cfg, log)).rejects.toThrow(LAUNCHED);
    expect(logs.join("\n")).toContain("authenticating");
  });

  it("resolves a relative storage state path against the working directory", async () => {
    const rel = path.relative(process.cwd(), await saveSession(1));
    const cfg = config({ storageStatePath: rel });
    expect(await ensureStorageState(cfg, log)).toBe(statePath());
  });
});

describe("storageStateExpiry", () => {
  const write = async (state: unknown): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-auth-exp-"));
    const file = path.join(dir, "auth.json");
    await fs.writeFile(file, JSON.stringify(state));
    return file;
  };

  it("reads the soonest real cookie expiry — that's when the crawl logs out", async () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const later = soon + 86_400;
    const file = await write({
      cookies: [
        { name: "long", expires: later },
        { name: "short", expires: soon },
      ],
    });
    expect(await storageStateExpiry(file)).toBe(soon * 1000);
  });

  it("ignores session cookies, which carry no expiry", async () => {
    const file = await write({ cookies: [{ name: "sid", expires: -1 }] });
    expect(await storageStateExpiry(file)).toBeUndefined();
  });

  it("falls back to undefined for missing or unreadable state", async () => {
    expect(await storageStateExpiry("/nope/auth.json")).toBeUndefined();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-auth-exp-"));
    const junk = path.join(dir, "auth.json");
    await fs.writeFile(junk, "{not json");
    expect(await storageStateExpiry(junk)).toBeUndefined();
    expect(await storageStateExpiry(await write({}))).toBeUndefined();
  });
});
