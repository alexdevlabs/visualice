import { describe, it, expect } from "vitest";
import {
  canonicalPath,
  scopePath,
  routeId,
  dedupeLinks,
  relativeToOrigin,
  uniqueId,
} from "../src/shared/url";

const u = (href: string) => new URL(href, "https://site.test");

describe("scopePath", () => {
  it("strips trailing slashes but keeps the root", () => {
    expect(scopePath(u("/blog/"))).toBe("/blog");
    expect(scopePath(u("/blog///"))).toBe("/blog");
    expect(scopePath(u("/"))).toBe("/");
  });

  it("ignores the query and hash", () => {
    expect(scopePath(u("/blog?page=2#top"))).toBe("/blog");
  });
});

describe("canonicalPath", () => {
  it("drops the hash and normalizes trailing slashes", () => {
    expect(canonicalPath(u("/about/#team"))).toBe("/about");
  });

  it("keeps meaningful query params, sorted for a stable identity", () => {
    expect(canonicalPath(u("/search?b=2&a=1"))).toBe("/search?a=1&b=2");
    expect(canonicalPath(u("/search?a=1&b=2"))).toBe(canonicalPath(u("/search?b=2&a=1")));
  });

  it("drops tracking params so campaign links don't fork the crawl", () => {
    expect(canonicalPath(u("/?utm_source=x&utm_medium=y"))).toBe("/");
    expect(canonicalPath(u("/p?fbclid=abc&gclid=d&ref=nav"))).toBe("/p");
    expect(canonicalPath(u("/p?utm_source=x&page=2"))).toBe("/p?page=2");
  });

  it("encodes param values", () => {
    expect(canonicalPath(u("/s?q=a b&t=c/d"))).toBe("/s?q=a%20b&t=c%2Fd");
  });
});

describe("routeId", () => {
  it("flattens a path into one filesystem-safe token", () => {
    expect(routeId("/")).toBe("home");
    expect(routeId("/blog/post-1")).toBe("blog-post-1");
  });

  it("distinguishes routes that differ only by query", () => {
    expect(routeId("/s?a=1")).not.toBe(routeId("/s?a=2"));
  });
});

describe("dedupeLinks", () => {
  const origin = "https://site.test";

  it("canonicalizes, dedupes and drops other origins", () => {
    const links = [
      "https://site.test/a",
      "https://site.test/a/", // same route
      "https://site.test/a#frag", // same route
      "https://site.test/a?utm_source=x", // same route
      "https://other.test/a",
      "not a url",
    ];
    expect(dedupeLinks(links, origin)).toEqual(["/a"]);
  });

  it("keeps distinct query routes apart", () => {
    const links = ["https://site.test/s?q=1", "https://site.test/s?q=2"];
    expect(dedupeLinks(links, origin)).toHaveLength(2);
  });
});

describe("relativeToOrigin", () => {
  const origin = "https://site.test";

  it("reduces same-origin URLs to a canonical path", () => {
    expect(relativeToOrigin("https://site.test/a/?utm_source=x", origin)).toBe("/a");
    expect(relativeToOrigin("https://site.test/", origin)).toBe("/");
  });

  it("leaves off-origin URLs and unparseable values alone", () => {
    expect(relativeToOrigin("https://other.test/a", origin)).toBe("https://other.test/a");
    expect(relativeToOrigin("about:blank", origin)).toBe("about:blank");
  });
});

describe("uniqueId", () => {
  it("returns the base when free and suffixes when taken", () => {
    expect(uniqueId("home", [])).toBe("home");
    expect(uniqueId("home", ["home"])).toBe("home-2");
    expect(uniqueId("home", ["home", "home-2", "home-3"])).toBe("home-4");
  });
});
