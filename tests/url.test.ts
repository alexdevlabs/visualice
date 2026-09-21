import { describe, it, expect } from "vitest";
import {
  canonicalPath,
  hashPart,
  isHashRoute,
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

describe("isHashRoute", () => {
  it("recognises the two shapes a hash router uses", () => {
    expect(isHashRoute("#/about")).toBe(true);
    expect(isHashRoute("#!/about")).toBe(true);
    expect(isHashRoute("#/users/42")).toBe(true);
  });

  it("does not mistake an in-page anchor for a route", () => {
    expect(isHashRoute("#pricing")).toBe(false);
    expect(isHashRoute("#")).toBe(false);
    expect(isHashRoute("")).toBe(false);
    // The router's own root, which is the same page as no fragment at all.
    expect(isHashRoute("#/")).toBe(false);
  });
});

describe("hashPart", () => {
  it("ignores the fragment entirely by default", () => {
    expect(hashPart(u("/#/about"))).toBe("");
    expect(hashPart(u("/#/about"), "never")).toBe("");
  });

  it("takes router-shaped fragments under `auto`, and nothing else", () => {
    expect(hashPart(u("/#/about"), "auto")).toBe("#/about");
    expect(hashPart(u("/#!/about"), "auto")).toBe("#!/about");
    expect(hashPart(u("/docs#installation"), "auto")).toBe("");
  });

  it("takes any fragment under `always`", () => {
    expect(hashPart(u("/#about"), "always")).toBe("#about");
    expect(hashPart(u("/#/about"), "always")).toBe("#/about");
  });

  it("folds the router's home onto the page itself", () => {
    // `/`, `/#`, `/#/` and `/#!/` are one page, and capturing four of it is waste.
    for (const mode of ["auto", "always"] as const) {
      expect(hashPart(u("/#"), mode)).toBe("");
      expect(hashPart(u("/#/"), mode)).toBe("");
      expect(hashPart(u("/#!/"), mode)).toBe("");
    }
  });

  it("normalizes a trailing slash, so one route isn't crawled twice", () => {
    expect(hashPart(u("/#/about/"), "auto")).toBe("#/about");
  });
});

describe("canonicalPath with hash routes", () => {
  it("separates the routes of a hash-routed SPA", () => {
    expect(canonicalPath(u("/#/about"), "auto")).toBe("/#/about");
    expect(canonicalPath(u("/#/pricing"), "auto")).toBe("/#/pricing");
    // …which is exactly what collapses without it.
    expect(canonicalPath(u("/#/about"))).toBe(canonicalPath(u("/#/pricing")));
  });

  it("writes path, query then fragment, so the result is still a usable URL", () => {
    expect(canonicalPath(u("/app?lang=en#/users/42"), "auto")).toBe("/app?lang=en#/users/42");
    expect(
      new URL(canonicalPath(u("/app?lang=en#/users/42"), "auto"), "https://site.test").href,
    ).toBe("https://site.test/app?lang=en#/users/42");
  });

  it("leaves an anchor on a server-rendered page alone", () => {
    expect(canonicalPath(u("/docs#installation"), "auto")).toBe("/docs");
  });
});

describe("scopePath with hash routes", () => {
  it("exposes the fragment to include/exclude globs", () => {
    expect(scopePath(u("/#/admin/users"), "auto")).toBe("/#/admin/users");
    // `/#/admin/**` reaches it, which is the point — a hash-routed admin area can
    // be excluded by the same globs as a server-rendered one.
    expect(scopePath(u("/#/admin/users"), "auto").startsWith("/#/admin/")).toBe(true);
  });

  it("keeps a query that lives inside the fragment", () => {
    // Everything after the first `#` is fragment, so this query belongs to the
    // client route — and `#/users?page=2` really is a different view from `#/users`.
    expect(scopePath(u("/#/users?page=2"), "auto")).toBe("/#/users?page=2");
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
