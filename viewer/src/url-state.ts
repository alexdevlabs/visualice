/**
 * The view lives in the URL.
 *
 * "Look at this one" is the most common thing anyone wants to do with a catalog of
 * screenshots, and a viewer that can't produce a link to a single shot forces
 * people back to describing paths in prose. Everything here is optional and
 * degrades to the defaults, so an old or hand-written link still opens.
 */

export interface UrlState {
  q?: string;
  tile?: string;
  /** The site whose run is shown; absent is the one the server was started on. */
  site?: string;
  run?: string;
  /** The one route on the canvas; absent shows them all. */
  route?: string;
  devices?: string[];
  kinds?: string[];
  /** How shots are drawn; absent is Screen mode. */
  mode?: "continuous" | "scroll";
  /** The selected shot is open full screen. */
  full?: boolean;
}

const LIST_SEPARATOR = ",";

// A device can be called "Desktop, wide": its comma must not split the list.
const escapeItem = (item: string): string => item.replace(/%/g, "%25").replace(/,/g, "%2C");
const unescapeItem = (item: string): string => item.replace(/%2C/gi, ",").replace(/%25/g, "%");

export function readUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  const list = (key: string): string[] | undefined => {
    const raw = p.get(key);
    if (!raw) return undefined;
    const items = raw.split(LIST_SEPARATOR).filter(Boolean).map(unescapeItem);
    return items.length ? items : undefined;
  };
  // An empty value is the same as an absent one: `?tile=` must not select a tile
  // whose id is the empty string, and `?run=` must not switch to a nameless run.
  const value = (key: string): string | undefined => p.get(key) || undefined;
  return {
    q: p.get("q") ?? undefined,
    tile: value("tile"),
    site: value("site"),
    run: value("run"),
    route: value("route"),
    devices: list("devices"),
    kinds: list("kinds"),
    mode: modeOf(value("mode")),
    full: p.get("full") === "1" || undefined,
  };
}

function modeOf(v: string | undefined): UrlState["mode"] {
  return v === "continuous" || v === "scroll" ? v : undefined;
}

/** The query string for a state, with defaults left out so links stay short. */
export function serializeUrlState(state: UrlState): string {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.site) p.set("site", state.site);
  if (state.run) p.set("run", state.run);
  if (state.route) p.set("route", state.route);
  if (state.devices?.length) p.set("devices", state.devices.map(escapeItem).join(LIST_SEPARATOR));
  if (state.kinds?.length) p.set("kinds", state.kinds.map(escapeItem).join(LIST_SEPARATOR));
  if (state.mode) p.set("mode", state.mode);
  if (state.full && state.tile) p.set("full", "1");
  if (state.tile) p.set("tile", state.tile);
  return p.toString();
}

/**
 * Update the address bar without adding history entries — panning around a canvas
 * would otherwise bury the previous page under dozens of back-button steps. A
 * `?data=` override is preserved: it's how the viewer was pointed here.
 */
export function writeUrlState(state: UrlState): void {
  const query = serializeUrlState(state);
  const data = new URLSearchParams(location.search).get("data");
  const full = data ? `${query ? query + "&" : ""}data=${encodeURIComponent(data)}` : query;
  const next = `${location.pathname}${full ? "?" + full : ""}${location.hash}`;
  if (next !== location.pathname + location.search + location.hash) {
    history.replaceState(null, "", next);
  }
}
