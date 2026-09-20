import type { Placed } from "./layout";

/**
 * Directional navigation between tiles (shift+arrows).
 *
 * Centre-to-centre distance is the obvious metric and the wrong one here: a
 * full-page mobile shot can be ten times the height of the desktop shot beside it,
 * so their centres are far apart vertically even though the tiles are side by side.
 * Ranking by edge distance along the axis, and treating perpendicular *overlap* as
 * the tie-breaker, matches what the eye reads as "the next one over".
 */

/**
 * Alignment is ranked ahead of distance, not merely weighted against it: pressing
 * Up from the bottom of a column should reach the tile above it, even when some
 * very tall tile in the next column happens to end nearer. Only when nothing lines
 * up at all does the nearest off-axis tile win.
 */
const MISALIGNED = 1e9;
const MISALIGNMENT_WEIGHT = 4;

export function nextTileId(
  placed: Placed[],
  currentId: string | null,
  dx: -1 | 0 | 1,
  dy: -1 | 0 | 1,
): string | undefined {
  if (!placed.length) return undefined;
  const current = placed.find((p) => p.tile.id === currentId);
  if (!current) return placed[0].tile.id;

  const horizontal = dx !== 0;
  let best: Placed | undefined;
  let bestCost = Infinity;

  for (const p of placed) {
    if (p === current) continue;

    // Edge-to-edge gap in the direction of travel; negative means overlapping or behind.
    const ahead = horizontal
      ? dx > 0
        ? p.x - (current.x + current.w)
        : current.x - (p.x + p.w)
      : dy > 0
        ? p.y - (current.y + current.h)
        : current.y - (p.y + p.h);
    // Allow a small negative gap so neighbours that overlap slightly still count,
    // but never step to something that starts behind where we already are.
    const startsAhead = horizontal
      ? dx > 0
        ? p.x > current.x
        : p.x < current.x
      : dy > 0
        ? p.y > current.y
        : p.y < current.y;
    if (!startsAhead) continue;

    const [aMin, aMax, bMin, bMax] = horizontal
      ? [current.y, current.y + current.h, p.y, p.y + p.h]
      : [current.x, current.x + current.w, p.x, p.x + p.w];
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    // Lined up → ranked purely by distance. Not lined up → always loses to anything
    // that is, and among the rest the least off-axis wins.
    const misalignment = overlap > 0 ? 0 : MISALIGNED + -overlap * MISALIGNMENT_WEIGHT;

    const cost = Math.max(0, ahead) + misalignment;
    if (cost < bestCost) {
      bestCost = cost;
      best = p;
    }
  }

  return best?.tile.id;
}
