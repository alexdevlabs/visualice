import { promises as fs } from "node:fs";
import path from "node:path";
import type { Manifest, InputManifest, RouteNode, StateNode } from "../shared/types";
import { parseInputManifest } from "../shared/manifest-schema";

export async function loadManifest(file: string): Promise<Manifest> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Manifest;
}

/**
 * Load + validate a capture input / cached site model. Validation catches malformed
 * hand-authored (Explore-mode) entries up front, with every issue listed, instead of
 * failing opaquely mid-capture. Defaults (empty `shots`, `recipe`, …) are filled in.
 */
export async function loadInputManifest(file: string): Promise<InputManifest> {
  const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  return parseInputManifest(raw, file) as InputManifest;
}

export async function saveJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

/** Where the cached site model lives under an output root. */
export function modelCachePath(outRoot: string): string {
  return path.join(outRoot, "crawl-map.cache.json");
}

/** Total states across a model's routes. */
export function countStates(routes: { states: unknown[] }[]): number {
  return routes.reduce((n, r) => n + r.states.length, 0);
}

/** A state is "authored" unless it was explicitly tagged by the auto-discoverer. */
export function isAuthored(s: StateNode): boolean {
  return (s.source ?? "authored") !== "auto";
}

/**
 * Merge a fresh route's states into a cached route's states.
 * - Authored states (hand-written / Explore-mode) are always preserved as-is.
 * - Auto states are replaced wholesale by the fresh discovery (so they stay current).
 * - A fresh auto state whose id collides with an authored one is dropped (authored wins).
 * Route-level metadata (title/status/links/finalUrl) is taken from the fresh route.
 */
function mergeRouteStates(cached: RouteNode, fresh: RouteNode): StateNode[] {
  const authored = cached.states.filter(isAuthored);
  const authoredIds = new Set(authored.map((s) => s.id));
  const freshAuto = fresh.states.filter((s) => !isAuthored(s) && !authoredIds.has(s.id));
  return [...authored, ...freshAuto];
}

/**
 * Merge a fresh (auto-discovered) site model into the cached one without clobbering
 * authored work. Routes are unioned by `url`, keeping cached order then appending new
 * ones; shared routes take fresh metadata but keep authored states. This is what lets a
 * default `crawl` re-discover from scratch yet never lose hand-authored states.
 * `keepStates` keeps a shared route's cached states as they are (pages-only runs).
 */
export function mergeManifests(
  cached: InputManifest,
  fresh: InputManifest,
  opts: { keepStates?: boolean } = {},
): InputManifest {
  const cachedByUrl = new Map(cached.routes.map((r) => [r.url, r]));
  const freshByUrl = new Map(fresh.routes.map((r) => [r.url, r]));

  const order = [...cached.routes.map((r) => r.url), ...fresh.routes.map((r) => r.url)];
  const seen = new Set<string>();
  const routes: RouteNode[] = [];
  for (const url of order) {
    if (seen.has(url)) continue;
    seen.add(url);
    const c = cachedByUrl.get(url);
    const f = freshByUrl.get(url);
    // A pages-only discovery probed no states, so its "none found" says nothing
    // about the states the cache already has: keep them, auto ones included.
    if (c && f) routes.push({ ...f, states: opts.keepStates ? c.states : mergeRouteStates(c, f) });
    else routes.push((c ?? f)!);
  }

  return {
    site: fresh.site ?? cached.site,
    auth: cached.auth ?? fresh.auth,
    hints: mergeHints(cached.hints, fresh.hints),
    routes,
  };
}

/**
 * The fresh hints over the cached ones, except the id patterns: each discovery
 * learns only what it happened to see, so what an earlier run learned is kept.
 */
function mergeHints(
  cached: InputManifest["hints"],
  fresh: InputManifest["hints"],
): InputManifest["hints"] {
  const merged = { ...cached, ...fresh };
  const ids = [...new Set([...(cached?.unstableIds ?? []), ...(fresh?.unstableIds ?? [])])];
  if (ids.length) merged.unstableIds = ids;
  return merged;
}
