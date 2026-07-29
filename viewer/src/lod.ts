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

/** Below this on-screen width a thumbnail is indistinguishable from the full image. */
export const FULL_RES_WIDTH_PX = 460;

/**
 * Which source to draw for a tile: the thumbnail while it is small on screen,
 * the full-resolution image once it is big enough to show the difference (or
 * when no thumbnail was generated).
 */
export function lodFor(tile: { full: string; thumb?: string }, onScreenWidth: number): string {
  return onScreenWidth > FULL_RES_WIDTH_PX || !tile.thumb ? tile.full : tile.thumb;
}

/** Tile captions become noise once tiles are tiny. */
export const TILE_LABEL_MIN_SCALE = 0.18;
