import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { nodeBinCommand, packageBin } from "../src/shared/node-bin";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("packageBin", () => {
  it("finds a dependency's bin script through its package.json", () => {
    const bin = packageBin("playwright", ROOT)!;
    expect(path.basename(bin)).toBe("cli.js");
    expect(existsSync(bin)).toBe(true);
  });

  it("is undefined for a package that isn't installed", () => {
    expect(packageBin("no-such-package-visualice", ROOT)).toBeUndefined();
  });
});

describe("nodeBinCommand", () => {
  it("runs the script with this node, not through npx", () => {
    const [cmd, args] = nodeBinCommand("vite", ["build", "viewer"], ROOT)!;
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(["build", "viewer"]);
    expect(path.basename(args[0])).toBe("vite.js");
  });
});
