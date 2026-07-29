import { describe, expect, it } from "vitest";
import { parseFlags, applyOverrides, UsageError } from "../src/cli-args";
import { ConfigSchema } from "../src/shared/config";

describe("parseFlags", () => {
  it("parses --flag=value", () => {
    expect(parseFlags("crawl", ["--base=https://x.dev"])).toEqual({ base: "https://x.dev" });
  });

  it("parses --flag value (space form)", () => {
    expect(parseFlags("serve", ["--port", "8080"])).toEqual({ port: "8080" });
  });

  it("parses boolean flags", () => {
    expect(parseFlags("crawl", ["--replay", "--json"])).toEqual({ replay: true, json: true });
  });

  it("rejects unknown flags instead of silently ignoring them", () => {
    expect(() => parseFlags("crawl", ["--replya"])).toThrow(UsageError);
    expect(() => parseFlags("crawl", ["--replya"])).toThrow(/unknown flag --replya/);
  });

  it("rejects flags a command does not accept", () => {
    expect(() => parseFlags("auth", ["--port=80"])).toThrow(/unknown flag --port for 'auth'/);
  });

  it("rejects a string flag with no value", () => {
    expect(() => parseFlags("serve", ["--port"])).toThrow(/--port requires a value/);
    expect(() => parseFlags("serve", ["--port", "--open"])).toThrow(/--port requires a value/);
  });

  it("rejects a value on a boolean flag", () => {
    expect(() => parseFlags("crawl", ["--replay=yes"])).toThrow(/--replay takes no value/);
  });

  it("rejects bare positional arguments", () => {
    expect(() => parseFlags("crawl", ["https://x.dev"])).toThrow(/unexpected argument/);
  });

  it("mixes forms", () => {
    expect(parseFlags("crawl", ["--base", "https://x.dev", "--max-pages=5", "--quiet"])).toEqual({
      base: "https://x.dev",
      "max-pages": "5",
      quiet: true,
    });
  });
});

describe("applyOverrides", () => {
  const base = () => ConfigSchema.parse({});

  it("returns the config unchanged with no override flags", () => {
    const config = base();
    expect(applyOverrides(config, {})).toEqual(config);
  });

  it("overrides scope and politeness numbers", () => {
    const out = applyOverrides(base(), {
      "max-pages": "9",
      concurrency: "2",
      timeout: "5000",
      out: "/tmp/vc",
    });
    expect(out.scope.maxPages).toBe(9);
    expect(out.politeness.concurrency).toBe(2);
    expect(out.politeness.timeoutMs).toBe(5000);
    expect(out.output.dir).toBe("/tmp/vc");
  });

  it("does not mutate the input config", () => {
    const config = base();
    applyOverrides(config, { "max-pages": "9" });
    expect(config.scope.maxPages).toBe(200);
  });

  it("splits comma-separated globs", () => {
    const out = applyOverrides(base(), { include: "/blog/**, /docs/**", exclude: "/admin/**" });
    expect(out.scope.include).toEqual(["/blog/**", "/docs/**"]);
    expect(out.scope.exclude).toEqual(["/admin/**"]);
  });

  it("filters devices by name, preserving flag order", () => {
    const out = applyOverrides(base(), { devices: "mobile" });
    expect(out.devices.map((d) => d.name)).toEqual(["mobile"]);
  });

  it("rejects unknown device names, listing what is configured", () => {
    expect(() => applyOverrides(base(), { devices: "desktop,tv" })).toThrow(
      /unknown device\(s\) tv — configured: desktop, mobile/,
    );
  });

  it("rejects non-integer numeric overrides", () => {
    expect(() => applyOverrides(base(), { "max-pages": "many" })).toThrow(UsageError);
    expect(() => applyOverrides(base(), { concurrency: "0" })).toThrow(UsageError);
  });
});
