import type { Bounds, GroupLabel, Layout, Placed } from "./layout";
import { columnCount } from "./layout";
import type { RunDiff, ShotDiff } from "./diff-types";
import type { ViewerTile } from "./types";

/**
 * Laying a run comparison out on the same canvas as the catalog.
 *
 * `visualice diff` already decides what changed and draws the highlight images;
 * what it can't do from the command line is put the three pictures next to each
 * other. Each changed shot becomes one block of three tiles — before, after,
 * diff — so the answer to "what moved" is a glance rather than a filename.
 *
 * The three images come from three different directories (two runs and the diff),
 * which is why these tiles carry paths relative to the server root instead of the
 * single run prefix the catalog uses.
 */

const CARD = 460;
const GAP = 20;
const HEADER_H = 56;
const SECTION_GAP = 80;
const MAX_H = 1120;

/** Which side of a comparison a tile shows. */
export type DiffSide = "before" | "after" | "diff";

export interface DiffLayoutOptions {
  /** Directory name of the comparison, for resolving its diff images. */
  diffId: string;
  query?: string;
  /** Also lay out the pairs that didn't change. Off by default — a diff is about what moved. */
  includeUnchanged?: boolean;
  limit?: number;
}

/** A shot's aspect ratio from whichever side of the comparison reported one. */
function aspectOf(shot: ShotDiff): number {
  const size = shot.toSize ?? shot.fromSize;
  if (size && size.width > 0) return size.height / size.width;
  return 0.66;
}

function tileFor(shot: ShotDiff, side: DiffSide, src: string | undefined): ViewerTile {
  return {
    id: `${shot.key}|${side}`,
    routeId: shot.key,
    routeUrl: shot.routeUrl ?? shot.route,
    routePath: shot.route,
    stateId: shot.state,
    stateLabel: `${side} · ${shot.stateLabel}`,
    stateKind: "other",
    device: side,
    full: src,
    width: side === "before" ? shot.fromSize?.width : shot.toSize?.width,
    height: side === "before" ? shot.fromSize?.height : shot.toSize?.height,
    // A missing side is a real outcome, not a broken tile: a page that only exists
    // in one of the two runs has nothing to show on the other side, and saying so
    // in place is clearer than leaving a gap.
    error: src ? undefined : side === "diff" ? "no diff image" : "not in this run",
  };
}

/** How a block describes itself in its header. */
function describe(shot: ShotDiff): string {
  if (shot.status === "added") return "added in the new run";
  if (shot.status === "removed") return "gone from the new run";
  if (shot.status === "uncomparable") return shot.note ?? "could not be compared";
  const pct = shot.ratio !== undefined ? `${(shot.ratio * 100).toFixed(2)}% of pixels` : "changed";
  return shot.sizeChanged ? `${pct} · page height changed` : pct;
}

function matches(shot: ShotDiff, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    shot.route.toLowerCase().includes(s) ||
    (shot.routeUrl ?? "").toLowerCase().includes(s) ||
    shot.state.toLowerCase().includes(s) ||
    shot.stateLabel.toLowerCase().includes(s) ||
    shot.device.toLowerCase().includes(s)
  );
}

/**
 * The shots a comparison is worth showing, most-changed first.
 *
 * Unchanged pairs are the bulk of any diff and carry no information; sorting the
 * rest by how much moved puts the thing someone opened the diff for at the top.
 */
export function interestingShots(diff: RunDiff, includeUnchanged = false): ShotDiff[] {
  const rank: Record<string, number> = {
    changed: 0,
    added: 1,
    removed: 2,
    uncomparable: 3,
    unchanged: 4,
  };
  return diff.shots
    .filter((s) => includeUnchanged || s.status !== "unchanged")
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (b.ratio ?? 0) - (a.ratio ?? 0) ||
        a.key.localeCompare(b.key),
    );
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function grow(b: Bounds, x: number, y: number, w: number, h: number): void {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.maxX = Math.max(b.maxX, x + w);
  b.maxY = Math.max(b.maxY, y + h);
}

export function computeDiffLayout(diff: RunDiff, opts: DiffLayoutOptions): Layout {
  const { diffId, query = "", includeUnchanged, limit } = opts;
  const matching = interestingShots(diff, includeUnchanged).filter((s) => matches(s, query));
  const shots =
    limit !== undefined && matching.length > limit ? matching.slice(0, limit) : matching;
  const truncated = matching.length - shots.length;

  const placed: Placed[] = [];
  const labels: GroupLabel[] = [];
  const bounds = emptyBounds();
  const byRoute = new Map<string, Bounds>();

  const rowWidth = CARD * 3 + GAP * 2;
  const blockHeight = (shot: ShotDiff) => HEADER_H + Math.min(CARD * aspectOf(shot), MAX_H);
  const totalHeight = shots.reduce((sum, s) => sum + blockHeight(s) + SECTION_GAP, 0);
  const columns = columnCount(totalHeight, rowWidth, shots.length);
  const columnX = Array.from({ length: columns }, (_, i) => i * (rowWidth + SECTION_GAP));
  const columnY = new Array<number>(columns).fill(0);

  for (const shot of shots) {
    let col = 0;
    for (let i = 1; i < columns; i++) if (columnY[i] < columnY[col]) col = i;
    const x0 = columnX[col];
    const labelY = columnY[col];
    const y = labelY + HEADER_H;

    grow(bounds, x0, labelY, rowWidth, HEADER_H);
    const rb = emptyBounds();
    grow(rb, x0, labelY, rowWidth, HEADER_H);

    const sides: [DiffSide, string | undefined][] = [
      ["before", shot.fromShot && `runs/${diff.from.runId}/${shot.fromShot}`],
      ["after", shot.toShot && `runs/${diff.to.runId}/${shot.toShot}`],
      ["diff", shot.image && `diffs/${diffId}/${shot.image}`],
    ];
    const h = Math.min(CARD * aspectOf(shot), MAX_H);
    sides.forEach(([side, src], i) => {
      const x = x0 + i * (CARD + GAP);
      placed.push({ tile: tileFor(shot, side, src), x, y, w: CARD, h, cropped: false });
      grow(bounds, x, y, CARD, h);
      grow(rb, x, y, CARD, h);
    });

    byRoute.set(shot.key, rb);
    labels.push({
      routeId: shot.key,
      title: `${shot.routeUrl ?? "/" + shot.route} · ${shot.state}`,
      subtitle: `${shot.device}  ·  ${describe(shot)}`,
      x: x0,
      y: labelY,
      w: rowWidth,
    });
    columnY[col] = y + h + SECTION_GAP;
  }

  if (!placed.length) Object.assign(bounds, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  return { placed, labels, bounds, byRoute, routesWithTiles: [...byRoute.keys()], truncated };
}
