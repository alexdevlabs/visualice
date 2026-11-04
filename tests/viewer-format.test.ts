import { describe, expect, it } from "vitest";
import { liveUrl, runLabel } from "../viewer/src/format";

describe("runLabel", () => {
  it("reads a generated run id as a short date", () => {
    expect(runLabel("2026-09-21T01-49-07-123Z")).toBe("Sep 21, 01:49");
  });

  it("leaves a hand-named run alone", () => {
    expect(runLabel("baseline")).toBe("baseline");
  });
});

describe("liveUrl", () => {
  it("resolves a route against the crawled target", () => {
    expect(liveUrl("/about", { baseUrl: "https://x.com/app" })).toBe("https://x.com/about");
    expect(liveUrl("/app/cart", { baseUrl: "https://x.com/app" })).toBe("https://x.com/app/cart");
  });

  it("resolves under liveBase when the pages live elsewhere", () => {
    const site = { baseUrl: "http://localhost:4520", liveBase: "https://o.github.io/v/demo-site/" };
    expect(liveUrl("/about", site)).toBe("https://o.github.io/v/demo-site/about");
    expect(liveUrl("/", site)).toBe("https://o.github.io/v/demo-site/");
  });
});
