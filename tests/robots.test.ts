import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed, robotsPatternToRegExp, ROBOTS_UA } from "../src/shared/robots";

const allows = (txt: string, path: string, ua = ROBOTS_UA) => isAllowed(path, parseRobots(txt, ua));

describe("robots pattern matching", () => {
  it("treats * as any run of characters and matches by prefix", () => {
    const re = robotsPatternToRegExp("/a/*/c");
    expect(re.test("/a/b/c")).toBe(true);
    expect(re.test("/a/b/c/d")).toBe(true); // prefix match, no implicit end anchor
    expect(re.test("/a/c")).toBe(false);
  });

  it("anchors the end on a trailing $", () => {
    const re = robotsPatternToRegExp("/*.pdf$");
    expect(re.test("/docs/x.pdf")).toBe(true);
    expect(re.test("/docs/x.pdf?v=1")).toBe(false);
  });

  it("escapes regex metacharacters in literal paths", () => {
    const re = robotsPatternToRegExp("/a+b(c)");
    expect(re.test("/a+b(c)")).toBe(true);
    expect(re.test("/aab c")).toBe(false);
  });
});

describe("parseRobots / isAllowed", () => {
  it("allows everything when there are no rules", () => {
    expect(allows("", "/anything")).toBe(true);
  });

  it("applies the wildcard group's disallow rules", () => {
    const txt = `User-agent: *\nDisallow: /admin\n`;
    expect(allows(txt, "/admin")).toBe(false);
    expect(allows(txt, "/admin/users")).toBe(false); // prefix rule covers descendants
    expect(allows(txt, "/public")).toBe(true);
  });

  it("lets the longest matching rule win, with Allow breaking ties", () => {
    const txt = `User-agent: *\nDisallow: /docs\nAllow: /docs/public\n`;
    expect(allows(txt, "/docs/private")).toBe(false);
    expect(allows(txt, "/docs/public/intro")).toBe(true);

    const tie = `User-agent: *\nDisallow: /x\nAllow: /x\n`;
    expect(allows(tie, "/x")).toBe(true);
  });

  it("treats an empty Disallow as 'nothing is blocked'", () => {
    expect(allows(`User-agent: *\nDisallow:\n`, "/anything")).toBe(true);
  });

  it("prefers the most specific user-agent group and ignores others", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /",
      "",
      `User-agent: ${ROBOTS_UA}`,
      "Disallow: /private",
    ].join("\n");
    expect(allows(txt, "/anything")).toBe(true); // our named group wins over *
    expect(allows(txt, "/private")).toBe(false);
    expect(allows(txt, "/anything", "SomeOtherBot")).toBe(false); // falls back to *
  });

  it("merges consecutive user-agent lines into one group", () => {
    const txt = `User-agent: googlebot\nUser-agent: ${ROBOTS_UA}\nDisallow: /nope\n`;
    expect(allows(txt, "/nope")).toBe(false);
    expect(allows(txt, "/yep")).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    const txt = `# hello\nUser-agent: *   # everyone\nDisallow: /admin # secret\n`;
    expect(allows(txt, "/admin")).toBe(false);
  });

  it("collects sitemaps and crawl-delay", () => {
    const txt = [
      "Sitemap: https://example.com/sitemap.xml",
      `User-agent: ${ROBOTS_UA}`,
      "Crawl-delay: 1.5",
      "Disallow: /x",
    ].join("\n");
    const r = parseRobots(txt);
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(r.crawlDelayMs).toBe(1500);
  });

  it("matches query strings too", () => {
    const txt = `User-agent: *\nDisallow: /*?sort=\n`;
    expect(allows(txt, "/products?sort=price")).toBe(false);
    expect(allows(txt, "/products")).toBe(true);
  });
});
