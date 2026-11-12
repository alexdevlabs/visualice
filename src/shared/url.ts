import { pathSlug } from "./slug";
import { trimEndOf } from "./trim";

/**
 * URL normalization shared by route discovery and the manifest.
 * Pure and side-effect free so scope/dedup behaviour is unit testable.
 */

// Tracking params that don't identify a distinct page — dropped so they don't
// explode the crawl, while *meaningful* query params still separate routes.
const TRACKING = /^(utm_|mc_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|yclid$|igshid$|_ga$|ref$)/i;

/**
 * How much of a URL fragment counts as route identity.
 *
 * - `never` — a fragment is always an in-page anchor. Every `#…` on a path is the
 *   same route, which is right for an ordinary server-rendered site.
 * - `auto` — only router-shaped fragments (`#/about`, `#!/about`) identify a
 *   route. A plain `#pricing` stays an anchor. This is the default: the two
 *   conventions are unambiguous, and a site that uses neither is unaffected.
 * - `always` — any fragment identifies a route. For routers that drop the slash
 *   (`#about`); it will also turn a documentation page's anchor list into dozens
 *   of routes, so it is opt-in.
 */
export type HashRoutes = "auto" | "never" | "always";

/** Does this fragment look like a router path rather than a jump to an anchor? */
export function isHashRoute(hash: string): boolean {
  return /^#!?\/./.test(hash);
}

/**
 * The part of `u.hash` that belongs to the route identity, or `""`.
 *
 * `#`, `#/` and `#!/` all mean "the router's home", which is the same route as no
 * fragment at all — folding them to `""` keeps `/` and `/#/` from becoming two
 * routes that screenshot identically.
 */
export function hashPart(u: URL, mode: HashRoutes = "never"): string {
  if (mode === "never") return "";
  const raw = trimEndOf(u.hash, "/");
  if (raw === "" || raw === "#" || raw === "#!") return "";
  if (mode === "auto" && !isHashRoute(u.hash)) return "";
  return raw;
}

/** Pathname (+ route fragment) with trailing slashes trimmed — what scope globs match. */
export function scopePath(u: URL, hashRoutes: HashRoutes = "never"): string {
  return (trimEndOf(u.pathname, "/") || "/") + hashPart(u, hashRoutes);
}

/** Path + meaningful, sorted query (+ route fragment) — the identity used for dedup and output. */
export function canonicalPath(u: URL, hashRoutes: HashRoutes = "never"): string {
  const p = trimEndOf(u.pathname, "/") || "/";
  const hash = hashPart(u, hashRoutes);
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  if (!params.length) return p + hash;
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const search = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  // Written in URL order — path, query, fragment — so the canonical form is a URL
  // that can be resolved against a base host and navigated to as-is.
  return `${p}?${search}${hash}`;
}

/**
 * The address to load a route at: its path, with the trailing slash put back when
 * the site serves the page there (`/docs/?page=2`). The canonical `url` drops the
 * slash so `/docs` and `/docs/` are one route; a server may still answer only one.
 */
export function routeHref(route: { url: string; trailingSlash?: boolean }): string {
  if (!route.trailingSlash) return route.url;
  const m = /^([^?#]*)(.*)$/.exec(route.url)!;
  return m[1].endsWith("/") ? route.url : `${m[1]}/${m[2]}`;
}

/** Stable, filesystem-safe id for a canonical path. */
export function routeId(canonical: string): string {
  return pathSlug(canonical).replace(/\//g, "-");
}

/**
 * Reduce a URL to its canonical path when it belongs to `origin`, so cached site
 * models stay portable (the same map replays against staging, prod or a random
 * test port). Off-origin URLs are returned untouched.
 */
export function relativeToOrigin(
  href: string,
  origin: string,
  hashRoutes: HashRoutes = "never",
): string {
  try {
    const u = new URL(href);
    return u.origin === origin ? canonicalPath(u, hashRoutes) : u.href;
  } catch {
    return href;
  }
}

/** Canonicalize + dedupe a page's outbound hrefs, keeping same-origin ones. */
export function dedupeLinks(
  links: string[],
  origin: string,
  hashRoutes: HashRoutes = "never",
): string[] {
  const out = new Set<string>();
  for (const href of links) {
    try {
      const u = new URL(href);
      if (u.origin === origin) out.add(canonicalPath(u, hashRoutes));
    } catch {
      /* skip */
    }
  }
  return [...out];
}

/** Suffix an id with -2, -3, … until it no longer collides with `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
