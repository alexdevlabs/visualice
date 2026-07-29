import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigSchema, loadConfig } from "../src/shared/config";
import { renderConfigJsonSchema } from "../src/shared/schema";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("ConfigSchema defaults", () => {
  it("fills every nested section from an empty object", () => {
    const c = ConfigSchema.parse({});
    expect(c.scope.include).toEqual(["/**"]);
    expect(c.discovery.interactions.nestDepth).toBe(1);
    expect(c.discovery.interactions.denyLabels).toContain("logout");
    expect(c.screenshot.thumbnail.format).toBe("webp");
    expect(c.stabilize.waitStrategy).toBe("networkidle");
    expect(c.politeness.respectRobots).toBe(true);
    expect(c.output.keepRuns).toBe(5);
    expect(c.devices.map((d) => d.name)).toEqual(["desktop", "mobile"]);
  });

  it("merges partial sections without dropping sibling defaults", () => {
    const c = ConfigSchema.parse({ scope: { maxPages: 3 } });
    expect(c.scope.maxPages).toBe(3);
    expect(c.scope.maxDepth).toBe(4);
    expect(c.scope.sameOriginOnly).toBe(true);
  });

  it("rejects invalid values instead of silently defaulting", () => {
    expect(() => ConfigSchema.parse({ politeness: { concurrency: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ screenshot: { format: "gif" } })).toThrow();
  });

  it("ignores unknown keys so JSON configs can carry a $schema pointer", () => {
    const c = ConfigSchema.parse({ $schema: "./config.schema.json", target: "https://x.test" });
    expect(c.target).toBe("https://x.test");
    expect("$schema" in c).toBe(false);
  });
});

describe("loadConfig", () => {
  it("returns pure defaults when no file is given", async () => {
    expect(await loadConfig()).toEqual(ConfigSchema.parse({}));
  });

  it("reads a JSON config from disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-config-"));
    try {
      const file = path.join(dir, "visualice.config.json");
      await fs.writeFile(file, JSON.stringify({ target: "https://x.test", seeds: ["/a"] }));
      const c = await loadConfig(file);
      expect(c.target).toBe("https://x.test");
      expect(c.seeds).toEqual(["/a"]);
      expect(c.politeness.timeoutMs).toBe(30000); // defaults still applied
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("loads the example TS config at the repo root", async () => {
    const c = await loadConfig(path.join(ROOT, "visualice.config.ts"));
    expect(c.devices.length).toBeGreaterThan(1);
    expect(c.stabilize.freezeTime).toBeTruthy();
  });
});

describe("config.schema.json", () => {
  it("is in sync with the zod schema (run `npm run schema`)", async () => {
    const onDisk = await fs.readFile(path.join(ROOT, "config.schema.json"), "utf8");
    expect(onDisk).toBe(renderConfigJsonSchema());
  });
});
