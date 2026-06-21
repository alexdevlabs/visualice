import type { ViewerData, ViewerTile, Device } from "./types";

export type LayoutMode = "grouped" | "all";

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
}

const CARD = 360; // world px for the widest device
const GAP = 26;
const ROW_GAP = 30;
const SECTION_GAP = 90;
const HEADER_H = 52;
const MAX_H = 1120; // cap very tall full-page shots so the overview stays tidy

function aspect(t: ViewerTile): number {
  if (t.width && t.height && t.width > 0) return t.height / t.width;
  return 0.66;
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

export function computeLayout(
  data: ViewerData,
  mode: LayoutMode,
  deviceFilter: Set<string>,
  query: string,
): Layout {
  const devices = data.devices.filter((d) => deviceFilter.has(d.name));
  const maxW = Math.max(1, ...devices.map((d) => d.width));
  const colW = (d: Device) => Math.max(60, Math.round((CARD * d.width) / maxW));

  const tiles = data.tiles.filter((t) => deviceFilter.has(t.device) && matchesQuery(t, query));

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

  if (mode === "grouped") {
    const rowWidth = devices.reduce((sum, d) => sum + colW(d) + GAP, 0) - GAP;
    let y = 0;
    for (const g of data.groups) {
      const routeTiles = tiles.filter((t) => t.routeId === g.routeId);
      if (!routeTiles.length) continue;
      const stateIds = [...new Set(routeTiles.map((t) => t.stateId))];

      const rb = emptyBounds();
      const labelY = y;
      growBounds(bounds, 0, y, rowWidth, HEADER_H);
      growBounds(rb, 0, y, Math.max(rowWidth, 1), HEADER_H);
      y += HEADER_H;

      for (const sid of stateIds) {
        let x = 0;
        let rowH = 0;
        for (const d of devices) {
          const t = routeTiles.find((tt) => tt.stateId === sid && tt.device === d.name);
          const w = colW(d);
          if (t) rowH = Math.max(rowH, place(t, x, y, w));
          x += w + GAP;
        }
        y += rowH + ROW_GAP;
      }
      // merge route bounds (place() already grew byRoute for tiles; include header)
      const existing = byRoute.get(g.routeId) ?? emptyBounds();
      growBounds(existing, 0, labelY, Math.max(rowWidth, 1), HEADER_H);
      byRoute.set(g.routeId, existing);
      labels.push({
        routeId: g.routeId,
        title: g.title || g.path,
        subtitle: `${g.path === "home" ? "/" : "/" + g.path}  ·  ${stateIds.length} state(s)`,
        x: 0,
        y: labelY,
        w: rowWidth,
      });
      y += SECTION_GAP;
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
  return { placed, labels, bounds, byRoute };
}
