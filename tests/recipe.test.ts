import { describe, it, expect, afterEach } from "vitest";
import type { Page } from "playwright";
import { applyRecipe, resolveUrl } from "../src/crawl/recipe";
import { resolveEnvSteps } from "../src/crawl/auth";
import { locatorFor, describeTarget } from "../src/shared/selectors";
import type { RecipeStep } from "../src/shared/types";

/**
 * A recording stand-in for a Playwright Page. Recipes are pure instruction
 * lists, so replaying them against a fake driver is enough to pin down the
 * translation from manifest JSON to browser calls — no browser needed.
 */
function fakePage() {
  const calls: string[] = [];
  const locator = (desc: string) => {
    const l = {
      click: async () => void calls.push(`click(${desc})`),
      hover: async () => void calls.push(`hover(${desc})`),
      fill: async (v: string) => void calls.push(`fill(${desc},${v})`),
      selectOption: async (v: string | string[]) =>
        void calls.push(`select(${desc},${[v].flat().join("+")})`),
      press: async (k: string) => void calls.push(`press(${desc},${k})`),
      first: () => l,
      filter: () => l,
      nth: (n: number) => locator(`${desc}#${n}`),
      waitFor: async (o: { state?: string; timeout?: number }) =>
        void calls.push(`waitFor(${desc},${o.state ?? "visible"})`),
    };
    return l;
  };
  const page = {
    calls,
    url: () => "https://site.test/current",
    goto: async (u: string) => void calls.push(`goto(${u})`),
    locator: (sel: string) => locator(`css=${sel}`),
    getByTestId: (id: string) => locator(`testid=${id}`),
    getByRole: (role: string, o?: { name?: string }) =>
      locator(o?.name ? `role=${role}[${o.name}]` : `role=${role}`),
    getByLabel: (l: string) => locator(`label=${l}`),
    getByText: (t: string) => locator(`text=${t}`),
    keyboard: { press: async (k: string) => void calls.push(`kbd(${k})`) },
    waitForURL: async (u: string) => void calls.push(`waitForURL(${u})`),
    waitForTimeout: async (ms: number) => void calls.push(`wait(${ms})`),
    evaluate: async (fn: unknown, arg?: unknown) =>
      void calls.push(`evaluate(${arg === undefined ? "" : String(arg)})`),
  };
  return page as unknown as Page & { calls: string[] };
}

describe("resolveUrl", () => {
  it("passes absolute URLs through and resolves relative ones against the base", () => {
    expect(resolveUrl("https://a.test", "https://b.test/x")).toBe("https://b.test/x");
    expect(resolveUrl("https://a.test/base/", "/x")).toBe("https://a.test/x");
    expect(resolveUrl("https://a.test", "/blog?p=1")).toBe("https://a.test/blog?p=1");
  });
});

describe("locatorFor", () => {
  it("prefers the most robust strategy available", () => {
    const p = fakePage();
    void locatorFor(p, { testId: "search", role: "button", name: "Search" }).click();
    void locatorFor(p, { role: "button", name: "Search" }).click();
    void locatorFor(p, { role: "dialog" }).click();
    void locatorFor(p, { label: "Email" }).click();
    void locatorFor(p, { text: "Read more" }).click();
    void locatorFor(p, { selector: "#x" }).click();
    expect(p.calls).toEqual([
      "click(testid=search)",
      "click(role=button[Search])",
      "click(role=dialog)",
      "click(label=Email)",
      "click(text=Read more)",
      "click(css=#x)",
    ]);
  });

  it("applies nth and refuses an empty target", () => {
    const p = fakePage();
    void locatorFor(p, { role: "tab", nth: 2 }).click();
    expect(p.calls).toEqual(["click(role=tab#2)"]);
    expect(() => locatorFor(p, {})).toThrow(/Empty target/);
  });

  it("describes targets for logs", () => {
    expect(describeTarget({ role: "button", name: "Go" })).toBe('button:"Go"');
    expect(describeTarget({ testId: "t" })).toBe("testid=t");
    expect(describeTarget({})).toBe("?");
  });
});

describe("applyRecipe", () => {
  it("replays every step type in order", async () => {
    const p = fakePage();
    const recipe: RecipeStep[] = [
      { action: "navigate", url: "/login" },
      { action: "fill", target: { label: "Email" }, value: "a@b.c" },
      { action: "select", target: { testId: "sort" }, value: "lohi" },
      { action: "select", target: { label: "Tags" }, value: ["a", "b"] },
      { action: "click", target: { role: "button", name: "Sign in" } },
      { action: "hover", target: { testId: "menu" } },
      { action: "press", key: "Escape" },
      { action: "press", key: "Enter", target: { selector: "#q" } },
      { action: "waitFor", selector: "[role=dialog]", state: "visible" },
      { action: "waitFor", url: "**/dashboard" },
      { action: "scroll", to: "bottom" },
      { action: "wait", ms: 200 },
    ];
    await applyRecipe(p, recipe);
    expect(p.calls).toEqual([
      "goto(https://site.test/login)",
      "fill(label=Email,a@b.c)",
      "select(testid=sort,lohi)",
      "select(label=Tags,a+b)",
      "click(role=button[Sign in])",
      "hover(testid=menu)",
      "kbd(Escape)",
      "press(css=#q,Enter)",
      "waitFor(css=[role=dialog],visible)",
      "waitForURL(**/dashboard)",
      "evaluate()",
      "wait(200)",
    ]);
  });

  it("survives a round-trip through JSON, as the manifest stores it", async () => {
    const recipe: RecipeStep[] = [
      { action: "click", target: { role: "button", name: 'Open "Search"' } },
      { action: "waitFor", selector: '[id="search-modal"]', state: "visible" },
    ];
    const restored = JSON.parse(JSON.stringify(recipe)) as RecipeStep[];
    expect(restored).toEqual(recipe);

    const p = fakePage();
    await applyRecipe(p, restored);
    expect(p.calls).toEqual([
      // What's open before the click, in case the id it waits for has changed.
      "evaluate()",
      'click(role=button[Open "Search"])',
      'waitFor(css=[id="search-modal"],visible)',
    ]);
  });
});

describe("resolveEnvSteps", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("substitutes ${VAR} into fill values only", () => {
    process.env.VC_USER = "user@x.test";
    const steps: RecipeStep[] = [
      { action: "fill", target: { label: "Email" }, value: "${VC_USER}" },
      { action: "click", target: { role: "button", name: "${VC_USER}" } },
    ];
    const out = resolveEnvSteps(steps);
    expect(out[0]).toMatchObject({ value: "user@x.test" });
    expect(out[1]).toEqual(steps[1]); // non-fill steps untouched
  });

  it("throws rather than submitting blank credentials", () => {
    delete process.env.VC_MISSING;
    expect(() =>
      resolveEnvSteps([{ action: "fill", target: { label: "P" }, value: "${VC_MISSING}" }]),
    ).toThrow(/VC_MISSING/);
  });
});
