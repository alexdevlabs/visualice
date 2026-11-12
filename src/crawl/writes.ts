import type { Request } from "playwright";
import { globToRegExp } from "../shared/glob";

// Requests that change data on the site's server. Discovery clicks things to see what
// they open, and a button that starts a job, sends a message or saves a record does
// that on the server whatever the label says: the change outlives the probe and shows
// up in every shot taken after it. A probe watches for these to leave such triggers
// out, and with `blockWrites` stops them before they reach the server.

/** Methods that only read. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Request types that aren't the page asking the server for something. */
const NOT_WRITES = new Set(["websocket", "eventsource", "ping"]);

/**
 * The part of a host a site's own requests share: `api.example.com` and
 * `www.example.com` are one site. Local and IP hosts are only themselves.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase();
  if (h === "localhost" || /^[\d.]+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  return labels.slice(-2).join(".");
}

/**
 * Does a GraphQL body only read? A query is sent as a POST like a mutation is, so the
 * method alone can't tell. Only a body that is GraphQL, with no mutation or
 * subscription in it, counts.
 */
export function isGraphqlRead(body: string | null): boolean {
  if (!body) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  return (
    ops.length > 0 &&
    ops.every((op) => {
      const query = (op as { query?: unknown } | null)?.query;
      return (
        typeof query === "string" && !/(^|[}\s])(mutation|subscription)\s*[A-Za-z_({]/.test(query)
      );
    })
  );
}

/** What a probe needs to know to tell a write from a read. */
export interface WriteRules {
  /** The site being crawled, from `siteOf`. */
  site: string;
  /** `allowWrites`, compiled. */
  allowed: RegExp[];
}

export function writeRules(target: string, allowWrites: string[]): WriteRules {
  return { site: siteOf(new URL(target).hostname), allowed: allowWrites.map(globToRegExp) };
}

/** `POST /api/jobs` when a request would write to the site, else undefined. */
export function writeOf(
  request: Pick<Request, "method" | "url" | "resourceType" | "postData">,
  rules: WriteRules,
): string | undefined {
  const method = request.method().toUpperCase();
  if (READS.has(method) || NOT_WRITES.has(request.resourceType())) return undefined;
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (siteOf(url.hostname) !== rules.site) return undefined;
  if (rules.allowed.some((re) => re.test(url.pathname))) return undefined;
  if (method === "POST" && isGraphqlRead(request.postData())) return undefined;
  return `${method} ${url.pathname}`;
}
