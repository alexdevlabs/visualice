import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchesAny } from "../src/shared/glob";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeChanges,
  globalReason,
  guessPattern,
  guessRoute,
  parseNameStatus,
  patternMatches,
  shellQuote,
} from "../src/crawl/changes";
import { readSource } from "../src/crawl/source";

const pattern = (file: string) => {
  const g = guessRoute(file);
  return g ? guessPattern(g) : undefined;
};

describe("file-based routing", () => {
  it("maps Next.js app router files", () => {
    expect(pattern("app/page.tsx")).toBe("/");
    expect(pattern("src/app/blog/[slug]/page.tsx")).toBe("/blog/*");
    expect(pattern("app/(marketing)/pricing/page.tsx")).toBe("/pricing");
    expect(pattern("app/docs/layout.tsx")).toBe("/docs/**");
    expect(pattern("app/shop/[...all]/page.tsx")).toBe("/shop/**");
    expect(pattern("app/api/users/route.ts")).toBeUndefined();
  });

  it("takes a file for a page only by its whole name", () => {
    // Shared code that happens to end in "page", "layout" or "error".
    expect(pattern("app/components/homepage.tsx")).toBeUndefined();
    expect(pattern("src/app/hooks/use-layout.ts")).toBeUndefined();
    expect(pattern("app/lib/format-error.ts")).toBeUndefined();
    expect(pattern("src/routes/shop/my+page.svelte")).toBeUndefined();
    expect(pattern("src/routes/shop/+page.svelte")).toBe("/shop");
  });

  it("maps pages folders, SvelteKit, Remix and plain HTML", () => {
    expect(pattern("pages/about.tsx")).toBe("/about");
    expect(pattern("src/pages/blog/index.astro")).toBe("/blog");
    expect(pattern("pages/_app.tsx")).toBeUndefined();
    expect(pattern("src/routes/blog/[slug]/+page.svelte")).toBe("/blog/*");
    expect(pattern("src/routes/admin/+layout.svelte")).toBe("/admin/**");
    expect(pattern("app/routes/blog.$slug.tsx")).toBe("/blog/*");
    expect(pattern("app/routes/_index.tsx")).toBe("/");
    expect(pattern("about.html")).toBe("/about");
    expect(pattern("public/docs/index.html")).toBe("/docs");
  });

  it("matches patterns against catalogue pages", () => {
    expect(patternMatches("/blog/*", "/blog/hello")).toBe(true);
    expect(patternMatches("/blog/*", "/blog")).toBe(false);
    // The same rules the crawl applies to --only (shared/glob):
    for (const [pattern, page] of [
      ["/blog/*", "/blog/hello"],
      ["/docs/**", "/docs"],
      ["/docs/**", "/docs/a/b"],
      ["/blog/*", "/blog/a/b"],
    ])
      expect(patternMatches(pattern, page), `${pattern} ${page}`).toBe(matchesAny(page, [pattern]));
    expect(patternMatches("/docs/**", "/docs")).toBe(true);
    expect(patternMatches("/docs/**", "/docs/a/b")).toBe(true);
    expect(patternMatches("/**", "/anything")).toBe(true);
    expect(patternMatches("/about", "/about.html")).toBe(true);
    expect(patternMatches("/", "/")).toBe(true);
  });
});

describe("global files", () => {
  it("names the changes that reach every page", () => {
    expect(globalReason("package.json")).toBe("dependencies");
    expect(globalReason("tailwind.config.ts")).toBe("build or theme config");
    expect(globalReason("src/app/layout.tsx")).toBe("root layout or entry point");
    expect(globalReason("src/styles/buttons.css")).toBe("global styles or theme");
    expect(globalReason("app/globals.css")).toBe("global styles");
    expect(globalReason("src/components/Header.tsx")).toMatch(/chrome/);
    expect(globalReason("visualice.config.json")).toBe("visualice config");
  });

  it("leaves page files and local components alone", () => {
    expect(globalReason("app/pricing/page.tsx")).toBeUndefined();
    // A nested layout wraps its own section only; routing maps it below.
    expect(globalReason("app/blog/layout.tsx")).toBeUndefined();
    expect(globalReason("src/app/(shop)/cart/layout.tsx")).toBeUndefined();
    expect(globalReason("src/components/layout.tsx")).toMatch(/chrome/);
    expect(globalReason("src/components/PricingCard.tsx")).toBeUndefined();
    expect(globalReason("src/components/card/index.css")).toBeUndefined();
    expect(globalReason("packages/ui/package.json")).toBeUndefined();
  });
});

it("quotes a suggested --only value only when a shell would expand it", () => {
  expect(shellQuote("/about,/pricing")).toBe("/about,/pricing");
  expect(shellQuote("/blog/*,/about")).toBe("'/blog/*,/about'");
  expect(shellQuote("/it's")).toBe("'/it'\\''s'");
});

it("parses name-status output with renames", () => {
  expect(parseNameStatus("M\0a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0")).toEqual([
    { status: "M", path: "a.ts" },
    { status: "R", from: "old.ts", path: "new.ts" },
    { status: "A", path: "b.ts" },
  ]);
});

describe("computeChanges", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: dir,
    }).toString();
  const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), text);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-qm", msg);
  };
  const pages = ["/", "/about", "/blog", "/blog/hello", "/pricing"];
  const run = async (recorded: typeof baseline | null = baseline) =>
    computeChanges({
      cwd: dir,
      recorded: recorded ?? undefined,
      ignore: [path.join(dir, ".visualice"), path.join(dir, "visualice.routes.md")],
      pages,
    });
  let baseline: Awaited<ReturnType<typeof readSource>>;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vc-changes-")));
    git("init", "-q", "-b", "main");
    await write("app/page.tsx", "home");
    await write("app/about/page.tsx", "about");
    await write("app/blog/[slug]/page.tsx", "post");
    await write("src/components/Card.tsx", "card");
    commit("init");
    baseline = await readSource(dir, { target: "http://localhost:3000/" });
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("is none when nothing that counts changed", async () => {
    await write("visualice.routes.md", "# Routes");
    commit("catalogue");
    const r = await run();
    expect(r.verdict).toBe("none");
    expect(r.commitCount).toBe(1);
    expect(r.files).toEqual([]);
  });

  it("is partial with page candidates, and suggests --only", async () => {
    await write("app/about/page.tsx", "about v2");
    await write("app/pricing/page.tsx", "new page");
    commit("about + pricing");
    const r = await run();
    expect(r.verdict).toBe("partial");
    expect(r.candidates.map((c) => [c.file, c.pages])).toEqual([
      ["app/about/page.tsx", ["/about"]],
      ["app/pricing/page.tsx", ["/pricing"]],
    ]);
    expect(r.suggest?.only).toEqual(["/about", "/pricing"]);
    expect(r.commits[0].subject).toBe("about + pricing");
  });

  it("counts uncommitted and untracked files, and leaves the trace to the agent", async () => {
    await write("src/components/Card.tsx", "card v2");
    await write("src/components/New.tsx", "new");
    const r = await run();
    expect(r.verdict).toBe("partial");
    expect(r.unmapped.sort()).toEqual(["src/components/Card.tsx", "src/components/New.tsx"]);
    expect(r.suggest).toBeUndefined();
  });

  it("maps a nested layout to its section, and quotes a glob it suggests", async () => {
    await write("app/blog/layout.tsx", "blog shell");
    commit("blog layout");
    const r = await run();
    expect(r.verdict).toBe("partial");
    expect(r.candidates[0]).toMatchObject({ pattern: "/blog/**", kind: "layout" });
    expect(r.suggest?.only).toEqual(["/blog", "/blog/hello"]);

    await write("app/shop/[id]/page.tsx", "product");
    commit("shop");
    const next = await run();
    expect(next.suggest?.command).toBe(
      "visualice crawl --replay --only='/blog,/blog/hello,/shop/*'",
    );
  });

  it("counts a rename as one uncommitted change", async () => {
    git("mv", "src/components/Card.tsx", "src/components/Tile.tsx");
    expect((await run()).head?.dirty).toBe(1);
  });

  it("is full when the record's list of dirty files was cut short", async () => {
    const r = await computeChanges({
      cwd: dir,
      recorded: { ...baseline!, dirty: 250 },
      runSource: { ...baseline!, dirty: 250, dirtyFiles: ["app/page.tsx"] },
      ignore: [],
      pages,
    });
    expect(r.verdict).toBe("full");
    expect(r.reasons.some((x) => x.includes("can't all be listed"))).toBe(true);
  });

  it("is full when a global file changed", async () => {
    await write("package.json", "{}");
    await write("app/about/page.tsx", "about v2");
    commit("deps");
    const r = await run();
    expect(r.verdict).toBe("full");
    expect(r.global).toEqual([{ path: "package.json", reason: "dependencies" }]);
    expect(r.suggest?.command).toBe("visualice crawl");
  });

  it("is unknown without a record or with a commit that isn't there", async () => {
    expect((await run(null)).verdict).toBe("unknown");
    const gone = await run({ ...baseline!, commit: "f".repeat(40) });
    expect(gone.verdict).toBe("unknown");
    expect(gone.reasons[0]).toMatch(/isn't in this repository/);
  });

  it("warns when the catalogue was shot from a deployed site", async () => {
    await write("app/about/page.tsx", "about v2");
    commit("about");
    const r = await run({ ...baseline!, target: "https://example.com/", local: false });
    expect(r.reasons.some((x) => x.includes("not a local server"))).toBe(true);
  });

  it("compares against the newest run here when the routes file records another commit", async () => {
    // A routes file pulled from a teammate records their commit; the shots on this
    // computer, which a partial run carries over, are from an older one.
    const mine = baseline!;
    await write("app/about/page.tsx", "about v2");
    commit("about");
    const theirs = await readSource(dir, { target: "http://localhost:3000/" });
    await write("app/page.tsx", "home v2");
    commit("home");
    const r = await computeChanges({
      cwd: dir,
      recorded: theirs!,
      localRun: mine,
      ignore: [],
      pages,
    });
    expect(r.baseline?.commit).toBe(mine.commit);
    expect(r.baseline?.from).toBe("run");
    expect(r.candidates.map((c) => c.file).sort()).toEqual(["app/about/page.tsx", "app/page.tsx"]);
    expect(r.reasons.some((x) => x.includes("newest run on this computer"))).toBe(true);
    // The same commit in both: the routes file's record stands.
    const same = await computeChanges({
      cwd: dir,
      recorded: theirs!,
      localRun: theirs!,
      ignore: [],
      pages,
    });
    expect(same.baseline?.from).toBe("routes-file");
    expect(same.candidates.map((c) => c.file)).toEqual(["app/page.tsx"]);
  });

  describe("in a monorepo, with the project in a folder of the repository", () => {
    const web = () => path.join(dir, "apps", "web");
    const inWeb = () =>
      computeChanges({ cwd: web(), recorded: baseline!, ignore: [], pages: ["/", "/pricing"] });

    beforeEach(async () => {
      await write("package.json", "{}");
      await write("apps/web/package.json", "{}");
      await write("apps/web/app/pricing/page.tsx", "pricing");
      await write("apps/web/app/blog/layout.tsx", "blog layout");
      await write("packages/ui/Button.tsx", "button");
      commit("monorepo");
      baseline = await readSource(dir, { target: "http://localhost:3000/" });
    });

    it("maps the project's files by their path inside it", async () => {
      await write("apps/web/app/pricing/page.tsx", "pricing v2");
      await write("apps/web/app/blog/layout.tsx", "blog layout v2");
      const r = await inWeb();
      expect(r.verdict).toBe("partial");
      expect(r.global).toEqual([]);
      expect(r.candidates.map((c) => [c.file, c.pattern])).toEqual([
        ["apps/web/app/blog/layout.tsx", "/blog/**"],
        ["apps/web/app/pricing/page.tsx", "/pricing"],
      ]);
    });

    it("is full for the project's own dependencies, and the repository's", async () => {
      await write("apps/web/package.json", '{"a":1}');
      expect((await inWeb()).global).toEqual([
        { path: "apps/web/package.json", reason: "dependencies" },
      ]);
      git("checkout", "-q", "--", ".");
      await write("package.json", '{"a":1}');
      expect((await inWeb()).verdict).toBe("full");
    });

    it("leaves a file outside the project to be traced", async () => {
      await write("packages/ui/Button.tsx", "button v2");
      await write("apps/admin/app/page.tsx", "another app's home");
      const r = await inWeb();
      expect(r.verdict).toBe("partial");
      expect(r.candidates).toEqual([]);
      expect(r.unmapped.sort()).toEqual(["apps/admin/app/page.tsx", "packages/ui/Button.tsx"]);
      expect(r.suggest).toBeUndefined();
    });
  });
});
