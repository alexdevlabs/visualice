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

/**
 * The folder an app's pages are relative to, from the page it opens on: for
 * `file:///Users/me/app/dist/index.html` it is `file:///Users/me/app/dist`, and that
 * page's route is `/index.html`. Without it every route would be named by its full
 * path on disk. Set once per process, by the app host; an app served over http is
 * a site like any other and has none.
 */
let appRoot: { href: string; path: string } | undefined;

export function setAppRoot(startUrl: string | undefined): void {
  appRoot = undefined;
  if (!startUrl) return;
  const u = new URL(startUrl);
  if (u.protocol === "http:" || u.protocol === "https:") return;
  const dir = u.pathname.replace(/\/[^/]*$/, "");
  appRoot = { href: `${u.protocol}//${u.host}${dir}`, path: dir };
}

/** The app root's URL, when an app with one is being crawled. */
export function appRootHref(): string | undefined {
  return appRoot?.href;
}

function underAppRoot(u: URL): boolean {
  return (
    !!appRoot &&
    u.origin === "null" &&
    `${u.protocol}//${u.host}${u.pathname}`.startsWith(`${appRoot.href}/`)
  );
}

/** A URL's path, from the app root for an app's own pages. */
function pathOf(u: URL): string {
  return underAppRoot(u) ? u.pathname.slice(appRoot!.path.length) : u.pathname;
}

/** Pathname (+ route fragment) with trailing slashes trimmed — what scope globs match. */
export function scopePath(u: URL, hashRoutes: HashRoutes = "never"): string {
  return (trimEndOf(pathOf(u), "/") || "/") + hashPart(u, hashRoutes);
}

/** Path + meaningful, sorted query (+ route fragment) — the identity used for dedup and output. */
export function canonicalPath(u: URL, hashRoutes: HashRoutes = "never"): string {
  const p = trimEndOf(pathOf(u), "/") || "/";
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

/**
 * A URL's origin, as a prefix a canonical path can be appended to. For http(s) that
 * is `URL.origin`. An app's pages (`file://`, `vscode-file://vscode-app`) all have
 * the opaque origin `"null"`, which says nothing and can't be built on: the app root
 * stands in for it, or for a page outside the root, its scheme and host.
 */
export function originOf(u: URL | string): string {
  const url = typeof u === "string" ? new URL(u) : u;
  if (url.origin !== "null") return url.origin;
  return underAppRoot(url) ? appRoot!.href : `${url.protocol}//${url.host}`;
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
    return originOf(u) === origin ? canonicalPath(u, hashRoutes) : u.href;
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
      if (originOf(u) === origin) out.add(canonicalPath(u, hashRoutes));
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
