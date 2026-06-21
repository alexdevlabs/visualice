import { describe, it, expect } from "vitest";
import { globToRegExp, inScope } from "../src/shared/glob";

describe("globToRegExp", () => {
  it("`*` matches within a segment, not across slashes", () => {
    expect(globToRegExp("/a/*").test("/a/b")).toBe(true);
    expect(globToRegExp("/a/*").test("/a/b/c")).toBe(false);
  });

  it("`/**` matches the directory itself AND descendants", () => {
    const re = globToRegExp("/docs/**");
    expect(re.test("/docs")).toBe(true); // the regression we fixed
    expect(re.test("/docs/x")).toBe(true);
    expect(re.test("/docs/x/y")).toBe(true);
    expect(re.test("/other")).toBe(false);
  });

  it("`/**` at root matches everything", () => {
    const re = globToRegExp("/**");
    expect(re.test("/")).toBe(true);
    expect(re.test("/about")).toBe(true);
    expect(re.test("/blog/post-1")).toBe(true);
  });

  it("`/a/**/b` matches with zero or more intermediate segments", () => {
    const re = globToRegExp("/a/**/b");
    expect(re.test("/a/b")).toBe(true);
    expect(re.test("/a/x/b")).toBe(true);
  });
});

describe("inScope", () => {
  it("excludes win over includes, and section roots are in scope", () => {
    expect(inScope("/docs", ["/docs/**"], [])).toBe(true);
    expect(inScope("/admin", ["/**"], ["/admin/**"])).toBe(false);
    expect(inScope("/admin/users", ["/**"], ["/admin/**"])).toBe(false);
    expect(inScope("/about", ["/**"], ["/admin/**"])).toBe(true);
  });
});
