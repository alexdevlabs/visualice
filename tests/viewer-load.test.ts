import { describe, expect, it } from "vitest";
import { ViewerDataError, parseRunDiff, parseViewerData, resolveDataUrl } from "../viewer/src/load";

const tile = (over: Record<string, unknown> = {}) => ({
  id: "home__default__desktop",
  routeId: "home",
  routeUrl: "/",
  routePath: "home",
  stateId: "default",
  stateLabel: "Default",
  stateKind: "default",
  device: "desktop",
  full: "screenshots/home/default/desktop.png",
  ...over,
});

const data = (over: Record<string, unknown> = {}) => ({
  site: { baseUrl: "https://x.test", origin: "https://x.test", runId: "r1", generatedAt: "t" },
  devices: [{ name: "desktop", width: 1440, height: 900, dpr: 2 }],
  tiles: [tile()],
  groups: [{ path: "home", routeId: "home", title: "Home" }],
  ...over,
});

describe("parseViewerData", () => {
  it("accepts what the engine writes", () => {
    const parsed = parseViewerData(data());
    expect(parsed.tiles).toHaveLength(1);
    expect(parsed.site.runId).toBe("r1");
    expect(parsed.groups[0].title).toBe("Home");
  });

  it("names the field that is wrong instead of failing blank", () => {
    expect(() => parseViewerData(null)).toThrow(ViewerDataError);
    expect(() => parseViewerData({})).toThrow(/tiles/);
    expect(() => parseViewerData(data({ devices: undefined }))).toThrow(/devices/);
    expect(() => parseViewerData(data({ site: undefined }))).toThrow(/site/);
    expect(() => parseViewerData(data({ tiles: [tile({ routeId: undefined })] }))).toThrow(
      /tiles\[0\]\.routeId/,
    );
  });

  it("keeps a failed capture as a tile carrying its error", () => {
    const parsed = parseViewerData(
      data({ tiles: [tile({ full: undefined, error: "timeout exceeded" })] }),
    );
    expect(parsed.tiles[0].full).toBeUndefined();
    expect(parsed.tiles[0].error).toBe("timeout exceeded");
    expect(parsed.failed).toBe(1);
  });

  it("rejects a tile that is neither an image nor a failure", () => {
    expect(() => parseViewerData(data({ tiles: [tile({ full: undefined })] }))).toThrow(
      /neither a 'full' image nor an 'error'/,
    );
  });

  it("reads a run written before these fields existed", () => {
    // No groups, no `failed`, no mid/viewport — an older engine's output.
    const parsed = parseViewerData(data({ groups: undefined, failed: undefined }));
    expect(parsed.groups).toEqual([{ path: "home", routeId: "home" }]);
    expect(parsed.failed).toBe(0);
    expect(parsed.tiles[0].mid).toBeUndefined();
  });

  it("passes the optional shot variants through", () => {
    const parsed = parseViewerData(
      data({
        tiles: [tile({ mid: "m.webp", viewport: "v.png", thumb: "t.webp", clamped: true })],
      }),
    );
    expect(parsed.tiles[0]).toMatchObject({
      mid: "m.webp",
      viewport: "v.png",
      thumb: "t.webp",
      clamped: true,
    });
  });
});

describe("resolveDataUrl", () => {
  it("uses the default when nothing is asked for", () => {
    expect(resolveDataUrl("", "./data/viewer-data.json").url).toBe("./data/viewer-data.json");
  });

  it("honours a relative path — that's what the override is for", () => {
    expect(resolveDataUrl("?data=../other/viewer-data.json", "./d.json").url).toBe(
      "../other/viewer-data.json",
    );
  });

  it("refuses to be pointed at another origin", () => {
    for (const hostile of [
      "https://evil.test/data.json",
      "http://evil.test/data.json",
      "//evil.test/data.json",
      "javascript:alert(1)",
      "data:application/json,{}",
    ]) {
      const result = resolveDataUrl(`?data=${encodeURIComponent(hostile)}`, "./d.json");
      expect(result.url).toBe("./d.json");
      expect(result.note).toContain("only same-origin");
    }
  });
});

describe("parseRunDiff", () => {
  const minimal = {
    from: { runId: "a", dir: "/tmp/a" },
    to: { runId: "b", dir: "/tmp/b" },
    shots: [],
  };

  it("accepts a comparison with only the fields it needs", () => {
    const d = parseRunDiff(minimal);
    expect(d.from.runId).toBe("a");
    expect(d.to.runId).toBe("b");
    expect(d.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
      uncomparable: 0,
    });
  });

  it("rejects input that names no runs — there'd be nothing to fetch images from", () => {
    expect(() => parseRunDiff({ ...minimal, from: {} })).toThrow(ViewerDataError);
    expect(() => parseRunDiff({ to: minimal.to, shots: [] })).toThrow(ViewerDataError);
  });

  it("rejects input with no shots array", () => {
    expect(() => parseRunDiff({ from: minimal.from, to: minimal.to })).toThrow(ViewerDataError);
  });

  it("keeps the shot paths, which is what lets the viewer find the pictures", () => {
    const d = parseRunDiff({
      ...minimal,
      shots: [
        {
          key: "home|default|desktop",
          route: "home",
          routeUrl: "/",
          state: "default",
          stateLabel: "Default",
          device: "desktop",
          status: "changed",
          ratio: 0.5,
          image: "images/home/default/desktop.png",
          fromShot: "screenshots/home/default/desktop.png",
          toShot: "screenshots/home/default/desktop.png",
        },
      ],
    });
    expect(d.shots[0].fromShot).toBe("screenshots/home/default/desktop.png");
    expect(d.shots[0].image).toBe("images/home/default/desktop.png");
    expect(d.shots[0].ratio).toBe(0.5);
  });

  it("falls back to the state id when a shot carries no label", () => {
    const d = parseRunDiff({
      ...minimal,
      shots: [{ key: "k", route: "home", state: "modal", device: "desktop", status: "changed" }],
    });
    expect(d.shots[0].stateLabel).toBe("modal");
  });
});
