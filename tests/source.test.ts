import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findConfigFile,
  isLocalTarget,
  isUnder,
  parsePorcelain,
  parseSourceLine,
  readSource,
  renderSourceLine,
} from "../src/crawl/source";
import { parseRoutesFile, renderRoutesFile } from "../src/crawl/routes-file";
import type { SourceInfo } from "../src/shared/types";

const SHA = "3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a";

const record = (extra: Partial<SourceInfo> = {}): SourceInfo => ({
  commit: SHA,
  branch: "main",
  dirty: 0,
  capturedAt: "2026-11-09T10:00:00.000Z",
  target: "http://localhost:3000/",
  local: true,
  ...extra,
});

describe("the routes-file source line", () => {
  it("round-trips", () => {
    const line = renderSourceLine(record({ config: "bab17dc92481" }));
    expect(line).toBe(
      `<!-- visualice-source commit=${SHA} branch=main dirty=0 captured=2026-11-09T10:00:00.000Z target=http://localhost:3000/ config=bab17dc92481 -->`,
    );
    expect(parseSourceLine(line)).toEqual(record({ config: "bab17dc92481" }));
  });

  it("keeps a branch name with spaces in one token", () => {
    const back = parseSourceLine(renderSourceLine(record({ branch: "my branch" })));
    expect(back?.branch).toBe("my branch");
  });

  it("ignores other comments and a line without a real commit", () => {
    expect(parseSourceLine("<!-- just a note -->")).toBeUndefined();
    expect(parseSourceLine("<!-- visualice-source commit=nothex -->")).toBeUndefined();
  });

  it("is read from the routes file and kept when re-rendered without a new one", () => {
    const model = { routes: [{ id: "home", url: "/", depth: 0, states: [] }] };
    const first = renderRoutesFile(model, parseRoutesFile(""), "http://localhost:3000/", record());
    const intent = parseRoutesFile(first);
    expect(intent.source?.commit).toBe(SHA);
    expect(intent.routes.map((r) => r.path)).toEqual(["/"]);
    // A discovery or `visualice routes` rewrites the file: the record stays.
    expect(renderRoutesFile(model, intent, "http://localhost:3000/")).toBe(first);
    // A capture replaces it.
    const next = renderRoutesFile(
      model,
      intent,
      "http://localhost:3000/",
      record({ commit: "a".repeat(40) }),
    );
    expect(parseRoutesFile(next).source?.commit).toBe("a".repeat(40));
  });
});

describe("helpers", () => {
  it("knows a local target from a deployed one", () => {
    expect(isLocalTarget("http://localhost:3000/")).toBe(true);
    expect(isLocalTarget("http://127.0.0.1:8080")).toBe(true);
    expect(isLocalTarget("http://shop.local/")).toBe(true);
    expect(isLocalTarget("https://staging.example.com/")).toBe(false);
  });

  it("parses porcelain status, renames included", () => {
    expect(parsePorcelain(" M a.ts\0?? b.ts\0R  new.ts\0old.ts\0")).toEqual([
      "a.ts",
      "b.ts",
      "new.ts",
    ]);
  });

  it("finds the config file a command uses, --config first", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-config-"));
    try {
      expect(await findConfigFile(dir)).toBeUndefined();
      await fs.writeFile(path.join(dir, "visualice.config.json"), "{}");
      expect(await findConfigFile(dir)).toBe(path.join(dir, "visualice.config.json"));
      expect(await findConfigFile(dir, "ci.json")).toBe(path.join(dir, "ci.json"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("matches a path at or under another", () => {
    expect(isUnder(".visualice/x.json", [".visualice"])).toBe(true);
    expect(isUnder("visualice.routes.md", ["visualice.routes.md"])).toBe(true);
    expect(isUnder(".visualice-old/x", [".visualice"])).toBe(false);
  });
});

describe("readSource", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-source-"));
    git("init", "-q", "-b", "main");
    await fs.writeFile(path.join(dir, "index.html"), "<h1>hi</h1>");
    git("add", "-A");
    git("commit", "-qm", "init");
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("reads HEAD, the branch and a clean tree", async () => {
    const s = await readSource(dir, { target: "http://localhost:1/" });
    expect(s?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(s?.branch).toBe("main");
    expect(s?.dirty).toBe(0);
    expect(s?.local).toBe(true);
  });

  it("lists dirty files, leaving the crawl's own out", async () => {
    await fs.writeFile(path.join(dir, "index.html"), "<h1>changed</h1>");
    await fs.writeFile(path.join(dir, "visualice.routes.md"), "# Routes");
    const s = await readSource(dir, { ignore: [path.join(dir, "visualice.routes.md")] });
    expect(s?.dirty).toBe(1);
    expect(s?.dirtyFiles).toEqual(["index.html"]);
  });

  it("is undefined outside a repository", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "vc-plain-"));
    try {
      expect(await readSource(plain)).toBeUndefined();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});
