import { describe, expect, it } from "vitest";
import {
  InputManifestSchema,
  parseInputManifest,
  formatManifestIssues,
} from "../src/shared/manifest-schema";
import { renderExploreJsonSchema, renderManifestJsonSchema } from "../src/shared/schema";
import { promises as fs } from "node:fs";
import path from "node:path";

const minimalState = (id: string, extra: object = {}) => ({
  id,
  kind: "modal",
  label: id,
  recipe: [{ action: "click", target: { role: "button", name: "Open" } }],
  shots: {},
  ...extra,
});

const minimalManifest = () => ({
  routes: [
    {
      id: "home",
      url: "/",
      depth: 0,
      states: [minimalState("default", { kind: "default", recipe: [] })],
    },
  ],
});

describe("InputManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    expect(InputManifestSchema.safeParse(minimalManifest()).success).toBe(true);
  });

  it("fills defaults for hand-authored entries (shots, recipe, depth, kind)", () => {
    const parsed = parseInputManifest(
      { routes: [{ id: "r", url: "/x", states: [{ id: "s" }] }] },
      "test",
    );
    const state = parsed.routes[0].states[0];
    expect(state.shots).toEqual({});
    expect(state.recipe).toEqual([]);
    expect(state.kind).toBe("other");
    expect(parsed.routes[0].depth).toBe(0);
  });

  it("accepts the devices restriction on a state", () => {
    const m = minimalManifest();
    m.routes[0].states.push(minimalState("menu", { devices: ["mobile"] }));
    const parsed = parseInputManifest(m, "test");
    expect(parsed.routes[0].states[1].devices).toEqual(["mobile"]);
  });

  it("accepts isolate and select steps on an authored state", () => {
    const m = minimalManifest();
    m.routes[0].states.push(
      minimalState("sorted", {
        isolate: true,
        recipe: [{ action: "select", target: { testId: "sort" }, value: "lohi" }],
      }),
    );
    const parsed = parseInputManifest(m, "test");
    expect(parsed.routes[0].states[1].isolate).toBe(true);
    expect(parsed.routes[0].states[1].recipe[0]).toMatchObject({ action: "select", value: "lohi" });
  });

  it("rejects an unknown recipe action with a pointed path", () => {
    const m = minimalManifest();
    m.routes[0].states[0].recipe = [{ action: "clik", target: {} } as never];
    const result = InputManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    const issues = formatManifestIssues(result.error!);
    expect(issues.join("\n")).toContain("routes[0].states[0].recipe[0]");
  });

  it("rejects duplicate state ids on one route", () => {
    const m = minimalManifest();
    m.routes[0].states.push(minimalState("default"));
    const result = InputManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    expect(formatManifestIssues(result.error!).join("\n")).toContain(
      'duplicate state id "default"',
    );
  });

  it("rejects duplicate route ids", () => {
    const m = minimalManifest();
    m.routes.push({ ...minimalManifest().routes[0] });
    const result = InputManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    expect(formatManifestIssues(result.error!).join("\n")).toContain('duplicate route id "home"');
  });

  it("parseInputManifest lists every issue, not just the first", () => {
    const bad = {
      routes: [
        { id: "", url: "", states: [] },
        { id: "b", url: "/b", states: [{ id: "" }] },
      ],
    };
    expect(() => parseInputManifest(bad, "x.json")).toThrow(/invalid manifest x\.json:/);
    try {
      parseInputManifest(bad, "x.json");
    } catch (e) {
      const lines = (e as Error).message.split("\n");
      expect(lines.length).toBeGreaterThan(2);
    }
  });
});

describe("manifest.schema.json drift", () => {
  it("checked-in schema matches the zod schema", async () => {
    const file = path.resolve(__dirname, "..", "manifest.schema.json");
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe(renderManifestJsonSchema());
  });
});

describe("explore.schema.json drift", () => {
  it("checked-in schema matches the zod schema", async () => {
    const file = path.resolve(__dirname, "..", "explore.schema.json");
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe(renderExploreJsonSchema());
  });
});
