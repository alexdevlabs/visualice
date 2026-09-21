/**
 * The shape of `diff.json`.
 *
 * Kept free of runtime imports so the viewer can read these types directly rather
 * than keeping a second copy in sync — the same arrangement `viewer/src/types.ts`
 * uses for the manifest.
 */

export type ShotStatus = "added" | "removed" | "changed" | "unchanged" | "uncomparable";

export interface ShotDiff {
  key: string;
  route: string;
  /** The route's URL path, for display — `route` is its filesystem slug. */
  routeUrl?: string;
  state: string;
  stateLabel: string;
  device: string;
  status: ShotStatus;
  /** Fraction of compared pixels that differ (0–1), for a compared pair. */
  ratio?: number;
  changedPixels?: number;
  comparedPixels?: number;
  /** Set when the two shots have different dimensions. */
  sizeChanged?: boolean;
  /** With `sizeChanged`: the share of the larger shot that the other doesn't cover. */
  sizeRatio?: number;
  fromSize?: { width: number; height: number };
  toSize?: { width: number; height: number };
  /** Diff image, relative to the diff directory. */
  image?: string;
  /**
   * The two shots themselves, each relative to its own run directory.
   *
   * Recorded rather than re-derived: a reader that has the report but not the
   * engine would otherwise have to reimplement the slugging rules (and guess the
   * image extension) to find the pictures the numbers are about.
   */
  fromShot?: string;
  toShot?: string;
  note?: string;
}

export interface RunDiff {
  from: { runId: string; dir: string };
  to: { runId: string; dir: string };
  /** Ratio above which a pair counts as changed — of pixels, or of area gained or lost. */
  minRatio: number;
  routes: { added: string[]; removed: string[] };
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    uncomparable: number;
  };
  shots: ShotDiff[];
  /** Where the report and diff images were written (absent for a dry comparison). */
  outDir?: string;
}
