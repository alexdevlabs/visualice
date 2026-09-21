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

import { ensureStorageState, isSessionCookie, storageStateExpiry } from "../src/crawl/auth";

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

  it("does not re-login because an unrelated cookie expired", async () => {
    // A five-minute CSRF cookie that has lapsed says nothing about the session.
    const file = await saveSession(1);
    const past = Math.floor(Date.now() / 1000) - 300;
    await fs.writeFile(file, JSON.stringify({ cookies: [{ name: "csrftoken", expires: past }] }));
    const cfg = config({ storageStatePath: file, login: LOGIN });
    expect(await ensureStorageState(cfg, log)).toBe(file);
    expect(logs).toEqual([]);
  });

  it("trusts a named session cookie's expiry over maxAgeHours", async () => {
    const file = statePath();
    const tomorrow = Math.floor(Date.now() / 1000) + 86_400;
    await fs.writeFile(file, JSON.stringify({ cookies: [{ name: "sid", expires: tomorrow }] }));
    const old = new Date(Date.now() - 48 * HOUR);
    await fs.utimes(file, old, old);
    const cfg = config({ storageStatePath: file, login: { ...LOGIN, sessionCookies: ["sid"] } });
    expect(await ensureStorageState(cfg, log)).toBe(file); // 48h old, but the cookie says fine
  });

  it("re-logs in once the named session cookie has expired", async () => {
    const file = statePath();
    const past = Math.floor(Date.now() / 1000) - 60;
    await fs.writeFile(file, JSON.stringify({ cookies: [{ name: "sid", expires: past }] }));
    const cfg = config({ storageStatePath: file, login: { ...LOGIN, sessionCookies: ["sid"] } });
    await expect(ensureStorageState(cfg, log)).rejects.toThrow(LAUNCHED);
    expect(logs.join("\n")).toContain("session cookie expired");
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
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const later = soon + 86_400;

  it("reads the soonest expiry among the named session cookies", async () => {
    const file = await write({
      cookies: [
        { name: "sid", expires: later },
        { name: "sid_refresh", expires: soon },
      ],
    });
    expect(await storageStateExpiry(file, ["sid", "sid_refresh"])).toBe(soon * 1000);
  });

  it("never lets an unnamed cookie decide when the session ends", async () => {
    // The regression: a login flow saves CSRF/consent/analytics cookies too, and the
    // soonest of *those* used to count as the session's expiry.
    const file = await write({
      cookies: [
        { name: "sid", expires: later },
        { name: "csrftoken", expires: Math.floor(Date.now() / 1000) - 60 },
      ],
    });
    expect(await storageStateExpiry(file, ["sid"])).toBe(later * 1000);
  });

  it("has no answer when no session cookie is named", async () => {
    const file = await write({ cookies: [{ name: "sid", expires: soon }] });
    expect(await storageStateExpiry(file)).toBeUndefined();
    expect(await storageStateExpiry(file, [])).toBeUndefined();
  });

  it("matches a prefix when the name ends in *", async () => {
    const file = await write({ cookies: [{ name: "wordpress_logged_in_ab12", expires: soon }] });
    expect(await storageStateExpiry(file, ["wordpress_logged_in_*"])).toBe(soon * 1000);
    expect(isSessionCookie("wordpress_logged_in", ["wordpress_logged_in_*"])).toBe(false);
  });

  it("ignores browser-session cookies, which carry no expiry", async () => {
    const file = await write({ cookies: [{ name: "sid", expires: -1 }] });
    expect(await storageStateExpiry(file, ["sid"])).toBeUndefined();
  });

  it("falls back to undefined for missing or unreadable state", async () => {
    expect(await storageStateExpiry("/nope/auth.json", ["sid"])).toBeUndefined();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-auth-exp-"));
    const junk = path.join(dir, "auth.json");
    await fs.writeFile(junk, "{not json");
    expect(await storageStateExpiry(junk, ["sid"])).toBeUndefined();
    expect(await storageStateExpiry(await write({}), ["sid"])).toBeUndefined();
  });
});
