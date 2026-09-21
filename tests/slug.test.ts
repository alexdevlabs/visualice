import { describe, it, expect } from "vitest";
import { pathSlug, stateSlug } from "../src/shared/slug";

describe("pathSlug", () => {
  it("maps root to home", () => {
    expect(pathSlug("/")).toBe("home");
    expect(pathSlug("http://x/")).toBe("home");
  });
  it("nests path segments", () => {
    expect(pathSlug("/blog/post-1")).toBe("blog/post-1");
    expect(pathSlug("/About/Us/")).toBe("about/us");
  });
  it("hashes query strings to keep distinct states separate", () => {
    expect(pathSlug("/search?q=a")).not.toBe(pathSlug("/search?q=b"));
    expect(pathSlug("/search?q=a")).toMatch(/^search__q-[0-9a-f]{6}$/);
  });

  it("gives every route of a hash-routed SPA its own folder", () => {
    // They all share one pathname, so without the suffix they'd overwrite each other.
    expect(pathSlug("/#/about")).toBe("home__h-about");
    expect(pathSlug("/#/users/42")).toBe("home__h-users-42");
    expect(pathSlug("/#!/about")).toBe("home__h-about");
    expect(pathSlug("/#/about")).not.toBe(pathSlug("/#/pricing"));
  });

  it("keeps a client route distinct from the server path it sits under", () => {
    expect(pathSlug("/app#/settings")).toBe("app__h-settings");
    expect(pathSlug("/app#/settings")).not.toBe(pathSlug("/app/settings"));
  });

  it("carries both a query and a fragment", () => {
    expect(pathSlug("/app?lang=en#/users/42")).toMatch(/^app__q-[0-9a-f]{6}__h-users-42$/);
  });

  it("ignores a fragment that isn't there", () => {
    expect(pathSlug("/about#")).toBe("about");
    expect(pathSlug("/#/")).toBe("home");
  });
});

describe("stateSlug", () => {
  it("sanitizes ids", () => {
    expect(stateSlug("Modal: Sign In")).toBe("modal-sign-in");
    expect(stateSlug("menu-open")).toBe("menu-open");
  });
});
