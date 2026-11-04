// Core data shapes shared by the crawl engine, the manifest, and the viewer.

export interface Device {
  name: string;
  width: number;
  height: number;
  dpr: number;
  mobile?: boolean;
  touch?: boolean;
  userAgent?: string;
  colorScheme?: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  locale?: string;
  timezoneId?: string;
  /** Engine this device is captured with (default chromium). */
  browser?: "chromium" | "firefox" | "webkit";
}

/** A robust way to point at an element. Resolved in priority order (see selectors.ts). */
export interface Target {
  role?: string;
  name?: string;
  testId?: string;
  label?: string;
  text?: string;
  selector?: string;
  exact?: boolean;
  nth?: number;
}

export type RecipeStep =
  | { action: "navigate"; url: string }
  | { action: "click"; target: Target }
  | { action: "hover"; target: Target }
  | { action: "focus"; target: Target }
  /** Move focus off whatever holds it — what makes a "touched" field show its error. */
  | { action: "blur" }
  | { action: "fill"; target: Target; value: string }
  /** Choose `<select>` option(s) by value or visible label. */
  | { action: "select"; target: Target; value: string | string[] }
  | { action: "press"; key: string; target?: Target }
  | {
      action: "waitFor";
      selector?: string;
      url?: string;
      state?: "visible" | "hidden" | "attached" | "detached";
      timeoutMs?: number;
    }
  | { action: "scroll"; to: "top" | "bottom" | number }
  | { action: "wait"; ms: number };

export type StateKind =
  | "default"
  | "menu"
  | "modal"
  | "drawer"
  | "accordion"
  | "tab"
  | "popover"
  | "toast"
  | "hover"
  | "focus"
  | "validation"
  | "component"
  | "other";

/**
 * Where one screen of a stacked shot sat on the page, in image px, so the viewer
 * can join the screens into one page without the bars pinned to the window
 * repeating on each.
 */
export interface ScreenFrame {
  /** The page position at the screen's first row (scroll offset less any chrome above the scroller). */
  y: number;
  /** Rows at the top of the screen covered by something pinned: a sticky header, an app bar. */
  top: number;
  /** Rows at the bottom covered the same way: a cookie bar, a bottom tab bar. */
  bottom: number;
}

export interface ShotRef {
  full?: string; // path (relative to run dir) of full-page screenshot
  viewport?: string; // path of viewport-only screenshot
  thumb?: string; // path of thumbnail (of full)
  mid?: string; // path of the mid-resolution step between thumb and full
  meta?: string; // path of sidecar json
  width?: number; // intrinsic px dims of the full shot
  height?: number;
  /** The page exceeded `screenshot.maxHeight` (or `maxScreens`) and was cropped to it. */
  clamped?: boolean;
  /**
   * How many screens the full image stacks, top to bottom, each one viewport tall.
   * Absent for a single render (a viewport shot, an element, or `screens: false`).
   */
  screens?: number;
  /** One entry per screen in `screens`, top to bottom. */
  frames?: ScreenFrame[];
  /** Accessibility rules this state broke, when `checks.accessibility` is on. */
  a11y?: number;
  error?: string; // capture was attempted but failed (after retries); no image written
}

/** One route×state×device capture that failed after all retries. */
export interface CaptureFailure {
  route: string;
  state: string;
  device: string;
  error: string;
}

/** A state requested in the routes file that no cached recipe realizes yet. */
export interface WantedState {
  route: string;
  state: string;
  description?: string;
}

export interface StateNode {
  id: string;
  kind: StateKind;
  label: string;
  trigger?: Target;
  recipe: RecipeStep[];
  signature?: string;
  /**
   * What the state is regardless of the page it was found on: its recipe, the
   * devices it applies to, and the text it brought on screen, hashed. Two pages
   * with the same `siteKey` opened the same thing — a header dropdown, a chat
   * widget — and the site-wide copy only needs capturing once.
   */
  siteKey?: string;
  /**
   * Provenance. "auto" = found by the heuristic discoverer (safe to refresh on a
   * re-crawl). "authored" = hand-written or Explore-mode authored (never clobbered
   * by auto-discovery). Absent is treated as "authored" so legacy/hand-edited cache
   * entries are protected by default.
   */
  source?: "auto" | "authored";
  /**
   * Restrict capture to these device names (e.g. a hamburger menu that only exists
   * on mobile viewports). Absent = capture on every configured device.
   */
  devices?: string[];
  /**
   * Screenshot only this element instead of the page — a component captured on its
   * own. A route that doesn't have it is skipped, not failed.
   */
  element?: string;
  /**
   * Capture in a browser context of its own, started from the signed-in storage
   * state: what the recipe stores (a cart, a dismissed banner, a preference) can't
   * leak into the shots taken after it, and what earlier states stored can't leak
   * into this one. For recipes that change the site's data, not just what's open.
   */
  isolate?: boolean;
  shots: Record<string, ShotRef>; // keyed by device name
}

export interface RouteNode {
  id: string;
  url: string; // path or absolute, as authored
  finalUrl?: string; // post-redirect location: an origin-relative path, or an absolute url if it left the origin
  title?: string;
  status?: number;
  depth: number;
  discoveredFrom?: string | null;
  links?: string[];
  states: StateNode[];
}

export interface SiteInfo {
  baseUrl: string;
  origin: string;
  /**
   * Where the live pages are, when not at `baseUrl`'s origin: routes resolve under it
   * ("/about" → `<liveBase>/about`). For a catalogue of a copy served at a subpath, like
   * the docs site's demo. Never written by a crawl.
   */
  liveBase?: string;
  title?: string;
  framework?: string;
  runId: string;
  generatedAt: string;
}

export interface Manifest {
  version: number;
  site: SiteInfo;
  configSnapshot?: unknown;
  devices: Device[];
  auth?: { method: string; notes?: string };
  routes: RouteNode[];
  stats?: {
    routes: number;
    states: number;
    shots: number;
    failed: number;
    durationMs: number;
    failures: CaptureFailure[];
    /** Routes-file requests still unmet after this run (the Explore-mode queue). */
    wanted?: WantedState[];
    /** Accessibility violations by rule, when `checks.accessibility` is on. */
    accessibility?: {
      id: string;
      impact?: string;
      help: string;
      helpUrl?: string;
      shots: number;
      elements: number;
    }[];
  };
  hints?: {
    stableSelectors?: string[];
    flakyRegions?: string[];
    skipTriggers?: string[];
    notes?: string;
  };
}

/** Loose shape accepted as capture input (shots get filled in by the engine). */
export interface InputManifest {
  site?: Partial<SiteInfo>;
  auth?: Manifest["auth"];
  hints?: Manifest["hints"];
  routes: RouteNode[];
}

// ---- Viewer data ----

export interface ViewerTile {
  id: string;
  routeId: string;
  routeUrl: string;
  routePath: string;
  stateId: string;
  stateLabel: string;
  stateKind: StateKind;
  device: string;
  /** Absent on a failed capture — `error` says why. */
  full?: string;
  thumb?: string;
  /** Mid-resolution step between `thumb` and `full`. */
  mid?: string;
  /** Above-the-fold crop, when `screenshot.alsoViewport` is on. */
  viewport?: string;
  width?: number;
  height?: number;
  /** The page was taller than `screenshot.maxHeight` and the shot was cropped. */
  clamped?: boolean;
  /** Screens stacked in the image, each one viewport tall; see `ShotRef.screens`. */
  screens?: number;
  /** Where each of those screens sat on the page; see `ShotRef.frames`. */
  frames?: ScreenFrame[];
  /** Sidecar JSON with the shot's metadata (and its accessibility findings). */
  meta?: string;
  /** Accessibility rules this state broke. */
  a11y?: number;
  /** Capture failed after retries; the tile is a placeholder carrying the reason. */
  error?: string;
}

export interface ViewerData {
  site: SiteInfo;
  devices: Device[];
  tiles: ViewerTile[];
  groups: { path: string; routeId: string; title?: string }[];
  /** How many tiles are failed captures, so the UI can say so without a scan. */
  failed?: number;
}
