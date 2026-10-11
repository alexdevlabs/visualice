import type { GroupLabel, Placed } from "./layout";

/**
 * Virtualization + level-of-detail: the two rules that keep the canvas usable on
 * large runs. Kept as pure functions (no React, no DOM) so they can be unit
 * tested and so an alternate renderer — WebGL, OpenSeadragon — can reuse them.
 */

export interface Viewport {
  w: number;
  h: number;
}

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

/** World-space rectangle currently on screen, grown by `margin` screen px. */
export function visibleWorldRect(
  t: Transform,
  vp: Viewport,
  margin = 0,
): { x0: number; y0: number; x1: number; y1: number } {
  const m = margin / t.scale;
  return {
    x0: -t.x / t.scale - m,
    y0: -t.y / t.scale - m,
    x1: (vp.w - t.x) / t.scale + m,
    y1: (vp.h - t.y) / t.scale + m,
  };
}

/** Tiles intersecting the viewport (+ margin). Everything else stays unmounted. */
export function cullTiles(placed: Placed[], t: Transform, vp: Viewport, margin = 400): Placed[] {
  const { x0, y0, x1, y1 } = visibleWorldRect(t, vp, margin);
  return placed.filter((p) => p.x + p.w >= x0 && p.x <= x1 && p.y + p.h >= y0 && p.y <= y1);
}

/** Group headers intersecting the viewport. Labels are short, so height is fixed. */
export function cullLabels(
  labels: GroupLabel[],
  t: Transform,
  vp: Viewport,
  margin = 200,
  labelH = 60,
): GroupLabel[] {
  const { y0, y1, x1 } = visibleWorldRect(t, vp, margin);
  return labels.filter((l) => l.y <= y1 && l.y + labelH >= y0 && l.x <= x1);
}

// ---- Spatial index ----

/**
 * A uniform grid over the placed tiles.
 *
 * Culling by scanning every tile is O(all tiles) on every pan frame, which is the
 * one piece of per-frame work that grows with run size. Bucketing by cell makes it
 * proportional to what's actually on screen. Tiles spanning several cells are
 * listed in each, so lookups dedupe.
 */
export interface TileIndex {
  cell: number;
  buckets: Map<string, Placed[]>;
  all: Placed[];
  /** Each tile's position in `all`, so culled results can be put back in layout order. */
  order: Map<Placed, number>;
}

/** Cells sized to a few typical tiles: small enough to be selective, few enough to be cheap. */
const DEFAULT_CELL = 1200;

export function buildTileIndex(placed: Placed[], cell = DEFAULT_CELL): TileIndex {
  const buckets = new Map<string, Placed[]>();
  for (const p of placed) {
    const cx0 = Math.floor(p.x / cell);
    const cy0 = Math.floor(p.y / cell);
    const cx1 = Math.floor((p.x + p.w) / cell);
    const cy1 = Math.floor((p.y + p.h) / cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = `${cx},${cy}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(p);
        else buckets.set(key, [p]);
      }
    }
  }
  return { cell, buckets, all: placed, order: new Map(placed.map((p, i) => [p, i])) };
}

/** Same result as `cullTiles`, but only touching the cells the viewport covers. */
export function cullTilesIndexed(
  index: TileIndex,
  t: Transform,
  vp: Viewport,
  margin = 400,
): Placed[] {
  const { x0, y0, x1, y1 } = visibleWorldRect(t, vp, margin);
  const { cell, buckets } = index;
  const cx0 = Math.floor(x0 / cell);
  const cy0 = Math.floor(y0 / cell);
  const cx1 = Math.floor(x1 / cell);
  const cy1 = Math.floor(y1 / cell);

  // Zoomed far enough out that the viewport spans more cells than there are
  // buckets: scanning the tiles directly is then the cheaper of the two.
  const cellsCovered = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
  if (cellsCovered > buckets.size) return cullTiles(index.all, t, vp, margin);

  const seen = new Set<Placed>();
  const out: Placed[] = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const bucket = buckets.get(`${cx},${cy}`);
      if (!bucket) continue;
      for (const p of bucket) {
        if (seen.has(p)) continue;
        seen.add(p);
        if (p.x + p.w >= x0 && p.x <= x1 && p.y + p.h >= y0 && p.y <= y1) out.push(p);
      }
    }
  }
  // Preserve layout order so React keys and the DOM stay stable while panning. By
  // lookup, not `indexOf`: this runs every frame, and a linear scan per comparison
  // would cost more than the grid saved.
  const { order } = index;
  return out.sort((a, b) => order.get(a)! - order.get(b)!);
}

// ---- Level of detail ----

/** Below this on-screen width, in device pixels, a thumbnail is indistinguishable from the full image. */
export const FULL_RES_WIDTH_PX = 460;

/** Above this on-screen width the mid tier stops being enough and the full image wins. */
export const MID_RES_WIDTH_PX = 1100;

export interface LodSources {
  full?: string;
  thumb?: string;
  mid?: string;
}

/**
 * Which source to draw for a tile, smallest that still looks right:
 * thumbnail → mid → full. The mid step exists because jumping from a 480px
 * thumbnail straight to a multi-megabyte dpr-3 full-page PNG stalls the canvas at
 * exactly the zoom level where someone is trying to read the page.
 */
export function lodFor(tile: LodSources, onScreenWidth: number): string | undefined {
  if (onScreenWidth <= FULL_RES_WIDTH_PX && tile.thumb) return tile.thumb;
  if (onScreenWidth <= MID_RES_WIDTH_PX && tile.mid) return tile.mid;
  return tile.full ?? tile.mid ?? tile.thumb;
}

/** Tile captions become noise once tiles are tiny. */
export const TILE_LABEL_MIN_SCALE = 0.18;
