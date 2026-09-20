import { describe, expect, it, vi } from "vitest";
import { mapPool, mapPoolWithResource, sleep } from "../src/shared/pool";

/** Tracks how many calls are in flight at once, so a concurrency cap is provable. */
function concurrencyProbe() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async enter(): Promise<void> {
      peak = Math.max(peak, ++inFlight);
      await sleep(1);
    },
    leave(): void {
      inFlight--;
    },
  };
}

/** A resource pool whose resources are numbered, so reuse and recycling are visible. */
function resources() {
  let created = 0;
  const disposed: number[] = [];
  return {
    disposed,
    get created() {
      return created;
    },
    create: vi.fn(async () => ++created),
    dispose: vi.fn(async (r: number) => {
      disposed.push(r);
    }),
  };
}

describe("mapPool", () => {
  it("returns results in input order even when the work finishes out of order", async () => {
    const out = await mapPool([30, 0, 15], 3, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:0", "2:15"]);
  });

  it("never runs more than `concurrency` items at once", async () => {
    const probe = concurrencyProbe();
    await mapPool(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        await probe.enter();
        probe.leave();
      },
    );
    expect(probe.peak).toBe(3);
  });

  it("spawns no more workers than there are items", async () => {
    const probe = concurrencyProbe();
    await mapPool([1, 2], 10, async () => {
      await probe.enter();
      probe.leave();
    });
    expect(probe.peak).toBe(2);
  });

  it("does nothing at all for an empty list", async () => {
    const fn = vi.fn();
    expect(await mapPool([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects when an item throws", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("mapPoolWithResource", () => {
  it("returns results in input order and passes the index through", async () => {
    const r = resources();
    const out = await mapPoolWithResource([30, 0, 15], 3, {
      create: r.create,
      dispose: r.dispose,
      run: async (ms, _resource, _recycle, index) => {
        await sleep(ms);
        return `${index}:${ms}`;
      },
    });
    expect(out).toEqual(["0:30", "1:0", "2:15"]);
  });

  it("never runs more than `concurrency` items at once", async () => {
    const r = resources();
    const probe = concurrencyProbe();
    await mapPoolWithResource(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      {
        create: r.create,
        dispose: r.dispose,
        run: async () => {
          await probe.enter();
          probe.leave();
        },
      },
    );
    expect(probe.peak).toBe(3);
  });

  it("keeps one resource per worker alive across every item that worker handles", async () => {
    const r = resources();
    const seen = await mapPoolWithResource([1, 2, 3, 4, 5, 6], 2, {
      create: r.create,
      dispose: r.dispose,
      run: async (_item, resource) => {
        await sleep(1);
        return resource;
      },
    });
    // Two workers, two resources — not one per item, which is the whole point.
    expect(r.created).toBe(2);
    expect(new Set(seen)).toEqual(new Set([1, 2]));
    expect(seen).toHaveLength(6);
  });

  it("creates resources lazily, so an empty list creates none", async () => {
    const r = resources();
    expect(await mapPoolWithResource([], 4, { ...r, run: async () => 1 })).toEqual([]);
    expect(r.create).not.toHaveBeenCalled();
    expect(r.dispose).not.toHaveBeenCalled();
  });

  it("disposes every resource once the run finishes", async () => {
    const r = resources();
    await mapPoolWithResource([1, 2, 3, 4], 2, {
      create: r.create,
      dispose: r.dispose,
      run: async () => sleep(1),
    });
    expect(r.disposed.sort()).toEqual([1, 2]);
  });

  it("recycle throws the current resource away and hands back a fresh one", async () => {
    const r = resources();
    const seen = await mapPoolWithResource([1, 2, 3], 1, {
      create: r.create,
      dispose: r.dispose,
      run: async (item, resource, recycle) => (item === 1 ? await recycle() : resource),
    });
    // Item 1 recycled #1 into #2; items 2 and 3 then reuse #2 rather than creating more.
    expect(seen).toEqual([2, 2, 2]);
    expect(r.created).toBe(2);
    expect(r.disposed).toEqual([1, 2]); // #1 on recycle, #2 when the worker finished
  });

  it("disposes the resource even when an item throws", async () => {
    const r = resources();
    await expect(
      mapPoolWithResource([1, 2], 1, {
        create: r.create,
        dispose: r.dispose,
        run: async () => {
          throw new Error("capture wedged");
        },
      }),
    ).rejects.toThrow("capture wedged");
    expect(r.disposed).toEqual([1]);
  });

  it("does not let a failing dispose take the whole run down", async () => {
    // Closing a page that the browser already tore down is routine, not fatal.
    const out = await mapPoolWithResource([1, 2], 1, {
      create: async () => "page",
      dispose: async () => {
        throw new Error("target closed");
      },
      run: async (item, _r, recycle) => {
        if (item === 1) await recycle();
        return item;
      },
    });
    expect(out).toEqual([1, 2]);
  });

  it("rejects rather than yielding holes when a resource can't be created", async () => {
    await expect(
      mapPoolWithResource([1], 1, {
        create: async () => {
          throw new Error("browser has been closed");
        },
        dispose: async () => {},
        run: async () => 1,
      }),
    ).rejects.toThrow("browser has been closed");
  });
});

describe("sleep", () => {
  it("resolves immediately for a non-positive delay", async () => {
    const started = Date.now();
    await sleep(0);
    await sleep(-5);
    expect(Date.now() - started).toBeLessThan(20);
  });
});
