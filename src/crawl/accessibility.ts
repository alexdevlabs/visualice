import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import type { Page } from "playwright";

/**
 * Accessibility checks, run against a state while it is on screen.
 *
 * The crawler is already the expensive part of an accessibility audit — it has
 * reached every page and opened every menu, modal and accordion, which is exactly
 * where a static scan of the default render stops. Running axe at that moment
 * costs one evaluation per shot and finds the violations that only exist inside an
 * open dialog.
 */

export interface AccessibilityViolation {
  /** axe rule id, e.g. `color-contrast`. */
  id: string;
  impact?: "minor" | "moderate" | "serious" | "critical";
  help: string;
  helpUrl?: string;
  /** How many elements broke the rule. */
  count: number;
  /** A selector for each of the first few, to find them with. */
  targets: string[];
}

let source: Promise<string> | undefined;

/** axe's browser bundle, read once per process from the installed package. */
function axeSource(): Promise<string> {
  source ??= fs.readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  return source;
}

const MAX_TARGETS = 5;

export async function checkAccessibility(
  page: Page,
  tags: string[],
  scope?: string,
): Promise<AccessibilityViolation[]> {
  // Evaluated rather than added as a <script>: a page's CSP has no say over this.
  await page.evaluate(await axeSource());
  const raw = await page.evaluate(
    async ([runTags, selector]) => {
      const axe = (
        globalThis as unknown as {
          axe: { run: (context: unknown, options: unknown) => Promise<{ violations: unknown[] }> };
        }
      ).axe;
      const result = await axe.run(selector ?? document, {
        runOnly: { type: "tag", values: runTags },
        resultTypes: ["violations"],
      });
      return result.violations as {
        id: string;
        impact?: string;
        help: string;
        helpUrl?: string;
        nodes: { target: unknown[] }[];
      }[];
    },
    [tags, scope ?? null] as const,
  );
  return raw.map((v) => ({
    id: v.id,
    impact: v.impact as AccessibilityViolation["impact"],
    help: v.help,
    helpUrl: v.helpUrl,
    count: v.nodes.length,
    targets: v.nodes.slice(0, MAX_TARGETS).map((n) => n.target.map(String).join(" ")),
  }));
}

/** One rule across a whole run: how bad, and how many shots it shows up in. */
export interface AccessibilityRollup {
  id: string;
  impact?: AccessibilityViolation["impact"];
  help: string;
  helpUrl?: string;
  shots: number;
  elements: number;
}

const SEVERITY = ["critical", "serious", "moderate", "minor"];

/** Two rollups as one: a partial run's own shots and the ones it carried over. */
export function mergeRollups(
  a: AccessibilityRollup[],
  b: AccessibilityRollup[],
): AccessibilityRollup[] {
  const byRule = new Map<string, AccessibilityRollup>();
  for (const r of [...a, ...b]) {
    const entry = byRule.get(r.id);
    if (entry) {
      entry.shots += r.shots;
      entry.elements += r.elements;
    } else byRule.set(r.id, { ...r });
  }
  return sortRollups([...byRule.values()]);
}

function sortRollups(rollups: AccessibilityRollup[]): AccessibilityRollup[] {
  const rank = (r: AccessibilityRollup) => {
    const i = SEVERITY.indexOf(r.impact ?? "");
    return i < 0 ? SEVERITY.length : i;
  };
  return rollups.sort((a, b) => rank(a) - rank(b) || b.shots - a.shots || a.id.localeCompare(b.id));
}

export function rollupViolations(perShot: AccessibilityViolation[][]): AccessibilityRollup[] {
  const byRule = new Map<string, AccessibilityRollup>();
  for (const violations of perShot) {
    for (const v of violations) {
      const entry = byRule.get(v.id) ?? {
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        shots: 0,
        elements: 0,
      };
      entry.shots++;
      entry.elements += v.count;
      byRule.set(v.id, entry);
    }
  }
  return sortRollups([...byRule.values()]);
}
