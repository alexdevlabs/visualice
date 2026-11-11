import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { waitForStableSelectors } from "../src/crawl/stabilize";

/**
 * A page whose selectors resolve after a stated delay, or never. Records when each
 * wait started, which is how the "shared budget" claim is actually checked: waits
 * that start together share one deadline, waits that queue up do not.
 */
function fakePage(behaviour: Record<string, number | "never">) {
  const startedAt: Record<string, number> = {};
  const timeouts: Record<string, number> = {};
  const t0 = Date.now();
  const page = {
    locator: (selector: string) => ({
      filter: () => ({
        first: () => ({
          waitFor: ({ timeout }: { timeout: number }) => {
            startedAt[selector] = Date.now() - t0;
            timeouts[selector] = timeout;
            const delay = behaviour[selector] ?? 0;
            if (delay === "never") {
              return new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`timeout ${selector}`)), timeout),
              );
            }
            return new Promise((resolve) => setTimeout(resolve, delay));
          },
        }),
      }),
    }),
  } as unknown as Page;
  return { page, startedAt, timeouts };
}

describe("waitForStableSelectors", () => {
  it("does nothing when nothing was configured", async () => {
    const { page, timeouts } = fakePage({});
    expect(await waitForStableSelectors(page, [], 5000)).toEqual([]);
    expect(Object.keys(timeouts)).toEqual([]);
  });

  it("reports the selectors that never appeared, and only those", async () => {
    const { page } = fakePage({ "#ready": 5, "#never": "never", "#slow": 10 });
    const missing = await waitForStableSelectors(page, ["#ready", "#never", "#slow"], 60);
    expect(missing).toEqual(["#never"]);
  });

  it("spends the budget once, not once per selector", async () => {
    const { page } = fakePage({ "#a": "never", "#b": "never", "#c": "never", "#d": "never" });
    const started = Date.now();
    const missing = await waitForStableSelectors(page, ["#a", "#b", "#c", "#d"], 120);
    const elapsed = Date.now() - started;
    expect(missing).toEqual(["#a", "#b", "#c", "#d"]);
    // Four stale selectors used to cost four full timeouts on every single shot.
    // Generous upper bound: the point is that it is one budget, not four.
    expect(elapsed).toBeLessThan(120 * 2);
  });

  it("starts every wait against the same deadline", async () => {
    const { page, startedAt, timeouts } = fakePage({ "#a": "never", "#b": 1 });
    await waitForStableSelectors(page, ["#a", "#b"], 100);
    expect(startedAt["#b"] - startedAt["#a"]).toBeLessThan(20);
    // `#b` gets what is left of the budget, not a fresh one of its own.
    expect(timeouts["#b"]).toBeLessThanOrEqual(100);
  });

  it("does not let a stale selector starve the ones behind it", async () => {
    // Sequential waiting would give `#late` nothing left; concurrent waiting lets
    // it resolve while the stale one is still counting down.
    const { page } = fakePage({ "#stale": "never", "#late": 40 });
    expect(await waitForStableSelectors(page, ["#stale", "#late"], 100)).toEqual(["#stale"]);
  });

  it("gives up immediately once the budget is gone", async () => {
    vi.useFakeTimers();
    try {
      const { page, timeouts } = fakePage({});
      const missing = await waitForStableSelectors(page, ["#a"], 0);
      expect(missing).toEqual(["#a"]);
      expect(timeouts["#a"]).toBeUndefined(); // never even asked
    } finally {
      vi.useRealTimers();
    }
  });
});
