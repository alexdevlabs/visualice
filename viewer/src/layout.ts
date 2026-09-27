import type { ViewerData, ViewerTile, Device } from "./types";

export type LayoutMode = "grouped" | "all" | "devices";

export interface Placed {
  tile: ViewerTile;
  x: number;
  y: number;
  w: number;
  h: number;
  cropped: boolean;
}

export interface GroupLabel {
  routeId: string;
  title: string;
  subtitle: string;
  /** The route's URL path, when the label heads a route — drawn as its badge. */
  path?: string;
  x: number;
  y: number;
  w: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Layout {
  placed: Placed[];
  labels: GroupLabel[];
  bounds: Bounds;
  byRoute: Map<string, Bounds>;
  /**
   * Routes with tiles matching the filters, in the data's own order.
   *
   * Not the same as the keys of `byRoute`: device-compare mode places one route at
   * a time, and the sidebar still has to offer the others — they're what you'd
   * click to compare next.
   */
  routesWithTiles: string[];
  /** Tiles matching the filters but left unplaced by `limit`. */
  truncated: number;
}

export interface LayoutFilters {
  mode: LayoutMode;
  devices: Set<string>;
  /** State kinds to show; empty or absent means all of them. */
  kinds?: Set<string>;
  query?: string;
  /** Show only the captures that failed. */
  failedOnly?: boolean;
  /** Cap on placed tiles, so a huge run can't lock up the canvas. */
  limit?: number;
  /** The route `devices` mode lays out. Defaults to the first one with tiles. */
  focusRouteId?: string;
}

const CARD = 360; // world px for the widest device
/**
 * Device compare draws every device at one width, so the same element lands in the
 * same place across the row and a spacing change is visible by looking straight
 * down. Wider than a catalog card because comparing means reading.
 */
const COMPARE_CARD = 560;
const GAP = 26;
const ROW_GAP = 30;
const SECTION_GAP = 90;
const HEADER_H = 52;
const MAX_H = 1120; // cap very tall full-page shots so the overview stays tidy

/** Roughly the shape of a screen — what "fit to window" has to fill. */
const TARGET_ASPECT = 1.6;

function aspect(t: ViewerTile): number {
  if (t.width && t.height && t.width > 0) return t.height / t.width;
  return 0.66;
}

/** A group's slug as the URL path people recognise: `home` is the site root. */
export function routePath(slug: string): string {
  return slug === "home" ? "/" : "/" + slug;
}

function growBounds(b: Bounds, x: number, y: number, w: number, h: number): void {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.maxX = Math.max(b.maxX, x + w);
  b.maxY = Math.max(b.maxY, y + h);
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function matchesQuery(t: ViewerTile, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    t.routePath.toLowerCase().includes(s) ||
    t.routeUrl.toLowerCase().includes(s) ||
    t.stateLabel.toLowerCase().includes(s) ||
    t.stateId.toLowerCase().includes(s)
  );
}

/**
 * How many columns of route sections to lay out.
 *
 * Stacking every section in one column makes the whole canvas a tall, thin ribbon:
 * "fit to window" then has to zoom out until the width is a sliver, and the run is
 * unreadable at its default zoom. Choosing a column count that lands the overall
 * bounds near screen aspect is what makes Fit useful.
 */
export function columnCount(totalHeight: number, columnWidth: number, blocks: number): number {
  if (blocks <= 1 || totalHeight <= 0 || columnWidth <= 0) return 1;
  // width ≈ n·W, height ≈ H/n → n·W / (H/n) = TARGET → n = √(TARGET·H/W)
  const ideal = Math.sqrt((TARGET_ASPECT * totalHeight) / columnWidth);
  return Math.max(1, Math.min(blocks, Math.round(ideal)));
}

interface GroupBlock {
  routeId: string;
  title: string;
  path: string;
  stateIds: string[];
  rows: { stateId: string; tiles: (ViewerTile | undefined)[] }[];
  height: number;
}

/**
 * The route device-compare should lay out: the one asked for if it still has
 * tiles, otherwise the first that does. Falling back rather than showing nothing
 * matters because the filters can empty the focused route out from under the mode.
 */
export function resolveFocusRoute(
  groups: ViewerData["groups"],
  withTiles: Set<string>,
  asked?: string,
): string | undefined {
  if (asked && withTiles.has(asked)) return asked;
  return groups.find((g) => withTiles.has(g.routeId))?.routeId;
}

export function computeLayout(data: ViewerData, filters: LayoutFilters): Layout {
  const { mode, devices: deviceFilter, kinds, query = "", failedOnly, limit } = filters;
  const devices = data.devices.filter((d) => deviceFilter.has(d.name));
  const maxW = Math.max(1, ...devices.map((d) => d.width));
  const colW = (d: Device) => Math.max(60, Math.round((CARD * d.width) / maxW));

  const matching = data.tiles.filter(
    (t) =>
      deviceFilter.has(t.device) &&
      (!kinds || kinds.size === 0 || kinds.has(t.stateKind)) &&
      (!failedOnly || t.error !== undefined) &&
      matchesQuery(t, query),
  );
  const routesMatching = new Set(matching.map((t) => t.routeId));
  const routesWithTiles = data.groups.map((g) => g.routeId).filter((id) => routesMatching.has(id));

  // Device compare is about one route at a time; everything else lays out the lot.
  const focusRouteId =
    mode === "devices"
      ? resolveFocusRoute(data.groups, routesMatching, filters.focusRouteId)
      : undefined;
  const inScope =
    mode === "devices" ? matching.filter((t) => t.routeId === focusRouteId) : matching;

  const tiles = limit !== undefined && inScope.length > limit ? inScope.slice(0, limit) : inScope;
  const truncated = inScope.length - tiles.length;

  const placed: Placed[] = [];
  const labels: GroupLabel[] = [];
  const bounds = emptyBounds();
  const byRoute = new Map<string, Bounds>();

  const place = (tile: ViewerTile, x: number, y: number, w: number): number => {
    const full = w * aspect(tile);
    const h = Math.min(full, MAX_H);
    placed.push({ tile, x, y, w, h, cropped: full > MAX_H });
    growBounds(bounds, x, y, w, h);
    const rb = byRoute.get(tile.routeId) ?? emptyBounds();
    growBounds(rb, x, y, w, h);
    byRoute.set(tile.routeId, rb);
    return h;
  };

  if (mode === "devices") {
    // One block per state of the focused route: every device at the same width,
    // top-aligned, in the order the devices were configured.
    const group = data.groups.find((g) => g.routeId === focusRouteId);
    const byStateDevice = new Map(tiles.map((t) => [`${t.stateId} ${t.device}`, t]));
    const stateIds = [...new Set(tiles.map((t) => t.stateId))];
    const rowWidth = Math.max(1, devices.length * (COMPARE_CARD + GAP) - GAP);

    const blocks = stateIds.map((stateId) => {
      const row = devices.map((d) => byStateDevice.get(`${stateId} ${d.name}`));
      const height =
        HEADER_H +
        row.reduce((h, t) => (t ? Math.max(h, Math.min(COMPARE_CARD * aspect(t), MAX_H)) : h), 0);
      return { stateId, row, height };
    });

    // Same reason as the grouped mode: a single column of full-page shots is a
    // ribbon, and Fit then shows it as a sliver.
    const totalHeight = blocks.reduce((sum, b) => sum + b.height + SECTION_GAP, 0);
    const columns = columnCount(totalHeight, rowWidth, blocks.length);
    const columnX = Array.from({ length: columns }, (_, i) => i * (rowWidth + SECTION_GAP));
    const columnY = new Array<number>(columns).fill(0);

    for (const block of blocks) {
      let col = 0;
      for (let i = 1; i < columns; i++) if (columnY[i] < columnY[col]) col = i;
      const x0 = columnX[col];
      const labelY = columnY[col];
      const y = labelY + HEADER_H;

      growBounds(bounds, x0, labelY, rowWidth, HEADER_H);
      let rowH = 0;
      block.row.forEach((t, i) => {
        if (t) rowH = Math.max(rowH, place(t, x0 + i * (COMPARE_CARD + GAP), y, COMPARE_CARD));
      });

      const rb = byRoute.get(focusRouteId ?? "") ?? emptyBounds();
      growBounds(rb, x0, labelY, rowWidth, HEADER_H);
      if (focusRouteId) byRoute.set(focusRouteId, rb);
      labels.push({
        routeId: `${focusRouteId}:${block.stateId}`,
        title: block.row.find(Boolean)?.stateLabel ?? block.stateId,
        subtitle: `${block.stateId}  ·  ${devices.map((d) => d.name).join("  ·  ")}`,
        x: x0,
        y: labelY,
        w: rowWidth,
      });
      columnY[col] = y + rowH + SECTION_GAP;
    }

    if (group && !stateIds.length) {
      labels.push({
        routeId: group.routeId,
        title: group.title || group.path,
        subtitle: "no shots match the current filters",
        x: 0,
        y: 0,
        w: rowWidth,
      });
    }
  } else if (mode === "grouped") {
    // Index once — per-group filter/find scans are O(routes × tiles) and this
    // recomputes on every search keystroke.
    const tilesByRoute = new Map<string, ViewerTile[]>();
    for (const t of tiles) {
      const arr = tilesByRoute.get(t.routeId);
      if (arr) arr.push(t);
      else tilesByRoute.set(t.routeId, [t]);
    }

    const rowWidth = Math.max(1, devices.reduce((sum, d) => sum + colW(d) + GAP, 0) - GAP);

    // Measure every section before placing any, so the column count can be chosen
    // from the real total height rather than guessed.
    const blocks: GroupBlock[] = [];
    for (const g of data.groups) {
      const routeTiles = tilesByRoute.get(g.routeId) ?? [];
      if (!routeTiles.length) continue;
      const stateIds = [...new Set(routeTiles.map((t) => t.stateId))];
      const byStateDevice = new Map(routeTiles.map((t) => [`${t.stateId} ${t.device}`, t]));

      const rows = stateIds.map((stateId) => ({
        stateId,
        tiles: devices.map((d) => byStateDevice.get(`${stateId} ${d.name}`)),
      }));
      const height =
        HEADER_H +
        rows.reduce((sum, row) => {
          const rowH = row.tiles.reduce((h, t, i) => {
            if (!t) return h;
            return Math.max(h, Math.min(colW(devices[i]) * aspect(t), MAX_H));
          }, 0);
          return sum + rowH + ROW_GAP;
        }, 0);
      blocks.push({
        routeId: g.routeId,
        title: g.title || g.path,
        path: g.path,
        stateIds,
        rows,
        height,
      });
    }

    const totalHeight = blocks.reduce((sum, b) => sum + b.height + SECTION_GAP, 0);
    const columns = columnCount(totalHeight, rowWidth, blocks.length);
    const columnX = Array.from({ length: columns }, (_, i) => i * (rowWidth + SECTION_GAP));
    const columnY = new Array(columns).fill(0);

    for (const block of blocks) {
      // Shortest column first keeps the bottom edge roughly level, so Fit doesn't
      // have to zoom out for one runaway column.
      let col = 0;
      for (let i = 1; i < columns; i++) if (columnY[i] < columnY[col]) col = i;
      const x0 = columnX[col];
      let y = columnY[col];

      const labelY = y;
      growBounds(bounds, x0, y, rowWidth, HEADER_H);
      y += HEADER_H;

      for (const row of block.rows) {
        let x = x0;
        let rowH = 0;
        row.tiles.forEach((t, i) => {
          const w = colW(devices[i]);
          if (t) rowH = Math.max(rowH, place(t, x, y, w));
          x += w + GAP;
        });
        y += rowH + ROW_GAP;
      }

      const existing = byRoute.get(block.routeId) ?? emptyBounds();
      growBounds(existing, x0, labelY, rowWidth, HEADER_H);
      byRoute.set(block.routeId, existing);
      labels.push({
        routeId: block.routeId,
        title: block.title,
        subtitle: `${block.stateIds.length} state${block.stateIds.length === 1 ? "" : "s"}`,
        path: routePath(block.path),
        x: x0,
        y: labelY,
        w: rowWidth,
      });
      columnY[col] = y + SECTION_GAP;
    }
  } else {
    const targetRow = CARD * 5;
    let x = 0;
    let y = 0;
    let rowH = 0;
    for (const t of tiles) {
      const d = data.devices.find((dd) => dd.name === t.device);
      const w = d ? colW(d) : CARD;
      const full = w * aspect(t);
      const h = Math.min(full, MAX_H);
      if (x > 0 && x + w > targetRow) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      place(t, x, y, w);
      x += w + GAP;
      rowH = Math.max(rowH, h);
    }
  }

  if (!placed.length) Object.assign(bounds, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  return { placed, labels, bounds, byRoute, routesWithTiles, truncated };
}
