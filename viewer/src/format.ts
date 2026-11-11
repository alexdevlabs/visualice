/**
 * Display formatting shared by the header and the inspector.
 *
 * Run ids are ISO timestamps with `:`/`.` swapped for `-` (see `makeRunId`), which
 * is precise and unreadable. The run pickers show them as a date people recognise
 * and keep the raw id for the tooltip.
 */

const RUN_ID_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The live page a shot was taken from. Routes are origin-absolute ("/about"), so they
 * resolve against the crawled target, or under `liveBase` when the pages live elsewhere.
 *
 * Undefined when that isn't a web address: the route and the site come from a data
 * file, and a link built from one must not be `javascript:` or throw while rendering
 * (a `baseUrl` with no scheme).
 */
export function liveUrl(
  routeUrl: string,
  site: { baseUrl: string; liveBase?: string },
): string | undefined {
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(routeUrl);
    const url = absolute
      ? new URL(routeUrl)
      : site.liveBase
        ? new URL(site.liveBase.replace(/\/+$/, "") + routeUrl)
        : new URL(routeUrl, site.baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** "Sep 21, 01:49" for a generated run id (UTC, as the id records it); anything else as-is. */
export function runLabel(id: string): string {
  const m = RUN_ID_RE.exec(id);
  if (!m) return id;
  const [, , mo, d, h, mi] = m;
  const month = MONTHS[+mo - 1];
  return month ? `${month} ${+d}, ${h}:${mi}` : id;
}
