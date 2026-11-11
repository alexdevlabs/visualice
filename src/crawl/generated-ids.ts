import type { Page } from "playwright";

/**
 * Ids a page generates at render time, which a recipe can't rely on.
 *
 * React's `useId()` numbers each call in render order (`:r1:` in React 18, `«r1»`
 * in 19.0, `_r_1_` from 19.1), component libraries build their ids from it or from
 * a counter of their own (`base-ui-_r_2_`, `mat-dialog-0`, `ember812`), and some
 * draw them at random. The value depends on everything that rendered before:
 * another device's layout, a longer table, an earlier click or a fresh load all
 * shift it. A recipe that waits for `[id="_r_1i5_"]` then waits for an element
 * that no longer exists, and every capture of that state times out; a signature
 * built from one no longer matches the state it named.
 *
 * Three sources say which ids those are, so a framework nobody listed is still
 * caught:
 * - the patterns below, for the libraries known to do it;
 * - `discovery.unstableIds` in the config (and the cached model's
 *   `hints.unstableIds`), for what the user or the agent found on this project;
 * - what discovery sees for itself during the run (`learnUnstableId`): an id that
 *   changes between two loads of a page, or between two openings of a dialog.
 *
 * Everything is kept as regex source so it can also run inside the page.
 */
const BUILTIN = [
  // React useId, alone or inside a library prefix/suffix.
  String.raw`(?:^|[-:_])(?::[rR][0-9a-zA-Z]*:|«[rR][0-9a-zA-Z]*»|_[rR]_[0-9a-zA-Z]*_)(?:$|[-:_])`,
  // Libraries that number their own ids.
  String.raw`^(?:headlessui|radix|base-ui|mui|reach|chakra|mantine|react-aria)[-:_]?`,
  String.raw`^react-select-\d+-`,
];

/** One learned pattern, and what showed it. */
export interface LearnedId {
  pattern: string;
  /** An id that matched it. */
  example: string;
  /** `loads`: changed between two loads of a page; `reopen`: between two openings. */
  seen: "loads" | "reopen";
}

let configured: string[] = [];
const learned = new Map<string, LearnedId>();
/** Shapes whose id came back the same when checked: not worth checking again. */
const confirmedStable = new Set<string>();
let compiled: { source: string; re: RegExp } | undefined;

/**
 * Start a run with the project's own patterns (config plus hints). Patterns learned
 * by an earlier run in this process are dropped: each run learns its own.
 */
export function useUnstableIds(patterns: readonly string[] = []): void {
  configured = patterns.filter(validPattern);
  learned.clear();
  confirmedStable.clear();
  compiled = undefined;
}

export function validPattern(p: string): boolean {
  try {
    new RegExp(p);
    return p.length > 0;
  } catch {
    return false;
  }
}

/** Every pattern in force right now, as one regex source for use inside a page. */
export function generatedIdSource(): string {
  return current().source;
}

function current(): { source: string; re: RegExp } {
  if (!compiled) {
    const source = [...BUILTIN, ...configured, ...[...learned.values()].map((l) => l.pattern)]
      .map((p) => `(?:${p})`)
      .join("|");
    compiled = { source, re: new RegExp(source) };
  }
  return compiled;
}

export function isGeneratedId(id: string): boolean {
  return current().re.test(id);
}

/** The patterns this run learned that the config didn't already have. */
export function learnedUnstableIds(): LearnedId[] {
  return [...learned.values()];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * A pattern for ids built the same way as `id`: separators and words kept, the
 * parts that vary replaced. `mat-dialog-3` → `^mat\-dialog\-\d+$`, `ember812` →
 * `^ember\d+$`, `widget-k3j9x` → `^widget\-[0-9a-zA-Z]+$`. Undefined for an id with
 * no digit in it (`settings`), which gives nothing to generalise from, and for one
 * that would leave no literal part (`a1b2`), which would match nearly any id.
 */
export function idShape(id: string): string | undefined {
  if (!/\d/.test(id)) return undefined;
  const parts = id.split(/([-_:.«»]+)/);
  let literal = false;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return escapeRe(part); // a separator run
    if (!/\d/.test(part)) {
      if (part) literal = true;
      return escapeRe(part);
    }
    const counter = /^([a-zA-Z]*)(\d+)$/.exec(part);
    if (counter) {
      if (counter[1]) literal = true;
      return `${escapeRe(counter[1])}\\d+`;
    }
    return "[0-9a-zA-Z]+";
  });
  return literal ? `^${out.join("")}$` : undefined;
}

/**
 * Record that `id` was seen to change, so it and every id shaped like it are
 * treated as generated from here on. Returns the pattern, or undefined when the
 * id gives nothing to generalise from.
 */
export function learnUnstableId(id: string, seen: LearnedId["seen"]): string | undefined {
  const pattern = idShape(id);
  if (!pattern || learned.has(pattern) || configured.includes(pattern)) return pattern;
  learned.set(pattern, { pattern, example: id, seen });
  compiled = undefined;
  return pattern;
}

/** Is `id` worth checking by opening its region again? Once per shape is enough. */
export function needsStabilityCheck(id: string): boolean {
  const shape = idShape(id);
  return !!shape && !isGeneratedId(id) && !confirmedStable.has(shape);
}

export function confirmStableId(id: string): void {
  const shape = idShape(id);
  if (shape) confirmedStable.add(shape);
}

/**
 * Learn the ids that differ on a second load of the same page: two ids of one
 * shape where the first load had one and the second the other (`widget-k3j9x`,
 * then `widget-p0q2a`). Returns the patterns learned.
 */
export async function learnFromTwoLoads(load: () => Promise<Page>): Promise<string[]> {
  const idsOf = async () => {
    const page = await load();
    try {
      return new Set(
        await page.evaluate(() => Array.from(document.querySelectorAll("[id]"), (e) => e.id)),
      );
    } finally {
      await page.close().catch(() => {});
    }
  };
  const a = await idsOf();
  const b = await idsOf();
  const byShape = (ids: Set<string>, other: Set<string>) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      if (other.has(id) || isGeneratedId(id)) continue;
      const s = idShape(id);
      if (s && !out.has(s)) out.set(s, id);
    }
    return out;
  };
  const onlyA = byShape(a, b);
  const onlyB = byShape(b, a);
  const found: string[] = [];
  for (const [shape, id] of onlyA) {
    if (!onlyB.has(shape)) continue; // there and then gone: content, not a renamed id
    const p = learnUnstableId(id, "loads");
    if (p) found.push(p);
  }
  return found;
}

/** A selector that is nothing but one element's id: `#x` or `[id="x"]`. */
export function idOfSelector(selector: string): string | undefined {
  const s = selector.trim();
  const quoted = /^\[id="((?:[^"\\]|\\.)*)"\]$/.exec(s);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");
  const hash = /^#((?:[\w\u00a0-\uffff-]|\\.)+)$/.exec(s);
  return hash ? hash[1].replace(/\\(.)/g, "$1") : undefined;
}

/**
 * Does a selector depend on a generated id: `#base-ui-_r_2_`, `[id="_r_6_"]`?
 * Recipes recorded before an id was known to be generated still carry them.
 */
export function namesGeneratedId(selector: string): boolean {
  const ids = [
    ...Array.from(selector.matchAll(/\[id="((?:[^"\\]|\\.)*)"\]/g), (m) =>
      m[1].replace(/\\(.)/g, "$1"),
    ),
    ...Array.from(selector.matchAll(/#((?:[\w\u00a0-\uffff-]|\\.)+)/g), (m) =>
      m[1].replace(/\\(.)/g, "$1"),
    ),
  ];
  return ids.some(isGeneratedId);
}
