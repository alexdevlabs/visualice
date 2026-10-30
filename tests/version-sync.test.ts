import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFile(path.join(ROOT, rel), "utf8");

/**
 * The plugin and the docs tell agents to run `npx -y visualice@<version>`, so the
 * skill always drives the CLI it was written for. A release bump has to move every
 * pin with it; this fails until it does.
 */
describe("version pins", () => {
  it("match package.json everywhere", async () => {
    const { version } = JSON.parse(await read("package.json")) as { version: string };
    expect(JSON.parse(await read(".claude-plugin/plugin.json")).version).toBe(version);

    const files = [
      "AGENTS.md",
      "README.md",
      "agents/visualice-explorer.md",
      ...(await fs.readdir(path.join(ROOT, "commands"))).map((f) => `commands/${f}`),
      "skills/visualice/SKILL.md",
      ...(await fs.readdir(path.join(ROOT, "skills/visualice/references"))).map(
        (f) => `skills/visualice/references/${f}`,
      ),
    ];
    const pins: string[] = [];
    for (const f of files) {
      for (const m of (await read(f)).matchAll(/visualice@(\d+\.\d+\.\d+)/g)) {
        pins.push(`${f}: ${m[1]}`);
      }
    }
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.filter((p) => !p.endsWith(`: ${version}`))).toEqual([]);
  });
});
