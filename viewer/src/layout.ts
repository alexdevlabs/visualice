import type { ViewerData, ViewerTile, Device } from "./types";

export interface Placed {
  tile: ViewerTile;
  x: number;
  y: number;
  w: number;
  h: number;
  cropped: boolean;
  /** Height of one screen on the canvas, when the shot stacks several. */
  screenH?: number;
  /** Screens that fit in `h` — all of them unless the tile was cut short. */
  screensShown?: number;
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
  /** Routes with tiles matching the filters, in the data's own order. */
  routesWithTiles: string[];
  /** Tiles matching the filters but left unplaced by `limit`. */
  truncated: number;
}

export interface LayoutFilters {
  devices: Set<string>;
  /** State kinds to show; empty or absent means all of them. */
  kinds?: Set<string>;
  query?: string;
  /** Show only the captures that failed. */
  failedOnly?: boolean;
  /** Cap on placed tiles, so a huge run can't lock up the canvas. */
  limit?: number;
  /** Lay out only this route; the others still count toward `routesWithTiles`. */
  routeId?: string;
}

const CARD = 360; // world px for the widest device
const GAP = 26;
/** Room above every tile for its caption: the state name, then a row of badges. */
const CAPTION_H = 44;
/**
 * The least width a caption gets. A phone-width tile is narrower than its own
 * badges, so its slot in the row is this wide even though the tile isn't.
 */
export const CAPTION_MIN_W = 180;
const ROW_GAP = 12 + CAPTION_H;
const SECTION_GAP = 90;
const HEADER_H = 46 + CAPTION_H;
/** Space between the screens of a stacked shot, so each reads as its own frame. */
export const SCREEN_GAP = 20;
const MAX_H = 1120; // cap very tall full-page shots so the overview stays tidy

/** Roughly the shape of a screen — what "fit to window" has to fill. */
const TARGET_ASPECT = 1.6;

/**
 * How tall a tile of width `w` is drawn, and where it's cut.
 *
 * A shot of stacked screens is cut at a screen's edge rather than through the
 * middle of one, so the canvas only ever shows whole screens: a half screen reads
 * as a broken capture.
 */
export function tileHeight(
  tile: ViewerTile,
  w: number,
): { h: number; cropped: boolean; screenH?: number; screensShown?: number } {
  const full = w * aspect(tile);
  const n = tile.screens;
  if (!n || n < 2) return { h: Math.min(full, MAX_H), cropped: full > MAX_H };
  const screenH = full / n;
  const screensShown = Math.max(
    1,
    Math.min(n, Math.floor((MAX_H + SCREEN_GAP) / (screenH + SCREEN_GAP))),
  );
  return {
    h: screensShown * screenH + (screensShown - 1) * SCREEN_GAP,
    cropped: screensShown < n,
    screenH,
    screensShown,
  };
}

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

export function computeLayout(data: ViewerData, filters: LayoutFilters): Layout {
  const { devices: deviceFilter, kinds, query = "", failedOnly, limit, routeId } = filters;
  const devices = data.devices.filter((d) => deviceFilter.has(d.name));
  const maxW = Math.max(1, ...devices.map((d) => d.width));
  const colW = (d: Device) => Math.max(60, Math.round((CARD * d.width) / maxW));
  /** The room a tile takes in its row: its own width, or its caption's if wider. */
  const slotW = (w: number) => Math.max(w, CAPTION_MIN_W);

  const matching = data.tiles.filter(
    (t) =>
      deviceFilter.has(t.device) &&
      (!kinds || kinds.size === 0 || kinds.has(t.stateKind)) &&
      (!failedOnly || t.error !== undefined) &&
      matchesQuery(t, query),
  );
  const routesMatching = new Set(matching.map((t) => t.routeId));
  const routesWithTiles = data.groups.map((g) => g.routeId).filter((id) => routesMatching.has(id));

  // The sidebar still lists every route the filters leave, so it can switch to them.
  const inScope = routeId ? matching.filter((t) => t.routeId === routeId) : matching;
  const tiles = limit !== undefined && inScope.length > limit ? inScope.slice(0, limit) : inScope;
  const truncated = inScope.length - tiles.length;

  const placed: Placed[] = [];
  const labels: GroupLabel[] = [];
  const bounds = emptyBounds();
  const byRoute = new Map<string, Bounds>();

  const place = (tile: ViewerTile, x: number, y: number, w: number): number => {
    const { h, cropped, screenH, screensShown } = tileHeight(tile, w);
    placed.push({ tile, x, y, w, h, cropped, screenH, screensShown });
    growBounds(bounds, x, y, w, h);
    const rb = byRoute.get(tile.routeId) ?? emptyBounds();
    growBounds(rb, x, y, w, h);
    byRoute.set(tile.routeId, rb);
    return h;
  };

  // Index once — per-group filter/find scans are O(routes × tiles) and this
  // recomputes on every search keystroke.
  const tilesByRoute = new Map<string, ViewerTile[]>();
  for (const t of tiles) {
    const arr = tilesByRoute.get(t.routeId);
    if (arr) arr.push(t);
    else tilesByRoute.set(t.routeId, [t]);
  }

  const rowWidth = Math.max(1, devices.reduce((sum, d) => sum + slotW(colW(d)) + GAP, 0) - GAP);

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
          return Math.max(h, tileHeight(t, colW(devices[i])).h);
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

  const rowHeight = (row: GroupBlock["rows"][number]) =>
    row.tiles.reduce((h, t, i) => (t ? Math.max(h, tileHeight(t, colW(devices[i])).h) : h), 0);

  // One route on its own would be a single tall column of states, which Fit can
  // only show as a sliver; its states flow across columns instead, under one header.
  if (blocks.length === 1) {
    const block = blocks[0];
    const heights = block.rows.map(rowHeight);
    const total = heights.reduce((sum, h) => sum + h + ROW_GAP, 0);
    const columns = columnCount(total, rowWidth, block.rows.length);
    const columnY = new Array<number>(columns).fill(HEADER_H);
    block.rows.forEach((row, r) => {
      let col = 0;
      for (let i = 1; i < columns; i++) if (columnY[i] < columnY[col]) col = i;
      let x = col * (rowWidth + SECTION_GAP);
      row.tiles.forEach((t, i) => {
        const w = colW(devices[i]);
        if (t) place(t, x, columnY[col], w);
        x += slotW(w) + GAP;
      });
      columnY[col] += heights[r] + ROW_GAP;
    });
    const width = columns * rowWidth + (columns - 1) * SECTION_GAP;
    growBounds(bounds, 0, 0, width, HEADER_H);
    const rb = byRoute.get(block.routeId) ?? emptyBounds();
    growBounds(rb, 0, 0, width, HEADER_H);
    byRoute.set(block.routeId, rb);
    labels.push({
      routeId: block.routeId,
      title: block.title,
      subtitle: `${block.stateIds.length} state${block.stateIds.length === 1 ? "" : "s"}`,
      path: routePath(block.path),
      x: 0,
      y: 0,
      w: width,
    });
    return { placed, labels, bounds, byRoute, routesWithTiles, truncated };
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
        x += slotW(w) + GAP;
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

  if (!placed.length) Object.assign(bounds, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  return { placed, labels, bounds, byRoute, routesWithTiles, truncated };
}
