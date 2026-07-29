import { pathSlug } from "./slug";

/**
 * URL normalization shared by route discovery and the manifest.
 * Pure and side-effect free so scope/dedup behaviour is unit testable.
 */

// Tracking params that don't identify a distinct page — dropped so they don't
// explode the crawl, while *meaningful* query params still separate routes.
const TRACKING = /^(utm_|mc_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|yclid$|igshid$|_ga$|ref$)/i;

/** Pathname only, trailing slashes trimmed — what scope globs match against. */
export function scopePath(u: URL): string {
  return u.pathname.replace(/\/+$/, "") || "/";
}

/** Path + meaningful, sorted query — the identity used for dedup and output. */
export function canonicalPath(u: URL): string {
  const p = scopePath(u);
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  if (!params.length) return p;
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const search = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${p}?${search}`;
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
export function relativeToOrigin(href: string, origin: string): string {
  try {
    const u = new URL(href);
    return u.origin === origin ? canonicalPath(u) : u.href;
  } catch {
    return href;
  }
}

/** Canonicalize + dedupe a page's outbound hrefs, keeping same-origin ones. */
export function dedupeLinks(links: string[], origin: string): string[] {
  const out = new Set<string>();
  for (const href of links) {
    try {
      const u = new URL(href);
      if (u.origin === origin) out.add(canonicalPath(u));
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
