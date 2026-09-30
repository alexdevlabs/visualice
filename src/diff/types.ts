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
  /** Differing pixels not counted because they were anti-aliasing. */
  antialiasedPixels?: number;
  /** Pixels inside an ignore region (`diff.rules[].ignore`). */
  ignoredPixels?: number;
  /** The noise floor this shot was held to, when a rule set one other than the run's. */
  minRatio?: number;
  /** Diff image, relative to the diff directory. */
  image?: string;
  /** A small version of `image`, so a long list of changes paints before the full ones load. */
  imageThumb?: string;
  /**
   * The two shots themselves, each relative to its own run directory.
   *
   * Recorded rather than re-derived: a reader that has the report but not the
   * engine would otherwise have to reimplement the slugging rules (and guess the
   * image extension) to find the pictures the numbers are about.
   */
  fromShot?: string;
  toShot?: string;
  /** Each shot's lower-resolution previews, where the run wrote them. */
  fromPreview?: string;
  toPreview?: string;
  note?: string;
}

export interface RunDiff {
  /** `baseline` when this side is the approved baseline rather than a run directory. */
  from: { runId: string; dir: string; baseline?: boolean };
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
