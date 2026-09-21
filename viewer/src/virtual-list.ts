/**
 * Row virtualization for the sidebar.
 *
 * The canvas has been virtualized since the start, but the path list was not: a run
 * with hundreds of routes builds hundreds of DOM nodes that are mostly scrolled out
 * of sight, and they are rebuilt on every filter keystroke. Rendering only the rows
 * in view — plus a margin, so scrolling doesn't reveal blank space — makes the cost
 * proportional to the panel rather than the run.
 *
 * Pure so it can be tested without a DOM; the component is a thin wrapper.
 */

export interface RowRange {
  start: number;
  end: number;
  /** Spacer height above and below the rendered rows, keeping the scrollbar honest. */
  padTop: number;
  padBottom: number;
}

/**
 * Which rows to render for a fixed-height list.
 *
 * `end` is exclusive. `overscan` rows are kept on each side so a fast scroll has
 * something to show before the next render lands.
 */
export function rowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = 6,
): RowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  // A list that hasn't been measured yet (height 0) must still render something,
  // or the first paint is empty and nothing ever triggers a scroll to fix it.
  const visible = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) : count;
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const start = Math.min(first, Math.max(0, count - 1));
  const end = Math.min(count, start + visible + overscan * 2);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (count - end) * rowHeight,
  };
}

/**
 * Below this many rows the list renders in full.
 *
 * Virtualization costs a scroll listener, a measured container and rows pinned to a
 * fixed height; a twenty-route run pays all of that for nothing.
 */
export const VIRTUALIZE_ABOVE = 60;
