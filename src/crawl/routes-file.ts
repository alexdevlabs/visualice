import { canonicalPath } from "../shared/url";
import { redactUrl } from "../shared/redact";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";
import type {
  InputManifest,
  RouteNode,
  SourceInfo,
  StateNode,
  Target,
  WantedState,
} from "../shared/types";
import { routeMatches } from "../shared/glob";
import { isAuthored } from "./manifest";
import { parseSourceLine, renderSourceLine } from "./source";

// The routes file (`visualice.routes.md`) is the human/LLM-facing site index: a
// two-level markdown list where only two tokens are load-bearing — the route path
// and the state id. It is parsed tolerantly before a run (intent: seeds, skips,
// wanted states) and regenerated deterministically after (the cache stays the
// mechanical truth; this file is the intent truth).

export interface RoutesFileState {
  id: string;
  description?: string;
  /** `[ ]` line — requested but no recipe exists yet. */
  wanted?: boolean;
  /** `skip:` line — don't capture this state. */
  skip?: boolean;
}

export interface RoutesFileRoute {
  path: string;
  label?: string;
  states: RoutesFileState[];
}

export interface RoutesIntent {
  /** Target URL from the `# Routes — <url>` header, if present. */
  target?: string;
  routes: RoutesFileRoute[];
  /** Top-level `skip:` globs — excluded from discovery and capture. */
  skipRoutes: string[];
  /** The commit the catalogue was last captured from (the `visualice-source` line). */
  source?: SourceInfo;
  warnings: string[];
}

export type { WantedState };

export const emptyRoutesIntent = (): RoutesIntent => ({
  routes: [],
  skipRoutes: [],
  warnings: [],
});

const SLUG = /^[A-Za-z0-9][\w.-]*$/;

const isRoutePath = (p: string): boolean => p.startsWith("/") || /^https?:\/\//.test(p);

/** Split a bullet's content into the part before ` — ` and the freeform rest. */
function splitDash(content: string): { head: string; rest?: string } {
  const i = content.indexOf(" — ");
  if (i < 0) return { head: content.trim() };
  return { head: content.slice(0, i).trim(), rest: content.slice(i + 3).trim() || undefined };
}

/**
 * Parse a routes file. Tolerant by design: unknown lines (prose, comments, junk)
 * are ignored — only route/state bullets and `skip:` markers carry meaning.
 */
export function parseRoutesFile(
  text: string,
  /**
   * How discovery writes a path (trailing slash dropped, query sorted), so a page
   * typed as `/pricing/` is the model's `/pricing` and not a second page beside it.
   */
  canonical: (path: string) => string = (p) => p,
): RoutesIntent {
  const intent = emptyRoutesIntent();
  const seenRoutes = new Map<string, RoutesFileRoute>();
  let current: RoutesFileRoute | undefined;

  for (const raw of text.split("\n")) {
    const source = parseSourceLine(raw.trim());
    if (source) {
      intent.source ??= source;
      continue;
    }
    const header = /^#\s+Routes\s+—\s+(.+?)\s*$/.exec(raw);
    if (header) {
      intent.target ??= header[1];
      continue;
    }
    const bullet = /^(\s*)-\s+(.+?)\s*$/.exec(raw);
    if (!bullet) continue;
    const [, indent, content] = bullet;

    if (indent.length === 0) {
      current = undefined;
      if (content.startsWith("skip:")) {
        const glob = content.slice(5).trim();
        if (glob) intent.skipRoutes.push(glob);
        continue;
      }
      const { head, rest } = splitDash(content);
      const written = head.split(/\s+/)[0];
      if (!isRoutePath(written)) {
        intent.warnings.push(`ignored route line (not a path): "${content}"`);
        continue;
      }
      const path = written.startsWith("/") ? safely(canonical, written) : written;
      const seen = seenRoutes.get(path);
      if (seen) {
        // One page: what is listed under the second line belongs to the first.
        intent.warnings.push(`duplicate route "${written}" — merged into the first`);
        current = seen;
        continue;
      }
      current = { path, label: rest, states: [] };
      seenRoutes.set(path, current);
      intent.routes.push(current);
      continue;
    }

    if (!current) continue; // nested bullet with no route above it
    let body = content;
    let wanted = false;
    let skip = false;
    if (body.startsWith("skip:")) {
      skip = true;
      body = body.slice(5).trim();
    } else {
      const box = /^\[( |x|X)?\]\s+(.*)$/.exec(body);
      if (box) {
        wanted = box[1] !== "x" && box[1] !== "X";
        body = box[2];
      }
    }
    const { head, rest } = splitDash(body);
    const id = head.split(/\s+/)[0];
    if (!SLUG.test(id)) {
      intent.warnings.push(`ignored state line under "${current.path}": "${content}"`);
      continue;
    }
    const listed = current.states.find((s) => s.id === id);
    if (listed) {
      // First entry wins, except that a `skip:` added under a state's own line (as
      // the legend says to) is the newer word on it.
      if (skip) {
        listed.skip = true;
        listed.wanted = undefined;
      }
      continue;
    }
    current.states.push({
      id,
      description: rest,
      wanted: wanted || undefined,
      skip: skip || undefined,
    });
  }
  return intent;
}

function safely(map: (p: string) => string, path: string): string {
  try {
    return map(path) || path;
  } catch {
    return path;
  }
}

/** `skip:`-ed state ids per route path. */
function stateSkips(intent: RoutesIntent): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const r of intent.routes) {
    const ids = r.states.filter((s) => s.skip).map((s) => s.id);
    if (ids.length) map.set(r.path, new Set(ids));
  }
  return map;
}

/**
 * States the file asks for that the model doesn't realize: `[ ]` lines, plus plain
 * lines whose id matches nothing in the cache (a rename or a vanished state).
 */
export function computeWanted(model: InputManifest, intent: RoutesIntent): WantedState[] {
  const byUrl = new Map(model.routes.map((r) => [r.url, r]));
  const wanted: WantedState[] = [];
  for (const r of intent.routes) {
    if (routeMatches(r.path, intent.skipRoutes)) continue;
    const existing = new Set(byUrl.get(r.path)?.states.map((s) => s.id) ?? []);
    for (const s of r.states) {
      if (s.skip || existing.has(s.id)) continue;
      wanted.push({ route: r.path, state: s.id, description: s.description });
    }
  }
  return wanted;
}

/**
 * Pages the file lists that the model has no route for — added by hand since the
 * last discovery. A replay discovers just these rather than dropping them.
 */
export function unmappedRoutes(model: InputManifest, intent: RoutesIntent): string[] {
  const known = new Set(model.routes.map((r) => r.url));
  return intent.routes
    .map((r) => r.path)
    .filter((p) => !known.has(p) && !routeMatches(p, intent.skipRoutes));
}

/**
 * Fold the file's intent into the config for a discovery run: every listed route
 * seeds the crawl (user-added pages get discovered), `skip:` globs exclude.
 */
export function applyRoutesIntent(config: Config, intent: RoutesIntent): Config {
  if (!intent.routes.length && !intent.skipRoutes.length) return config;
  const seeds = new Set([...config.seeds, ...intent.routes.map((r) => r.path)]);
  return {
    ...config,
    seeds: [...seeds],
    scope: { ...config.scope, exclude: [...config.scope.exclude, ...intent.skipRoutes] },
  };
}

/**
 * Drop `skip:`-ed states and skipped routes from a capture input. The cache keeps
 * them (the file is the visible tombstone); capture just doesn't shoot them.
 */
export function applyStateSkips(model: InputManifest, intent: RoutesIntent): InputManifest {
  if (!intent.routes.length && !intent.skipRoutes.length) return model;
  const skips = stateSkips(intent);
  const routes = model.routes
    .filter((r) => !routeMatches(r.url, intent.skipRoutes))
    .map((r) => {
      const skipped = skips.get(r.url);
      if (!skipped) return r;
      return { ...r, states: r.states.filter((s) => !skipped.has(s.id)) };
    });
  return { ...model, routes };
}

/** Human one-liner for a realized state, derived from its trigger/recipe. */
function describeState(s: StateNode): string | undefined {
  const step = s.recipe.find((r) => r.action === "click" || r.action === "hover") as
    | { action: "click" | "hover"; target: Target }
    | undefined;
  const target = s.trigger ?? step?.target;
  const name = target?.name ?? target?.text ?? target?.label ?? target?.testId ?? target?.selector;
  if (name) return `${step?.action ?? "click"} "${name}"`;
  if (s.label && s.label.toLowerCase() !== s.id.toLowerCase()) return s.label;
  return undefined;
}

/** Sort: home first, then by path depth, then alphabetically. */
function routeOrder(a: string, b: string): number {
  if (a === "/") return b === "/" ? 0 : -1;
  if (b === "/") return 1;
  const depth = (p: string): number => p.split("/").filter(Boolean).length;
  return depth(a) - depth(b) || a.localeCompare(b);
}

const LEGEND = `<!--
Generated by visualice — edit freely; regenerated after every crawl.
  - /path            page to crawl; nested bullets are its captured UI states
  - [ ] state-id     wanted: no recipe yet — realized by the next discovery or by Explore mode
  - skip: x          don't capture this page/state (deleting a line just gets re-added)
-->`;

/**
 * Render the routes file from the cached model + prior intent. Deterministic and
 * idempotent: an unchanged model re-renders byte-identically, so diffs mean change.
 *
 * `source` is the commit a capture just shot; without one (a discovery, a dry run,
 * `visualice routes`) the line the file already had is kept, since the catalogue is
 * still the one shot then.
 */
export function renderRoutesFile(
  model: InputManifest,
  intent: RoutesIntent,
  target: string,
  source: SourceInfo | undefined = intent.source,
): string {
  const skips = stateSkips(intent);
  const intentByPath = new Map(intent.routes.map((r) => [r.path, r]));
  const modelByUrl = new Map(model.routes.map((r) => [r.url, r]));

  const paths = new Set<string>();
  for (const r of model.routes) if (!routeMatches(r.url, intent.skipRoutes)) paths.add(r.url);
  for (const r of intent.routes) if (!routeMatches(r.path, intent.skipRoutes)) paths.add(r.path);

  const lines: string[] = [`# Routes — ${target}`, ""];
  if (source) lines.push(renderSourceLine(source), "");
  lines.push(LEGEND, "");

  for (const p of [...paths].sort(routeOrder)) {
    const route: RouteNode | undefined = modelByUrl.get(p);
    const fromFile = intentByPath.get(p);
    const label = route?.title ?? fromFile?.label;
    lines.push(`- ${p}${label ? ` — ${label}` : ""}`);

    const skipped = skips.get(p) ?? new Set<string>();
    const realized = new Set<string>();
    for (const s of route?.states ?? []) {
      realized.add(s.id);
      if (s.id === "default" || skipped.has(s.id)) continue;
      const markers = [
        s.devices?.length ? `(${s.devices.join(", ")})` : "",
        isAuthored(s) ? "(authored)" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const desc = describeState(s);
      lines.push(`  - ${s.id}${markers ? ` ${markers}` : ""}${desc ? ` — ${desc}` : ""}`);
    }
    // Unrealized requests stay visible as wanted, whatever form they were written in.
    for (const s of fromFile?.states ?? []) {
      if (s.skip || realized.has(s.id)) continue;
      lines.push(`  - [ ] ${s.id}${s.description ? ` — ${s.description}` : ""}`);
    }
    for (const id of [...skipped].sort()) lines.push(`  - skip: ${id}`);
  }

  for (const glob of intent.skipRoutes) lines.push(`- skip: ${glob}`);
  lines.push("");
  return lines.join("\n");
}

/** Absolute path of the routes file, or undefined when the mechanism is disabled. */
export function routesFilePath(config: Config): string | undefined {
  return config.routesFile === false ? undefined : path.resolve(config.routesFile);
}

/** Parse the project's routes file; missing file (or disabled) = empty intent. */
export async function loadRoutesIntent(config: Config): Promise<RoutesIntent> {
  const file = routesFilePath(config);
  if (!file) return emptyRoutesIntent();
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return emptyRoutesIntent();
  }
  const { hashRoutes } = config.scope;
  return parseRoutesFile(text, (p) => canonicalPath(new URL(p, "http://_local_"), hashRoutes));
}

/** Regenerate the routes file from the cached model + prior intent. */
export async function writeRoutesFile(
  config: Config,
  model: InputManifest,
  intent: RoutesIntent,
  target: string,
  log: (msg: string) => void = () => {},
  source?: SourceInfo,
): Promise<void> {
  const file = routesFilePath(config);
  if (!file) return;
  // A file people commit: never the `user:pass@` a target URL may carry.
  await fs.writeFile(
    file,
    renderRoutesFile(model, intent, redactUrl(target), source ?? intent.source),
  );
  log(`routes file → ${file}`);
}
