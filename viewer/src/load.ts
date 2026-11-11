import type { ViewerData, ViewerTile } from "./types";

/**
 * Loading and validating `viewer-data.json`.
 *
 * The viewer is a static page that fetches a URL, so its input is not guaranteed to
 * be what the engine writes: it can be an old run from a previous version, a
 * hand-edited file, or — via `?data=` — something else entirely. Validating up
 * front turns "blank canvas, cryptic console error" into a message that says which
 * field is wrong.
 */

export class ViewerDataError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isString = (v: unknown): v is string => typeof v === "string";

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (!isString(v) || v === "") throw new ViewerDataError(`${where}.${key} must be a string`);
  return v;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Per-screen positions, all or nothing: a partial list can't join the screens. */
function parseFrames(raw: unknown): ViewerTile["frames"] {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const frames = raw.map((f) =>
    isObject(f) && isNum(f.y) && isNum(f.top) && isNum(f.bottom)
      ? { y: f.y, top: Math.max(0, f.top), bottom: Math.max(0, f.bottom) }
      : undefined,
  );
  return frames.every((f) => f !== undefined) ? frames : undefined;
}

function parseTile(raw: unknown, i: number): ViewerTile {
  if (!isObject(raw)) throw new ViewerDataError(`tiles[${i}] must be an object`);
  const where = `tiles[${i}]`;
  // A tile is either an image or a recorded failure; one of the two must be there.
  if (!isString(raw.full) && !isString(raw.error)) {
    throw new ViewerDataError(`${where} has neither a 'full' image nor an 'error'`);
  }
  return {
    id: requireString(raw, "id", where),
    routeId: requireString(raw, "routeId", where),
    routeUrl: requireString(raw, "routeUrl", where),
    routePath: requireString(raw, "routePath", where),
    stateId: requireString(raw, "stateId", where),
    stateLabel: isString(raw.stateLabel) ? raw.stateLabel : requireString(raw, "stateId", where),
    stateKind: (isString(raw.stateKind) ? raw.stateKind : "other") as ViewerTile["stateKind"],
    device: requireString(raw, "device", where),
    full: isString(raw.full) ? raw.full : undefined,
    thumb: isString(raw.thumb) ? raw.thumb : undefined,
    mid: isString(raw.mid) ? raw.mid : undefined,
    viewport: isString(raw.viewport) ? raw.viewport : undefined,
    width: typeof raw.width === "number" ? raw.width : undefined,
    height: typeof raw.height === "number" ? raw.height : undefined,
    clamped: raw.clamped === true || undefined,
    screens:
      typeof raw.screens === "number" && raw.screens > 1 ? Math.floor(raw.screens) : undefined,
    frames: parseFrames(raw.frames),
    meta: isString(raw.meta) ? raw.meta : undefined,
    a11y: typeof raw.a11y === "number" ? raw.a11y : undefined,
    error: isString(raw.error) ? raw.error : undefined,
    carried: parseCarried(raw.carried),
    updated: raw.updated === true || undefined,
  };
}

/** Where a carried-over shot was really taken; dropped unless it names a run. */
function parseCarried(raw: unknown): ViewerTile["carried"] {
  if (!isObject(raw) || !isString(raw.runId)) return undefined;
  return {
    runId: raw.runId,
    commit: isString(raw.commit) ? raw.commit : undefined,
    capturedAt: isString(raw.capturedAt) ? raw.capturedAt : undefined,
  };
}

/** The commit a run was shot from, when it recorded one. */
function parseSource(raw: unknown): ViewerData["source"] {
  if (!isObject(raw) || !isString(raw.commit)) return undefined;
  return {
    commit: raw.commit,
    branch: isString(raw.branch) ? raw.branch : undefined,
    dirty: typeof raw.dirty === "number" ? raw.dirty : 0,
    capturedAt: isString(raw.capturedAt) ? raw.capturedAt : "",
    target: isString(raw.target) ? raw.target : undefined,
    local: typeof raw.local === "boolean" ? raw.local : undefined,
  };
}

function parsePartial(raw: unknown): ViewerData["partial"] {
  if (!isObject(raw) || !Array.isArray(raw.only)) return undefined;
  return {
    only: raw.only.filter(isString),
    carriedFrom: isString(raw.carriedFrom) ? raw.carriedFrom : undefined,
  };
}

/** Validate an already-parsed JSON value, filling in what older runs may omit. */
export function parseViewerData(raw: unknown): ViewerData {
  if (!isObject(raw)) throw new ViewerDataError("not a JSON object");
  if (!Array.isArray(raw.tiles)) throw new ViewerDataError("missing a 'tiles' array");
  if (!Array.isArray(raw.devices)) throw new ViewerDataError("missing a 'devices' array");
  if (!isObject(raw.site)) throw new ViewerDataError("missing a 'site' object");

  const tiles = raw.tiles.map(parseTile);
  const devices = raw.devices.map((d, i) => {
    if (!isObject(d)) throw new ViewerDataError(`devices[${i}] must be an object`);
    return {
      name: requireString(d, "name", `devices[${i}]`),
      width: typeof d.width === "number" ? d.width : 1280,
      height: typeof d.height === "number" ? d.height : 800,
      dpr: typeof d.dpr === "number" ? d.dpr : 1,
      // The device icon goes by it: a tablet is mobile, however wide.
      ...(typeof d.mobile === "boolean" ? { mobile: d.mobile } : {}),
    };
  });

  // Groups are a convenience index; rebuild them from the tiles when absent so an
  // older run still opens.
  const groups = Array.isArray(raw.groups)
    ? raw.groups.filter(isObject).map((g, i) => ({
        path: requireString(g, "path", `groups[${i}]`),
        routeId: requireString(g, "routeId", `groups[${i}]`),
        title: isString(g.title) ? g.title : undefined,
      }))
    : [
        ...new Map(
          tiles.map((t) => [t.routeId, { path: t.routePath, routeId: t.routeId }]),
        ).values(),
      ];

  const site = raw.site as Record<string, unknown>;
  return {
    site: {
      baseUrl: isString(site.baseUrl) ? site.baseUrl : "",
      origin: isString(site.origin) ? site.origin : "",
      liveBase: isString(site.liveBase) ? site.liveBase : undefined,
      title: isString(site.title) ? site.title : undefined,
      runId: isString(site.runId) ? site.runId : "unknown",
      generatedAt: isString(site.generatedAt) ? site.generatedAt : "",
    },
    source: parseSource(raw.source),
    partial: parsePartial(raw.partial),
    devices,
    tiles,
    groups,
    failed: typeof raw.failed === "number" ? raw.failed : tiles.filter((t) => t.error).length,
  };
}

/**
 * Resolve the `?data=` override.
 *
 * The viewer is served from a local run directory, and anything it loads is drawn
 * into the page and linked from it. An arbitrary absolute URL there would let a
 * crafted link point the viewer at someone else's host, so only same-origin
 * relative paths are honoured — enough for `?data=../other-run/viewer-data.json`,
 * which is the case this exists for.
 */
export function resolveDataUrl(search: string, fallback: string): { url: string; note?: string } {
  const requested = new URLSearchParams(search).get("data");
  if (!requested) return { url: fallback };
  if (/^[a-z][a-z0-9+.-]*:/i.test(requested) || requested.startsWith("//")) {
    return {
      url: fallback,
      note: `ignored ?data=${requested} — only same-origin paths are allowed`,
    };
  }
  return { url: requested };
}

/** Fetch a JSON document, turning HTTP and parse failures into `ViewerDataError`s. */
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new ViewerDataError(`${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch (e) {
    throw new ViewerDataError(`not valid JSON — ${(e as Error).message}`);
  }
}

export async function fetchViewerData(url: string): Promise<ViewerData> {
  return parseViewerData(await fetchJson(url));
}

/** One accessibility rule a shot broke, as its sidecar records it. */
export interface ShotViolation {
  id: string;
  impact?: string;
  help: string;
  helpUrl?: string;
  count: number;
  targets: string[];
}

/** The accessibility findings in a shot's sidecar; empty when it has none. */
export function parseViolations(raw: unknown): ShotViolation[] {
  if (!isObject(raw) || !Array.isArray(raw.accessibility)) return [];
  return raw.accessibility.filter(isObject).flatMap((v) =>
    isString(v.id) && isString(v.help)
      ? [
          {
            id: v.id,
            impact: isString(v.impact) ? v.impact : undefined,
            help: v.help,
            helpUrl: isString(v.helpUrl) && /^https?:/i.test(v.helpUrl) ? v.helpUrl : undefined,
            count: typeof v.count === "number" ? v.count : 1,
            targets: Array.isArray(v.targets) ? v.targets.filter(isString) : [],
          },
        ]
      : [],
  );
}
