// Core data shapes shared by the crawl engine, the manifest, and the viewer.

export interface Device {
  name: string;
  width: number;
  height: number;
  dpr: number;
  mobile?: boolean;
  touch?: boolean;
  userAgent?: string;
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
  | { action: "fill"; target: Target; value: string }
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
  | "other";

export interface ShotRef {
  full?: string; // path (relative to run dir) of full-page screenshot
  viewport?: string; // path of viewport-only screenshot
  thumb?: string; // path of thumbnail (of full)
  meta?: string; // path of sidecar json
  width?: number; // intrinsic px dims of the full shot
  height?: number;
}

export interface StateNode {
  id: string;
  kind: StateKind;
  label: string;
  trigger?: Target;
  recipe: RecipeStep[];
  signature?: string;
  /**
   * Provenance. "auto" = found by the heuristic discoverer (safe to refresh on a
   * re-crawl). "authored" = hand-written or Explore-mode authored (never clobbered
   * by auto-discovery). Absent is treated as "authored" so legacy/hand-edited cache
   * entries are protected by default.
   */
  source?: "auto" | "authored";
  shots: Record<string, ShotRef>; // keyed by device name
}

export interface RouteNode {
  id: string;
  url: string; // path or absolute, as authored
  finalUrl?: string; // post-redirect absolute url (filled at capture)
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
  stats?: { routes: number; states: number; shots: number; durationMs: number };
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
  full: string;
  thumb?: string;
  width?: number;
  height?: number;
}

export interface ViewerData {
  site: SiteInfo;
  devices: Device[];
  tiles: ViewerTile[];
  groups: { path: string; routeId: string; title?: string }[];
}
