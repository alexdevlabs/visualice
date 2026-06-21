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
});

describe("stateSlug", () => {
  it("sanitizes ids", () => {
    expect(stateSlug("Modal: Sign In")).toBe("modal-sign-in");
    expect(stateSlug("menu-open")).toBe("menu-open");
  });
});
