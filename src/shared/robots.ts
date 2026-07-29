/**
 * robots.txt parsing + path matching (RFC 9309 / the de-facto Google rules).
 *
 * Deliberately dependency-free and pure so it is cheap to unit test:
 * `parseRobots` turns the file into rules, `isAllowed` answers one path.
 * Network access lives in `fetchRobots`, the only impure function here.
 */

import { politeFetch } from "./http";

/** The product token visualice identifies itself with in robots.txt groups. */
export const ROBOTS_UA = "visualice";

export interface RobotsRule {
  allow: boolean;
  /** The raw path pattern, kept for longest-match precedence. */
  pattern: string;
  regex: RegExp;
}

export interface RobotsRules {
  rules: RobotsRule[];
  /** `Crawl-delay` for the matched group, in ms. */
  crawlDelayMs?: number;
  /** Absolute sitemap URLs declared in the file (group-independent). */
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = { rules: [], sitemaps: [] };

/**
 * A robots path pattern into a RegExp: `*` matches any run of characters and a
 * trailing `$` anchors the end. Everything else is literal.
 */
export function robotsPatternToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "$" && i === pattern.length - 1) re += "$";
    else if ("\\^$.|?+()[]{}".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}`);
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs?: number;
}

/**
 * Score how well a group's user-agent line applies to us. `*` is the weakest
 * match (0), a named token matches on substring and scores by its length so the
 * most specific group wins; -1 means "does not apply".
 */
function agentScore(agent: string, ua: string): number {
  if (agent === "*") return 0;
  return ua.toLowerCase().includes(agent.toLowerCase()) ? agent.length : -1;
}

/** Parse a robots.txt body, returning the rules that apply to `userAgent`. */
export function parseRobots(txt: string, userAgent: string = ROBOTS_UA): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let acceptingAgents = false; // consecutive User-agent lines share one group

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !acceptingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      if (value) current.agents.push(value);
      continue;
    }
    if (!current) continue; // rule outside any group — ignore
    acceptingAgents = false;

    if (field === "allow" || field === "disallow") {
      // An empty `Disallow:` is the documented way to say "nothing is blocked",
      // and an empty `Allow:` is meaningless — both are skipped rather than
      // treated as a zero-length pattern that matches every path.
      if (!value) continue;
      current.rules.push({
        allow: field === "allow",
        pattern: value,
        regex: robotsPatternToRegExp(value),
      });
    } else if (field === "crawl-delay") {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) current.crawlDelayMs = Math.round(secs * 1000);
    }
  }

  let best = -1;
  const matched: Group[] = [];
  for (const g of groups) {
    const score = Math.max(-1, ...g.agents.map((a) => agentScore(a, userAgent)));
    if (score < 0 || score < best) continue;
    if (score > best) {
      best = score;
      matched.length = 0;
    }
    matched.push(g); // several groups may declare the same agent — merge them
  }

  return {
    rules: matched.flatMap((g) => g.rules),
    crawlDelayMs: matched.find((g) => g.crawlDelayMs !== undefined)?.crawlDelayMs,
    sitemaps,
  };
}

/**
 * Is `path` (path + query, e.g. `/search?q=x`) crawlable?
 * The longest matching pattern wins; `Allow` beats `Disallow` on a tie.
 */
export function isAllowed(path: string, robots: RobotsRules): boolean {
  let bestLen = -1;
  let allowed = true;
  for (const rule of robots.rules) {
    if (!rule.regex.test(path)) continue;
    const len = rule.pattern.length;
    if (len > bestLen || (len === bestLen && rule.allow)) {
      bestLen = len;
      allowed = rule.allow;
    }
  }
  return allowed;
}

/**
 * Fetch and parse `/robots.txt` for an origin.
 *
 * Missing, unreachable or malformed robots.txt is treated as "everything is
 * allowed" — the strict reading (5xx ⇒ crawl nothing) would silently produce an
 * empty run against a site the user owns, so we log and continue instead.
 */
export async function fetchRobots(
  baseUrl: string,
  log: (msg: string) => void = () => {},
): Promise<RobotsRules> {
  const url = new URL("/robots.txt", baseUrl).href;
  try {
    const res = await politeFetch(url);
    if (!res.ok) {
      // 404 is the normal "this site has no robots.txt"; anything else (5xx,
      // 403) is worth surfacing, since we carry on crawling either way.
      if (res.status !== 404)
        log(`  ! robots.txt returned ${res.status} — assuming crawl is allowed`);
      return ALLOW_ALL;
    }
    return parseRobots(await res.text());
  } catch (e) {
    log(`  ! robots.txt unreadable (${(e as Error).message}) — assuming crawl is allowed`);
    return ALLOW_ALL;
  }
}
