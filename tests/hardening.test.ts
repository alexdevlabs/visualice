import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp, inScope, routeMatches } from "../src/shared/glob";
import { denyPattern } from "../src/crawl/discover-states";
import { routeHref } from "../src/shared/url";
import { xmlText } from "../src/crawl/discover-routes";
import { ConfigSchema } from "../src/shared/config";
import { REDACTED, redactConfig, redactUrl } from "../src/shared/redact";
import { scrubSecrets, storageStateCovers } from "../src/crawl/auth";
import { parseRoutesFile, renderRoutesFile } from "../src/crawl/routes-file";
import { parseSourceLine } from "../src/crawl/source";
import { stateSlug } from "../src/shared/slug";
import { trimEndOf, trimOf } from "../src/shared/trim";
import { renderReport } from "../src/crawl/report";
import { findResumableRun, markRunIncomplete } from "../src/crawl/runs";
import { LockedError, acquireLock } from "../src/shared/lock";
import { guessRoute } from "../src/crawl/changes";
import { parsePorcelain } from "../src/crawl/source";
import { parseFlags, UsageError } from "../src/cli-args";
import { knownHost } from "../src/serve";
import { AuthoredFileSchema } from "../src/crawl/author";
import { liveUrl } from "../viewer/src/format";
import { readUrlState, serializeUrlState } from "../viewer/src/url-state";
import { parseViewerData } from "../viewer/src/load";
import type { InputManifest, Manifest, RecipeStep } from "../src/shared/types";

/**
 * Regressions from a scan of the whole codebase: places where an unusual but real
 * input (a path, a header, a file someone edited by hand) gave a wrong or unsafe
 * result. One case per defect, next to the function that had it.
 */

describe("globs", () => {
  it("match whole segments around a `/**/`", () => {
    const edit = globToRegExp("/blog/**/edit");
    expect(edit.test("/blog/edit")).toBe(true);
    expect(edit.test("/blog/2024/post/edit")).toBe(true);
    expect(edit.test("/blog/credit")).toBe(false);
    expect(edit.test("/blogedit")).toBe(false);
    expect(globToRegExp("/**/delete").test("/users/undelete")).toBe(false);
    expect(globToRegExp("/**/delete").test("/users/delete")).toBe(true);
    expect(globToRegExp("/a/**/b").test("/ab")).toBe(false);
  });
});

describe("loading a route", () => {
  it("puts the trailing slash back where the site serves the page with one", () => {
    expect(routeHref({ url: "/docs" })).toBe("/docs");
    expect(routeHref({ url: "/docs", trailingSlash: true })).toBe("/docs/");
    expect(routeHref({ url: "/docs?page=2", trailingSlash: true })).toBe("/docs/?page=2");
    expect(routeHref({ url: "/app#/about", trailingSlash: true })).toBe("/app/#/about");
    expect(routeHref({ url: "/", trailingSlash: true })).toBe("/");
  });
});

describe("sitemap entries", () => {
  it("are read as XML text", () => {
    expect(xmlText("https://x.test/a?b=1&amp;c=2")).toBe("https://x.test/a?b=1&c=2");
    expect(xmlText("https://x.test/caf&#233;")).toBe("https://x.test/café");
    expect(xmlText("https://x.test/a&#x26;b")).toBe("https://x.test/a&b");
    expect(xmlText("https://x.test/plain")).toBe("https://x.test/plain");
  });
});

describe("credentials in what a run writes", () => {
  it("are taken out of headers by any name, and out of URLs", () => {
    const out = redactConfig(
      ConfigSchema.parse({
        target: "https://user:hunter2@staging.example.com/app",
        http: {
          extraHTTPHeaders: {
            "x-vercel-protection-bypass": "abc",
            "CF-Access-Client-Id": "abc.access",
            "X-Preview": "1",
            "X-Build": "f3a9c2e1b7d04586a1c3e5f7092b4d6e",
            "X-Locale": "en-GB",
          },
          proxy: { server: "http://puser:ppass@proxy:3128" },
        },
        auth: {
          login: {
            url: "/login?token=s3cret&next=/home",
            steps: [
              { action: "navigate", url: "https://sso.test/start?ticket=abc123" },
              { action: "select", target: { label: "Tenant" }, value: "acme-internal" },
            ],
          },
        },
      }),
    );
    const text = JSON.stringify(out);
    for (const secret of ["hunter2", "ppass", "s3cret", "abc123", "acme-internal", "abc.access"]) {
      expect(text).not.toContain(secret);
    }
    expect(out.target).toBe("https://staging.example.com/app");
    expect(out.http.extraHTTPHeaders["x-vercel-protection-bypass"]).toBe(REDACTED);
    expect(out.http.extraHTTPHeaders["X-Preview"]).toBe(REDACTED);
    // A value that reads like a token goes, whatever its header is called.
    expect(out.http.extraHTTPHeaders["X-Build"]).toBe(REDACTED);
    expect(out.http.extraHTTPHeaders["X-Locale"]).toBe("en-GB");
  });

  it("keeps a URL a URL, and placeholders as they are", () => {
    expect(redactUrl("https://a:b@x.test/p?q=1")).toBe("https://x.test/p?q=1");
    expect(redactUrl("/login?token=abc&next=", true)).toBe(`/login?token=${REDACTED}&next=`);
    expect(redactUrl("/login?token=${TOKEN}", true)).toBe("/login?token=${TOKEN}");
    expect(redactUrl("${TARGET}")).toBe("${TARGET}");
  });

  it("never reach an error message from a failed login step", () => {
    const steps: RecipeStep[] = [
      { action: "fill", target: { label: "Email" }, value: "me@x.test" },
      { action: "fill", target: { label: "Password" }, value: 'S3cret"Passw0rd' },
    ];
    const message = `locator.fill: Timeout\n  - fill("S3cret\\"Passw0rd")\n  - fill("me@x.test")`;
    const out = scrubSecrets(message, steps);
    expect(out).not.toContain("S3cret");
    expect(out).not.toContain("me@x.test");
    expect(out).toContain("locator.fill: Timeout");
  });
});

describe("a saved session", () => {
  let dir: string;
  const write = async (state: unknown) => {
    const file = path.join(dir, "auth.json");
    await fs.writeFile(file, JSON.stringify(state));
    return file;
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-session-"));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("is this site's only when it has something for its host", async () => {
    const prod = await write({ cookies: [{ name: "sid", domain: ".example.com" }] });
    expect(await storageStateCovers(prod, "https://app.example.com/")).toBe(true);
    expect(await storageStateCovers(prod, "https://staging.other.test/")).toBe(false);
    const stored = await write({ cookies: [], origins: [{ origin: "http://localhost:3000" }] });
    expect(await storageStateCovers(stored, "http://localhost:3000/x")).toBe(true);
    expect(await storageStateCovers(stored, "http://localhost:4000/x")).toBe(false);
    // Nothing in it to belong elsewhere.
    expect(await storageStateCovers(await write({ cookies: [] }), "https://x.test")).toBe(true);
  });
});

describe("the routes file", () => {
  const canonical = (p: string) => p.replace(/\/+$/, "") || "/";
  const model: InputManifest = {
    version: 1,
    routes: [
      {
        id: "pricing",
        url: "/pricing",
        depth: 1,
        states: [
          { id: "default", kind: "default", label: "Default", recipe: [], shots: {} },
          {
            id: "menu-open",
            kind: "menu",
            label: "Menu",
            source: "auto",
            recipe: [{ action: "click", target: { role: "button", name: "Menu" } }],
            shots: {},
          },
        ],
      },
    ],
  } as InputManifest;

  it("takes a path typed with a trailing slash for the page it is", () => {
    const intent = parseRoutesFile("- /pricing/\n  - skip: menu-open\n  - [ ] promo\n", canonical);
    expect(intent.routes.map((r) => r.path)).toEqual(["/pricing"]);
    const text = renderRoutesFile(model, intent, "https://x.test");
    expect(text.match(/^- \/pricing/gm)).toHaveLength(1);
    expect(text).toContain("  - skip: menu-open");
  });

  it("merges a page listed twice instead of dropping the second one's lines", () => {
    const intent = parseRoutesFile("- /pricing\n- /pricing/\n  - [ ] promo\n", canonical);
    expect(intent.routes).toHaveLength(1);
    expect(intent.routes[0].states.map((s) => s.id)).toEqual(["promo"]);
  });

  it("obeys a skip written under the state's own line", () => {
    const intent = parseRoutesFile(
      '- /pricing\n  - menu-open — click "Menu"\n  - skip: menu-open\n',
    );
    expect(intent.routes[0].states).toEqual([
      expect.objectContaining({ id: "menu-open", skip: true }),
    ]);
    const text = renderRoutesFile(model, intent, "https://x.test");
    expect(text).toContain("  - skip: menu-open");
    expect(text).not.toContain("  - menu-open");
  });

  it("is never written with the credentials of a target URL", async () => {
    expect(redactUrl("https://user:pw@x.test/")).toBe("https://x.test/");
  });
});

describe("an authored state", () => {
  it("has a one-word id, which is how the routes file lists it", () => {
    const state = { kind: "modal", label: "Open", recipe: [], page: "/" };
    expect(AuthoredFileSchema.safeParse({ states: [{ ...state, id: "open-modal" }] }).success).toBe(
      true,
    );
    expect(AuthoredFileSchema.safeParse({ states: [{ ...state, id: "Open Modal" }] }).success).toBe(
      false,
    );
  });
});

describe("the report", () => {
  it("keeps its Routes table whole when a title has a pipe in it", () => {
    const report = renderReport({
      version: 1,
      site: { baseUrl: "https://x.test", origin: "https://x.test", runId: "r", generatedAt: "" },
      devices: [],
      routes: [{ id: "pricing", url: "/pricing", title: "Pricing | Acme", depth: 1, states: [] }],
      stats: { routes: 1, states: 0, shots: 0, failed: 0, durationMs: 0, failures: [] },
    } as unknown as Manifest);
    const row = report.split("\n").find((l) => l.startsWith("| `/pricing`"))!;
    expect(row).toContain("Pricing \\| Acme");
    expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(7);
  });
});

describe("resuming", () => {
  let out: string;
  const run = async (id: string, unfinished: boolean) => {
    const dir = path.join(out, "runs", id);
    await fs.mkdir(dir, { recursive: true });
    if (unfinished) await markRunIncomplete(dir);
  };
  beforeEach(async () => {
    out = await fs.mkdtemp(path.join(os.tmpdir(), "vc-resume-"));
  });
  afterEach(() => fs.rm(out, { recursive: true, force: true }));

  it("never goes back to an old unfinished run when newer ones finished", async () => {
    await run("2026-11-02T10-00-00-000Z", true);
    await run("2026-11-03T10-00-00-000Z", false);
    await run("2026-11-04T10-00-00-000Z", false);
    expect(await findResumableRun(out)).toBeUndefined();
    await run("2026-11-05T10-00-00-000Z", true);
    expect(await findResumableRun(out)).toBe("2026-11-05T10-00-00-000Z");
  });
});

describe("the output lock", () => {
  let out: string;
  beforeEach(async () => {
    out = await fs.mkdtemp(path.join(os.tmpdir(), "vc-lock-"));
  });
  afterEach(() => fs.rm(out, { recursive: true, force: true }));

  it("goes to exactly one of several that ask at once", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => acquireLock(out, { command: "crawl" })),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockedError);
    }
    // Whole from the moment it exists: never an empty file a second process calls dead.
    const files = await fs.readdir(out);
    expect(files.filter((f) => f.includes(".lock"))).toHaveLength(1);
    await (won[0] as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
  });
});

describe("what changed", () => {
  it("doesn't take a template, a component's markup or a build's output for a page", () => {
    expect(guessRoute("templates/base.html")).toBeUndefined();
    expect(guessRoute("src/app/hero/hero.component.html")).toBeUndefined();
    expect(guessRoute("coverage/index.html")).toBeUndefined();
    expect(guessRoute("_includes/nav.html")).toBeUndefined();
    expect(guessRoute("about.html")).toEqual({ segments: ["about"], kind: "page" });
    expect(guessRoute("public/blog/index.html")).toEqual({ segments: ["blog"], kind: "page" });
  });

  it("reads a rename git reports in the working tree", () => {
    expect(parsePorcelain(" R new.txt\0old.txt\0 M other.txt\0")).toEqual(["new.txt", "other.txt"]);
    expect(parsePorcelain("R  new.txt\0old.txt\0")).toEqual(["new.txt"]);
  });
});

describe("command-line arguments", () => {
  it("never take a mistyped flag for the URL or the page", () => {
    expect(() => parseFlags("crawl", ["-h"])).toThrow(UsageError);
    expect(() => parseFlags("crawl", ["-q"])).toThrow(/unknown flag -q/);
    expect(parseFlags("crawl", ["https://x.test"]).target).toBe("https://x.test");
  });
});

describe("the viewer server", () => {
  it("answers only to a name that is this machine's", () => {
    expect(knownHost("localhost:4520")).toBe(true);
    expect(knownHost("127.0.0.1:4520")).toBe(true);
    expect(knownHost("192.168.1.20:4520")).toBe(true);
    expect(knownHost("[::1]:4520")).toBe(true);
    expect(knownHost(`${os.hostname()}:4520`)).toBe(true);
    expect(knownHost("evil.example:4520")).toBe(false);
    expect(knownHost("localhost.evil.example")).toBe(false);
  });
});

describe("the viewer", () => {
  it("links to the live page only at a web address, and never throws building it", () => {
    const site = { baseUrl: "https://example.com" };
    expect(liveUrl("/about", site)).toBe("https://example.com/about");
    expect(liveUrl("javascript:alert(document.domain)", site)).toBeUndefined();
    expect(liveUrl("/about", { baseUrl: "example.com" })).toBeUndefined();
    expect(liveUrl("/about", { baseUrl: "x", liveBase: "javascript:alert(1)//" })).toBeUndefined();
    expect(
      liveUrl("https://example.com/about", { baseUrl: "x", liveBase: "https://docs.test/demo" }),
    ).toBe("https://example.com/about");
  });

  it("keeps a device name with a comma in it whole in a link", () => {
    const devices = ["Desktop, wide", "mobile", "50%"];
    expect(readUrlState(`?${serializeUrlState({ devices })}`).devices).toEqual(devices);
    expect(readUrlState("?devices=desktop,mobile").devices).toEqual(["desktop", "mobile"]);
  });

  it("knows a wide device is mobile when the run says so", () => {
    const data = parseViewerData({
      site: { baseUrl: "https://x.test", origin: "https://x.test" },
      devices: [{ name: "tablet", width: 820, height: 1180, dpr: 2, mobile: true }],
      tiles: [],
    });
    expect(data.devices[0].mobile).toBe(true);
  });
});

describe("denied labels", () => {
  const denies = (deny: string, label: string) => new RegExp(denyPattern(deny), "iu").test(label);

  it("match whole words, in any case", () => {
    expect(denies("import", "Import CSV")).toBe(true);
    expect(denies("import", "Bulk import")).toBe(true);
    expect(denies("import", "Re-import")).toBe(true);
    expect(denies("delete", "DELETE")).toBe(true);
    expect(denies("pay", "Pay now")).toBe(true);
  });

  it("don't match inside a longer word", () => {
    expect(denies("import", "Network Importers")).toBe(false);
    expect(denies("pay", "Payments")).toBe(false);
    expect(denies("run", "Truncate")).toBe(false);
    expect(denies("löschen", "Gelöschte")).toBe(false);
  });

  it("match a phrase across any whitespace, and take punctuation literally", () => {
    expect(denies("sign out", "Sign  out")).toBe(true);
    expect(denies("sign out", "Sign\nout")).toBe(true);
    expect(denies("sign out", "Design outline")).toBe(false);
    expect(denies("c++", "Open C++ docs")).toBe(true);
    expect(denies("a.b", "axb")).toBe(false);
  });
});

describe("scope globs and the query", () => {
  it("skip lines follow the same rule on a route's whole address", () => {
    expect(routeMatches("/metrics?network=A", ["/metrics"])).toBe(true);
    expect(routeMatches("/metrics?network=A", ["/metrics?*"])).toBe(true);
    expect(routeMatches("/metrics", ["/metrics?*"])).toBe(false);
    expect(routeMatches("/dev/tools?x=1", ["/dev/**"])).toBe(true);
    expect(routeMatches("/metrics", [])).toBe(false);
  });

  it("a plain glob is about the path, whatever the query", () => {
    expect(inScope("/search", [], ["/search"], "/search?q=1")).toBe(false);
    expect(inScope("/search", ["/search"], [], "/search?q=1")).toBe(true);
  });

  it("a glob with a ? matches the path and query, leaving the bare page in", () => {
    const exclude = ["/importers/metrics?*"];
    expect(inScope("/importers/metrics", [], exclude, "/importers/metrics?network=A&o=y")).toBe(
      false,
    );
    expect(inScope("/importers/metrics", [], exclude, "/importers/metrics")).toBe(true);
    expect(
      inScope(
        "/importers/metrics",
        [],
        ["/importers/metrics?network=A*"],
        "/importers/metrics?network=B",
      ),
    ).toBe(true);
  });
});

describe("parsing without slow patterns", () => {
  it("trims one character off the ends", () => {
    expect(trimEndOf("/a/b///", "/")).toBe("/a/b");
    expect(trimEndOf("///", "/")).toBe("");
    expect(trimOf("--a-b--", "-")).toBe("a-b");
    expect(trimOf("", "-")).toBe("");
  });

  it("hides parameter values the way the pattern did", () => {
    expect(redactUrl("https://x.test/a?b?c=d&e=f#g?h=i", true)).toBe(
      `https://x.test/a?b?c=${REDACTED}&e=${REDACTED}#g?h=${REDACTED}`,
    );
    expect(redactUrl("https://x.test/?=a?b=c&=d&flag&empty=", true)).toBe(
      `https://x.test/?=a?b=${REDACTED}&=d&flag&empty=`,
    );
  });

  it("stays quick on a long run of one character", () => {
    const started = Date.now();
    redactUrl("https://x.test/" + "?".repeat(200_000), true);
    stateSlug("a" + " -".repeat(200_000) + "b");
    parseRoutesFile("# Routes — a" + " ".repeat(200_000) + "b\n- /" + " ".repeat(200_000) + "x");
    parseSourceLine("<!-- visualice-source" + " ".repeat(200_000) + "x");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads a routes file with space around its lines", () => {
    const intent = parseRoutesFile(
      "# Routes —   https://x.test  \n-   /about   \n  - [ ]   menu  ",
    );
    expect(intent.target).toBe("https://x.test");
    expect(parseSourceLine("<!--visualice-source commit=abc1234 -->")?.commit).toBe("abc1234");
    expect(parseSourceLine("<!-- visualice-sourced commit=abc1234 -->")).toBeUndefined();
  });
});
