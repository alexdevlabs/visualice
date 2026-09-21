import type { ViewerData, ViewerTile } from "./types";
import type { RunDiff } from "./diff-types";

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
    error: isString(raw.error) ? raw.error : undefined,
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
    };
  });

  // Groups are a convenience index; rebuild them from the tiles when absent so an
  // older run still opens in grouped mode.
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
      title: isString(site.title) ? site.title : undefined,
      runId: isString(site.runId) ? site.runId : "unknown",
      generatedAt: isString(site.generatedAt) ? site.generatedAt : "",
    },
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

/**
 * One comparison written by `visualice diff`, as the server lists it.
 *
 * The list is separate from the diffs themselves so opening the viewer costs one
 * small request rather than every comparison's full shot table.
 */
export interface DiffRef {
  id: string;
  from: string;
  to: string;
}

export async function fetchDiffList(url = "./diffs.json"): Promise<DiffRef[]> {
  const res = await fetch(url);
  if (!res.ok) return [];
  const raw: unknown = await res.json().catch(() => null);
  if (!isObject(raw) || !Array.isArray(raw.diffs)) return [];
  return raw.diffs.filter(
    (d): d is DiffRef => isObject(d) && isString(d.id) && isString(d.from) && isString(d.to),
  );
}

/**
 * Validate a `diff.json`. Looser than the manifest check on purpose: a comparison
 * is read-only decoration over two runs, so a field the viewer doesn't recognise
 * should cost that one row's detail rather than the whole view.
 */
export function parseRunDiff(raw: unknown): RunDiff {
  if (!isObject(raw)) throw new ViewerDataError("not a JSON object");
  if (!Array.isArray(raw.shots)) throw new ViewerDataError("missing a 'shots' array");
  const side = (v: unknown, name: string): { runId: string; dir: string } => {
    if (!isObject(v) || !isString(v.runId)) {
      throw new ViewerDataError(`'${name}' must name a runId`);
    }
    return { runId: v.runId, dir: isString(v.dir) ? v.dir : "" };
  };
  const summary = isObject(raw.summary) ? raw.summary : {};
  const count = (key: string) => (typeof summary[key] === "number" ? (summary[key] as number) : 0);
  const routes = isObject(raw.routes) ? raw.routes : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isString) : []);

  return {
    from: side(raw.from, "from"),
    to: side(raw.to, "to"),
    minRatio: typeof raw.minRatio === "number" ? raw.minRatio : 0,
    routes: { added: list(routes.added), removed: list(routes.removed) },
    summary: {
      added: count("added"),
      removed: count("removed"),
      changed: count("changed"),
      unchanged: count("unchanged"),
      uncomparable: count("uncomparable"),
    },
    shots: raw.shots.filter(isObject).map((s, i) => {
      const where = `shots[${i}]`;
      return {
        key: requireString(s, "key", where),
        route: requireString(s, "route", where),
        routeUrl: isString(s.routeUrl) ? s.routeUrl : undefined,
        state: requireString(s, "state", where),
        stateLabel: isString(s.stateLabel) ? s.stateLabel : requireString(s, "state", where),
        device: requireString(s, "device", where),
        status: (isString(s.status)
          ? s.status
          : "uncomparable") as RunDiff["shots"][number]["status"],
        ratio: typeof s.ratio === "number" ? s.ratio : undefined,
        sizeChanged: s.sizeChanged === true || undefined,
        fromSize: isObject(s.fromSize)
          ? (s.fromSize as { width: number; height: number })
          : undefined,
        toSize: isObject(s.toSize) ? (s.toSize as { width: number; height: number }) : undefined,
        image: isString(s.image) ? s.image : undefined,
        fromShot: isString(s.fromShot) ? s.fromShot : undefined,
        toShot: isString(s.toShot) ? s.toShot : undefined,
        note: isString(s.note) ? s.note : undefined,
      };
    }),
  };
}

export async function fetchRunDiff(id: string): Promise<RunDiff> {
  const res = await fetch(`./diffs/${encodeURIComponent(id)}/diff.json`);
  if (!res.ok) throw new ViewerDataError(`${res.status} ${res.statusText}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new ViewerDataError(`not valid JSON — ${(e as Error).message}`);
  }
  return parseRunDiff(raw);
}

export async function fetchViewerData(url: string): Promise<ViewerData> {
  const res = await fetch(url);
  if (!res.ok) throw new ViewerDataError(`${res.status} ${res.statusText}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new ViewerDataError(`not valid JSON — ${(e as Error).message}`);
  }
  return parseViewerData(raw);
}
