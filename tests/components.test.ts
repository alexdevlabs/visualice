import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/shared/config";
import { withComponents } from "../src/crawl/orchestrator";
import { launchError, reusePlan } from "../src/crawl/capture";
import { rollupViolations } from "../src/crawl/accessibility";
import type { InputManifest } from "../src/shared/types";

const model = (): InputManifest => ({
  routes: ["/", "/blog/post", "/about"].map((url) => ({
    id: url,
    url,
    depth: 0,
    states: [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }],
  })),
});

const components = (raw: unknown[]) => ConfigSchema.parse({ components: raw }).components;

describe("withComponents", () => {
  it("adds an element state to every route the globs match", () => {
    const out = withComponents(
      model(),
      components([
        { name: "Site Header", selector: "header" },
        { name: "byline", selector: ".byline", routes: ["/blog/**"] },
      ]),
    );
    const ids = Object.fromEntries(out.routes.map((r) => [r.url, r.states.map((s) => s.id)]));
    expect(ids).toEqual({
      "/": ["default", "component-site-header"],
      "/blog/post": ["default", "component-site-header", "component-byline"],
      "/about": ["default", "component-site-header"],
    });
    const header = out.routes[0].states[1];
    expect(header).toMatchObject({ kind: "component", label: "Site Header", element: "header" });
  });

  it("leaves the model untouched — components are config, not discovery", () => {
    const input = model();
    withComponents(input, components([{ name: "nav", selector: "nav" }]));
    expect(input.routes[0].states).toHaveLength(1);
    expect(withComponents(input, [])).toBe(input);
  });

  it("does not shadow a hand-authored state with the same id", () => {
    const input = model();
    input.routes[0].states.push({
      id: "component-nav",
      kind: "component",
      label: "Nav, opened",
      recipe: [{ action: "click", target: { selector: "#menu" } }],
      element: "nav",
      shots: {},
    });
    const out = withComponents(input, components([{ name: "nav", selector: "nav" }]));
    expect(out.routes[0].states.filter((s) => s.id === "component-nav")).toHaveLength(1);
    expect(out.routes[0].states[1].label).toBe("Nav, opened");
  });
});

describe("reusePlan for a page already showing the recipe", () => {
  const recipe = [{ action: "click" as const, target: { selector: "#menu" } }];
  it("still reloads for a page state, but not for a component of it", () => {
    const shown = { url: "/x", recipe };
    expect(reusePlan(shown, "/x", recipe)).toBeNull();
    expect(reusePlan(shown, "/x", recipe, true)).toEqual([]);
    expect(reusePlan({ url: "/x", recipe: [] }, "/x", [], true)).toEqual([]);
    expect(reusePlan(shown, "/y", recipe, true)).toBeNull();
  });
});

describe("rollupViolations", () => {
  const v = (id: string, impact: "minor" | "serious" | "critical", count: number) => ({
    id,
    impact,
    help: id,
    count,
    targets: [],
  });
  it("groups by rule, counts shots and elements, worst first", () => {
    const rolled = rollupViolations([
      [v("color-contrast", "serious", 3), v("region", "minor", 1)],
      [v("color-contrast", "serious", 2), v("image-alt", "critical", 1)],
      [],
    ]);
    expect(rolled.map((r) => [r.id, r.shots, r.elements])).toEqual([
      ["image-alt", 1, 1],
      ["color-contrast", 2, 5],
      ["region", 1, 1],
    ]);
  });
});

describe("launchError", () => {
  it("names the engine and the one command that installs it", () => {
    const raw = new Error(
      "browserType.launch: Executable doesn't exist at /x/firefox\n╔═══╗\n║ npx playwright install ║",
    );
    expect(launchError("firefox", raw).message).toBe(
      "the firefox browser isn't installed — run 'npx playwright install firefox'",
    );
  });
  it("leaves any other launch failure as it was", () => {
    const raw = new Error("browserType.launch: Target page, context or browser has been closed");
    expect(launchError("webkit", raw)).toBe(raw);
  });
});
