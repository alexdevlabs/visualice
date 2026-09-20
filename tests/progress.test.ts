import { describe, expect, it } from "vitest";
import { createProgress, estimateRemaining, formatDuration } from "../src/shared/progress";

describe("formatDuration", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });
});

describe("estimateRemaining", () => {
  it("projects from the average rate so far", () => {
    // 10 of 100 took 10s → 90 more at 1s each.
    expect(estimateRemaining(10_000, 10, 100)).toBe(90_000);
  });

  it("has nothing to project at the edges", () => {
    expect(estimateRemaining(10_000, 0, 100)).toBe(0);
    expect(estimateRemaining(10_000, 100, 100)).toBe(0);
  });
});

describe("createProgress", () => {
  /** A controllable clock so the rate limiting is testable without waiting. */
  function harness(total: number, everyMs = 5000) {
    const lines: string[] = [];
    let t = 0;
    const progress = createProgress({
      total,
      everyMs,
      log: (m) => lines.push(m.trim()),
      now: () => t,
    });
    return { lines, progress, advance: (ms: number) => (t += ms) };
  }

  it("stays quiet between reports", () => {
    const { lines, progress, advance } = harness(100);
    for (let i = 0; i < 4; i++) {
      advance(1000);
      progress.tick();
    }
    expect(lines).toEqual([]);

    advance(2000); // now past the 5s window
    progress.tick();
    expect(lines).toHaveLength(1);
    // 6s for 5 → 1.2s each → 95 left ≈ 114s.
    expect(lines[0]).toBe("… 5/100 (5%) · ~1m 54s left");
  });

  it("always reports the final unit", () => {
    const { lines, progress, advance } = harness(2);
    advance(10);
    progress.tick();
    advance(10);
    progress.tick();
    expect(lines.at(-1)).toBe("… 2/2 (100%)"); // complete: no ETA left to give
  });

  it("closes with the elapsed total", () => {
    const { lines, progress, advance } = harness(10);
    advance(30_000);
    progress.done();
    expect(lines.at(-1)).toBe("… 0/10 in 30s");
  });

  it("handles an empty plan without dividing by zero", () => {
    const { lines, progress } = harness(0);
    progress.done();
    expect(lines.at(-1)).toBe("… 0/0 in 0s");
  });
});
