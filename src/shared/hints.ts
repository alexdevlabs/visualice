import type { Config } from "./config";
import type { Manifest } from "./types";

/**
 * Fold a site model's `hints` into the config that drives a run.
 *
 * Hints are advice about a specific site — usually written by an agent during
 * Explore mode, and carried in the cached model across runs. They were previously
 * stored and validated but never read, so the advice silently did nothing. Each one
 * maps onto a config knob that already exists:
 *
 * - `flakyRegions`   → `stabilize.maskSelectors` (paint over what won't hold still)
 * - `stableSelectors`→ `stabilize.waitForSelectors` (don't shoot before these exist)
 * - `skipTriggers`   → `discovery.interactions.denySelectors` (don't probe these)
 *
 * Config wins in the sense that hints only ever *add*: nothing a user wrote is
 * dropped, and applying the same hints twice changes nothing.
 */

type Hints = Manifest["hints"];

const union = (a: readonly string[], b: readonly string[] = []): string[] => [
  ...new Set([...a, ...b]),
];

export function applyHints(config: Config, hints: Hints): Config {
  if (!hints) return config;
  const { flakyRegions, stableSelectors, skipTriggers } = hints;
  if (!flakyRegions?.length && !stableSelectors?.length && !skipTriggers?.length) return config;

  return {
    ...config,
    stabilize: {
      ...config.stabilize,
      maskSelectors: union(config.stabilize.maskSelectors, flakyRegions),
      waitForSelectors: union(config.stabilize.waitForSelectors, stableSelectors),
    },
    discovery: {
      ...config.discovery,
      interactions: {
        ...config.discovery.interactions,
        denySelectors: union(config.discovery.interactions.denySelectors, skipTriggers),
      },
    },
  };
}

/** One-line summary of what the hints changed, for the run log. */
export function describeHints(hints: Hints): string | undefined {
  if (!hints) return undefined;
  const parts: string[] = [];
  if (hints.flakyRegions?.length) parts.push(`${hints.flakyRegions.length} flaky region(s) masked`);
  if (hints.stableSelectors?.length) {
    parts.push(`${hints.stableSelectors.length} stable selector(s) awaited`);
  }
  if (hints.skipTriggers?.length) parts.push(`${hints.skipTriggers.length} trigger(s) skipped`);
  return parts.length ? `applying site hints: ${parts.join(", ")}` : undefined;
}
