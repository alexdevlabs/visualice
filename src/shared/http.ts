/** The User-Agent visualice sends on its own HTTP fetches (robots.txt, sitemaps). */
export const CRAWLER_USER_AGENT = "visualice/0.1 (site screenshot crawler)";

/**
 * `fetch` that identifies the crawler and never hangs: visualice self-applies the
 * `visualice` robots.txt group, so it should actually say who it is on the wire.
 */
export function politeFetch(url: string, timeoutMs = 10000): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": CRAWLER_USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
}
