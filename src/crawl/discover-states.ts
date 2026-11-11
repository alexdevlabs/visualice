import type { BrowserContext, Page, Request } from "playwright";
import type { Config } from "../shared/config";
import type {
  QuietTrigger,
  RouteNode,
  StateNode,
  StateKind,
  RecipeStep,
  Target,
} from "../shared/types";
import { describeTarget, locatorFor, testIdAttribute } from "../shared/selectors";
import { stateSlug } from "../shared/slug";
import { uniqueId } from "../shared/url";
import { applyRecipe, gotoRoute } from "./recipe";
import { discoverFormStates } from "./discover-forms";
import {
  confirmStableId,
  generatedIdSource,
  isGeneratedId,
  learnUnstableId,
  needsStabilityCheck,
} from "./generated-ids";
import { createHash } from "node:crypto";
import {
  addedLines,
  addedRegions,
  markDocument,
  readLines,
  readStorage,
  restoreStorage,
  sameRegions,
  storageChanged,
  takeSnapshot,
  type Snapshot,
} from "./snapshot";

export interface RawCandidate {
  target: Target;
  label: string;
  hint?: StateKind;
  controls?: string;
  /** How to trigger this candidate; anchors in navs are hover-only (a click navigates). */
  probe?: "click" | "hover";
}

type Interactions = Config["discovery"]["interactions"];

/**
 * Find clickable elements that plausibly open a modal/menu/accordion/tab.
 * `root` limits the search to one container — used when probing *inside* an
 * already-open state so nested discovery doesn't re-find the whole page chrome.
 */
export async function collectCandidates(
  page: Page,
  interactions: Interactions,
  root?: string,
): Promise<RawCandidate[]> {
  const arg = {
    denyLabels: interactions.denyLabels,
    denySelectors: interactions.denySelectors,
    extra: interactions.extraTriggers,
    hover: interactions.hover,
    maxCandidates: interactions.maxCandidates,
    root: root ?? null,
    testIdAttribute: testIdAttribute(),
    generatedId: generatedIdSource(),
    mark: CANDIDATE_MARK,
  };
  const raw = await page.evaluate((cfg) => {
    const generated = new RegExp(cfg.generatedId);
    const base = [
      "[aria-haspopup]",
      "[aria-expanded]",
      "[aria-controls]",
      '[data-state="closed"]',
      "button",
      '[role="button"]',
      "summary",
      '[role="tab"]',
    ];
    const sel = [...base, ...cfg.extra].join(",");
    const deny = cfg.denyLabels.map((s) => s.toLowerCase());

    // A missing root means the container we were told to look inside is gone —
    // probing the whole document instead would just re-discover outer triggers.
    let scope: ParentNode | null = document;
    if (cfg.root) {
      try {
        scope = document.querySelector(cfg.root);
      } catch {
        scope = null;
      }
    }
    if (!scope) return [];

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    };
    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let n: Element | null = el;
      while (n && n.nodeType === 1 && n !== document.body && parts.length < 6) {
        let p = n.tagName.toLowerCase();
        const par: Element | null = n.parentElement;
        if (par) {
          const same = Array.from(par.children).filter((c) => c.tagName === n!.tagName);
          if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
        }
        parts.unshift(p);
        n = n.parentElement;
      }
      return parts.join(" > ");
    };
    const targetFor = (el: Element): Record<string, unknown> => {
      const tid = el.getAttribute(cfg.testIdAttribute);
      if (tid) return { testId: tid };
      // A generated id (React's useId, a component library's counter) names a
      // different element, or none, on the next load.
      if (el.id && !generated.test(el.id)) return { selector: `#${CSS.escape(el.id)}` };
      const role = el.getAttribute("role");
      const al = el.getAttribute("aria-label");
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (al && role) return { role, name: al };
      if (role && text && text.length <= 40) return { role, name: text };
      if (el.tagName === "BUTTON" && text && text.length <= 40)
        return { role: "button", name: text };
      return { selector: cssPath(el) };
    };
    const hintFor = (el: Element): string | undefined => {
      const hp = el.getAttribute("aria-haspopup");
      const role = el.getAttribute("role");
      const label = el.getAttribute("aria-label") || "";
      if (role === "tab") return "tab";
      if (el.tagName === "SUMMARY") return "accordion";
      if (hp === "menu" || (hp === "true" && /menu|nav/i.test(label))) return "menu";
      if (hp === "dialog") return "modal";
      return undefined;
    };

    const els = Array.from(scope.querySelectorAll(sel));
    const seen = new Set<Element>();
    const out: {
      target: Record<string, unknown>;
      label: string;
      hint?: string;
      controls?: string;
      probe?: string;
      mark: string;
    }[] = [];
    const MARK = cfg.mark;
    // ARIA allows `aria-controls` to list several ids; everything downstream turns
    // this into a selector for one element, so keep the first that exists.
    const controlledId = (el: Element): string | undefined => {
      const ids = (el.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
      return ids.find((id) => document.getElementById(id)) ?? ids[0];
    };
    const labelFor = (el: Element): string =>
      (
        el.getAttribute("aria-label") ||
        (el.textContent || "").replace(/\s+/g, " ").trim() ||
        el.getAttribute("title") ||
        ""
      ).slice(0, 60);
    for (const el of els) {
      if (el.tagName === "A") continue; // anchors are routes (the hover pass may still probe them)
      if (seen.has(el)) continue;
      seen.add(el);
      if (!visible(el)) continue;
      if (el.getAttribute("target") === "_blank") continue;
      if (el.hasAttribute("download")) continue;
      const ty = (el.getAttribute("type") || "").toLowerCase();
      if (ty === "submit" || ty === "reset" || ty === "image") continue;
      // A button in a form with no `type` (or one the browser doesn't know) is a
      // submit button: clicking it would send the form.
      const control = el as HTMLButtonElement;
      if (
        (el.tagName === "BUTTON" || el.tagName === "INPUT") &&
        control.form &&
        (control.type === "submit" || control.type === "reset")
      )
        continue;
      // Likewise anything inside a submit button, or a label that clicks one.
      const inside = el.closest("button, input") as HTMLButtonElement | null;
      if (inside && inside !== el && inside.form && inside.type === "submit") continue;
      if (
        cfg.denySelectors.some((s) => {
          try {
            return el.matches(s);
          } catch {
            return false;
          }
        })
      )
        continue;
      const label = labelFor(el);
      if (deny.some((d) => label.toLowerCase().includes(d))) continue;
      el.setAttribute(MARK, String(out.length));
      out.push({
        target: targetFor(el),
        label,
        hint: hintFor(el),
        controls: controlledId(el),
        mark: String(out.length),
      });
      if (out.length >= cfg.maxCandidates) break;
    }

    // Hover-only candidates: nav/header anchors that look like dropdown parents.
    // Clicking them navigates, so they never enter the click pool — but hovering
    // is how classic dropdown navs open.
    if (cfg.hover) {
      for (const a of Array.from(scope.querySelectorAll("nav a, header a"))) {
        if (out.length >= cfg.maxCandidates) break;
        if (seen.has(a)) continue;
        seen.add(a);
        if (!visible(a)) continue;
        const li = a.closest("li");
        const marked = a.hasAttribute("aria-haspopup") || a.hasAttribute("aria-expanded");
        const hasSubmenu = !!li && !!li.querySelector('ul, [role="menu"]');
        if (!marked && !hasSubmenu) continue;
        const label = labelFor(a);
        if (deny.some((d) => label.toLowerCase().includes(d))) continue;
        a.setAttribute(MARK, String(out.length));
        out.push({
          target: targetFor(a),
          label,
          hint: "menu",
          controls: controlledId(a),
          probe: "hover",
          mark: String(out.length),
        });
      }
    }
    // collapse triggers that point at the same controlled element
    const byCtrl = new Set<string>();
    const final: typeof out = [];
    for (const c of out) {
      if (c.controls) {
        if (byCtrl.has(c.controls)) continue;
        byCtrl.add(c.controls);
      }
      final.push(c);
    }
    return final;
  }, arg);

  const candidates = raw as (RawCandidate & { mark: string })[];
  try {
    for (const cand of candidates) cand.target = await uniqueTarget(page, cand.target, cand.mark);
  } finally {
    await page
      .evaluate((mark) => {
        for (const el of Array.from(document.querySelectorAll(`[${mark}]`))) {
          el.removeAttribute(mark);
        }
      }, CANDIDATE_MARK)
      .catch(() => {});
  }
  return candidates.map(({ mark: _mark, ...cand }) => cand);
}

/** Marks each candidate element while its target is checked, then removed. */
const CANDIDATE_MARK = "data-vc-candidate";

/**
 * A target that names one element. A role and name match any element whose name
 * contains it ("Menu" also finds "Close menu"), and a page may have the same button
 * twice (a "Details" on every card): a click on such a target is refused, in the
 * probe and in every capture after it. So match the name exactly, and where that
 * still finds several, say which one.
 */
async function uniqueTarget(page: Page, target: Target, mark: string): Promise<Target> {
  const count = (t: Target) =>
    locatorFor(page, t)
      .count()
      .catch(() => 1);
  if ((await count(target)) <= 1) return target;
  let narrowed = target;
  if (target.role && target.name) {
    const exact = { ...target, exact: true };
    const n = await count(exact);
    if (n === 1) return exact;
    if (n > 1) narrowed = exact;
  }
  const nth = await locatorFor(page, narrowed)
    .evaluateAll((els, [attr, value]) => els.findIndex((el) => el.getAttribute(attr) === value), [
      CANDIDATE_MARK,
      mark,
    ] as const)
    .catch(() => -1);
  return nth >= 0 ? { ...narrowed, nth } : target;
}

export function classifyChange(
  before: Snapshot,
  after: Snapshot,
  cand: RawCandidate,
  action: "click" | "hover",
): StateKind | null {
  // Something must have *appeared*. A trigger that only closes things (the
  // dismiss button inside a modal we opened to probe deeper) is not a new state.
  if (!addedRegions(before, after).length) return null;

  const opened = after.modals > before.modals;
  const detailsMore = after.details > before.details;
  const slidIn = after.overlays > before.overlays;
  const lbl = (cand.label || "").toLowerCase();
  const menuish = cand.hint === "menu" || /menu|nav/.test(lbl);

  if (action === "hover") {
    if (menuish) return "menu";
    if (opened) return "popover";
    if (detailsMore) return "accordion";
    return "hover";
  }
  if (opened) return menuish ? "menu" : "modal";
  if (slidIn) return menuish ? "menu" : "drawer";
  if (detailsMore) return "accordion";
  if (cand.hint === "tab") return "tab";
  return "accordion";
}

// Escape a value for use inside a double-quoted CSS attribute selector
// (`[id="..."]`), so ids containing quotes or backslashes don't break the selector.
function cssAttrValue(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

function idSelector(id: string): string {
  return `[id="${cssAttrValue(id)}"]`;
}

function buildSteps(
  cand: RawCandidate,
  kind: StateKind,
  action: "click" | "hover",
  openId?: string,
  dialogOpened = true,
): RecipeStep[] {
  const steps: RecipeStep[] = [{ action, target: cand.target }];
  // Prefer waiting for the exact element that opened — a generic [role=dialog] can
  // match an unrelated hidden element (e.g. a closed drawer) and never go visible.
  const id = openId;
  if (id) {
    steps.push({ action: "waitFor", selector: idSelector(id), state: "visible" });
  } else if (dialogOpened && (kind === "modal" || kind === "menu" || kind === "drawer")) {
    steps.push({
      action: "waitFor",
      selector: 'dialog[open]:visible,[role="dialog"]:visible',
      state: "visible",
    });
  } else {
    steps.push({ action: "wait", ms: 200 });
  }
  return steps;
}

function makeStateId(
  kind: StateKind,
  label: string,
  prefix: string,
  existing: StateNode[],
): string {
  const slug = stateSlug(label).slice(0, 32).replace(/-+$/, "");
  const own = slug ? `${kind}-${slug}` : kind;
  return uniqueId(
    prefix ? `${prefix}-${own}` : own,
    existing.map((s) => s.id),
  );
}

/** The route as it loads, before anything is opened. */
export const defaultState = (): StateNode => ({
  id: "default",
  kind: "default",
  label: "Default",
  recipe: [],
  source: "auto",
  shots: {},
});

/**
 * A state's identity apart from the page it was found on: the same recipe
 * bringing the same text on screen. A trigger that opens nothing readable has
 * none — the same click elsewhere can't be shown to open the same thing.
 */
export function siteKeyFor(recipe: RecipeStep[], appeared: string[]): string | undefined {
  if (!appeared.length) return undefined;
  const basis = JSON.stringify(recipe) + "\n" + [...appeared].sort().join("\n");
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

/** Counters for the one thing probing spends most of its time on. */
export interface ProbeStats {
  /** Full page loads issued to get back to a parent state. */
  navigations: number;
  /** Times the page was already there, or a keypress was enough to put it back. */
  reused: number;
}

interface ProbeContext {
  page: Page;
  routeUrl: string;
  waitUntil: Config["stabilize"]["waitStrategy"];
  interactions: Interactions;
  route: RouteNode;
  /** Every state found so far on this route, `default` first. Mutated in place. */
  states: StateNode[];
  /** DOM signatures already claimed, so two triggers can't yield the same state. */
  seenSig: Set<string>;
  /** The container each state opened, used to scope the next depth's probing. */
  containers: Map<string, string>;
  /** The URL each state was seen at: a page anywhere else isn't that state. */
  urls: Map<string, string>;
  /** The `markDocument` token of the document probing loaded; any other is a navigation. */
  doc: string;
  atBaseline: (s: Snapshot) => boolean;
  /** So the maxPerPage-starvation notice is logged once per route, not per probe. */
  capLogged: boolean;
  stats: ProbeStats;
  log: (msg: string) => void;
  /** Told about each trigger that showed no change. */
  onQuiet?: (q: Omit<QuietTrigger, "route" | "device">) => void;
  /** Told every link on the page while a state is open: some only exist then. */
  onLinks?: (hrefs: string[]) => void;
  /** What this page does with nobody touching it; measured the first time it matters. */
  ambient?: Ambient;
}

/**
 * What a page does on its own: a carousel or an animation rewriting the DOM, a poll
 * asking the server every second. None of it is a click's doing, so none of it is a
 * reason to keep waiting on a click.
 */
interface Ambient {
  /** The DOM keeps changing by itself. */
  dom: boolean;
  /** Requests the page makes by itself, as origin + path. */
  urls: Set<string>;
}

/** How long an idle page is watched to learn what it does on its own. */
const AMBIENT_MS = 400;

const urlKey = (url: string) => url.split(/[?#]/)[0];

/** How often a probe looks again while the page is still busy. */
const POLL_MS = 100;
/** The DOM changed this recently: the page is still rendering what a click did. */
const RECENT_MUTATION_MS = 150;

/**
 * Requests a page has in flight, each with when it started. A probe asks only about
 * those its click started, so a page that polls, or a request that never ends (an
 * event stream, a long poll), doesn't make every probe wait.
 */
interface RequestLog {
  open: Map<Request, number>;
  /** While set, every request started is noted here too (see `measureAmbient`). */
  started?: Set<string>;
}
const inflight = new WeakMap<Page, RequestLog>();
function trackRequests(page: Page): RequestLog {
  let log = inflight.get(page);
  if (!log) {
    const made: RequestLog = { open: new Map() };
    page.on("request", (r) => {
      const type = r.resourceType();
      if (type === "websocket" || type === "eventsource") return;
      made.open.set(r, Date.now());
      made.started?.add(urlKey(r.url()));
    });
    const done = (r: Request) => void made.open.delete(r);
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    inflight.set(page, made);
    log = made;
  }
  return log;
}

/** Start noting when the document last changed (once per document). */
async function watchMutations(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const w = window as unknown as { __vcMutatedAt?: number };
      if (w.__vcMutatedAt !== undefined) return;
      w.__vcMutatedAt = performance.now();
      new MutationObserver(() => {
        w.__vcMutatedAt = performance.now();
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    })
    .catch(() => {});
}

/** When the document last changed, and the time now, on the page's own clock. */
function mutationClock(page: Page): Promise<{ at: number; now: number }> {
  return page
    .evaluate(() => ({
      at: (window as unknown as { __vcMutatedAt?: number }).__vcMutatedAt ?? -Infinity,
      now: performance.now(),
    }))
    .catch(() => ({ at: -Infinity, now: 0 }));
}

/** Why a page still counts as busy: the requests still loading, and a DOM still changing. */
interface Busy {
  urls: string[];
  dom: boolean;
}

/**
 * Is the page still working on what a click did: a request the click started still
 * loading, or the DOM changed a moment ago? Then a probe that saw no change yet
 * looks again, instead of calling the trigger dead. What the page is known to do on
 * its own (`ambient`) doesn't count.
 */
async function stillBusy(
  page: Page,
  requests: RequestLog,
  since: number,
  ambient: Ambient | undefined,
): Promise<Busy | undefined> {
  const urls: string[] = [];
  for (const [request, started] of requests.open) {
    const key = urlKey(request.url());
    if (started >= since && !ambient?.urls.has(key)) urls.push(key);
  }
  let dom = false;
  if (!ambient?.dom) {
    const { at, now } = await mutationClock(page);
    dom = now - at < RECENT_MUTATION_MS;
  }
  return urls.length || dom ? { urls, dom } : undefined;
}

/**
 * Watch an idle page for a moment: what it requests and whether its DOM keeps
 * changing, with nothing clicked. A single change (the last of what an earlier click
 * did) isn't a habit; the DOM counts only when it changed in both halves of the watch.
 */
async function measureAmbient(page: Page, requests: RequestLog): Promise<Ambient> {
  await watchMutations(page);
  requests.started = new Set();
  const start = await mutationClock(page);
  await page.waitForTimeout(AMBIENT_MS / 2);
  const mid = await mutationClock(page);
  await page.waitForTimeout(AMBIENT_MS / 2);
  const end = await mutationClock(page);
  const urls = requests.started;
  requests.started = undefined;
  return { dom: mid.at > start.now && end.at > mid.now, urls };
}

/** Does what the page does on its own account for everything that kept a probe waiting? */
function isAmbient(busy: Busy, ambient: Ambient): boolean {
  return (!busy.dom || ambient.dom) && busy.urls.every((u) => ambient.urls.has(u));
}

/**
 * Probe every candidate trigger reachable from `parent`, recording the ones that
 * produce a real UI mutation. Returns the states found (the next depth's parents).
 */
async function probeFrom(ctx: ProbeContext, parent: StateNode): Promise<StateNode[]> {
  const { page, routeUrl, waitUntil, interactions, states, seenSig, containers, log } = ctx;
  const nested = parent.recipe.length > 0;

  /**
   * Is the page showing the parent state right now? At the top level that's the
   * route's baseline; nested, it's the DOM signature the parent was recorded with.
   * A parent with no signature can't be recognised, so it always gets replayed.
   *
   * Open regions alone can't answer it: a route's baseline usually has none open,
   * and neither does the page a probe just navigated to. So the page must also be
   * the document probing loaded, at the URL the parent was seen at. Without that, a
   * submit button (a `<button>` with no `type` inside a `<form>` is one) leaves the
   * route, the next probe runs on the destination, and whatever it finds there is
   * recorded against a recipe that starts from the route and can't reproduce it.
   */
  const atParent = async (): Promise<boolean> => {
    const snap = await takeSnapshot(page).catch(() => undefined);
    if (!snap || snap.doc !== ctx.doc || snap.url !== ctx.urls.get(parent.id)) return false;
    return nested
      ? parent.signature !== undefined && snap.sig === parent.signature
      : ctx.atBaseline(snap);
  };

  /**
   * Restore the parent state, in increasing order of cost.
   *
   * Most probes change nothing at all — a button that turns out not to open
   * anything leaves the page exactly where it was — so the first thing to try is
   * simply looking. Then dismissing, which closes the overlay a probe did open.
   * Reloading is the last resort, and it is by far the most expensive thing state
   * discovery does: `probeFrom` runs it once per candidate, and a page with forty
   * candidates paid for forty navigations to visit the same URL.
   */
  const enterParent = async (): Promise<boolean> => {
    if (await atParent()) {
      ctx.stats.reused++;
      return true;
    }
    // Park the pointer first — hover-opened menus close on mouse-out, not Escape.
    await page.mouse.move(0, 0).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    if (await atParent()) {
      ctx.stats.reused++;
      return true;
    }
    try {
      ctx.stats.navigations++;
      await gotoRoute(page, routeUrl, waitUntil);
      ctx.doc = await markDocument(page);
      if (nested) await applyRecipe(page, parent.recipe);
      // Replaying the parent's own recipe is what defines where the parent is.
      ctx.urls.set(parent.id, await page.evaluate(() => location.href));
      return true;
    } catch {
      return false; // parent recipe no longer replays — nothing to nest under
    }
  };

  if (!(await enterParent())) return [];

  const container = containers.get(parent.id);
  if (nested && !container) return []; // unknown container: don't guess where to look
  const candidates = await collectCandidates(
    page,
    interactions,
    container ? idSelector(container) : undefined,
  );
  const found: StateNode[] = [];

  interface ProbeAttempt {
    action: "click" | "hover";
    before: Snapshot;
    after: Snapshot;
    kind: StateKind | null;
    /** Text the probe brought on screen. */
    appeared: string[];
    /** The probe wrote to local or session storage. */
    stored: boolean;
    /** Nothing showed, and the page was still busy when the probe stopped looking. */
    busy?: Busy;
  }

  const attempt = async (cand: RawCandidate, action: "click" | "hover"): Promise<ProbeAttempt> => {
    const before = await takeSnapshot(page);
    const linesBefore = await readLines(page);
    const storeBefore = await readStorage(page);
    const loc = locatorFor(page, cand.target);
    const requests = trackRequests(page);
    await watchMutations(page);
    const since = Date.now();
    if (action === "hover") await loc.hover({ timeout: interactions.clickTimeoutMs });
    else await loc.click({ timeout: interactions.clickTimeoutMs });
    const clicked = Date.now();
    await page.waitForTimeout(interactions.settleMs);
    let after = await takeSnapshot(page);
    // A new document is a navigation — a route, which route discovery owns — however
    // much the page it landed on happens to have open.
    let navigated = after.doc !== before.doc;
    let kind = navigated ? null : classifyChange(before, after, cand, action);
    // Nothing yet, but the page is still loading or rendering what the click did (a
    // dialog's code, its data, a slow dev server): keep looking for a while. A
    // trigger that does nothing leaves the page idle and costs no more than before.
    let busy: Busy | undefined;
    while (!kind && !navigated) {
      busy = await stillBusy(page, requests, since, ctx.ambient);
      if (!busy || Date.now() - clicked >= interactions.patienceMs) break;
      await page.waitForTimeout(POLL_MS);
      after = await takeSnapshot(page);
      navigated = after.doc !== before.doc;
      kind = navigated ? null : classifyChange(before, after, cand, action);
    }
    if (kind || navigated) busy = undefined;
    const appeared = kind ? addedLines(linesBefore, await readLines(page)) : [];
    // What a trigger stores (a panel remembered open, an item added to a list)
    // outlives the page: it would be showing in every later probe and every shot
    // captured after it. Note it, then undo it.
    const stored = !navigated && storageChanged(storeBefore, await readStorage(page));
    if (stored) await restoreStorage(page, storeBefore);
    return { action, before, after, kind, appeared, stored, busy };
  };
  const quietLabel = (cand: RawCandidate) => {
    const what = cand.label ? `"${cand.label}"` : describeTarget(cand.target);
    return nested ? `${parent.label} → ${what}` : what;
  };

  for (const cand of candidates) {
    if (states.length - 1 >= interactions.maxPerPage) {
      if (!ctx.capLogged) {
        ctx.capLogged = true;
        log(
          `    (cap: maxPerPage=${interactions.maxPerPage} reached on ${ctx.route.id} — remaining triggers skipped)`,
        );
      }
      break;
    }
    let probed = false;
    try {
      let probe = await attempt(cand, cand.probe ?? "click");
      // A menu-hinted trigger whose click changed nothing may be a hover dropdown.
      if (!probe.kind && !cand.probe && interactions.hover && cand.hint === "menu") {
        if (!(await enterParent())) break;
        probe = await attempt(cand, "hover");
      }
      probed = true;

      const { kind, before, after, action, appeared, stored } = probe;
      if (!kind && after.doc === before.doc) {
        let busy = probe.busy;
        // The first time a page is still busy with nothing to show for it, find out
        // whether it is ever idle: one that animates or polls by itself isn't loading
        // anything, and its later triggers needn't wait on that.
        if (busy && !ctx.ambient && (await enterParent())) {
          ctx.ambient = await measureAmbient(page, trackRequests(page));
          if (ctx.ambient.dom || ctx.ambient.urls.size) {
            log(
              `    ${ctx.route.id}: the page ${ctx.ambient.dom ? "changes" : "makes requests"} on its own — not taken for a click still loading`,
            );
          }
        }
        if (busy && ctx.ambient && isAmbient(busy, ctx.ambient)) busy = undefined;
        ctx.onQuiet?.({ trigger: quietLabel(cand), result: busy ? "busy" : "no change" });
      }
      if (kind && !seenSig.has(after.sig)) {
        seenSig.add(after.sig);

        const newModalId = after.openModalIds.find((x) => !before.openModalIds.includes(x));
        const newPanelId = after.openPanelIds.find((x) => !before.openPanelIds.includes(x));
        // What the trigger says it controls, if the page has it now that it's open
        // (a panel rendered on open isn't there before). An id it doesn't have is
        // a broken reference — waiting for it would fail every capture.
        const controls =
          cand.controls && (await page.locator(idSelector(cand.controls)).count()) > 0
            ? cand.controls
            : undefined;
        const openId = controls ?? newModalId ?? newPanelId;
        // Waited for on every later capture, so only an id the next load will have.
        const waitId = openId && !isGeneratedId(openId) ? openId : undefined;

        const id = makeStateId(kind, cand.label, nested ? parent.id : "", states);
        const recipe = [
          ...parent.recipe,
          // A panel that slid in without being a dialog has none to wait for.
          ...buildSteps(cand, kind, action, waitId, after.modals > before.modals),
        ];
        const state: StateNode = {
          id,
          kind,
          label: nested ? `${parent.label} → ${cand.label || kind}` : cand.label || kind,
          trigger: cand.target,
          recipe,
          signature: after.sig,
          siteKey: siteKeyFor(recipe, appeared),
          // Captured in a context of its own, so what it stores can't leak.
          ...(stored ? { isolate: true } : {}),
          source: "auto",
          shots: {},
        };
        states.push(state);
        found.push(state);
        const opened = openId;
        if (opened) containers.set(id, opened);
        ctx.urls.set(id, after.url);
        log(`    + ${ctx.route.id}: ${id}`);
        // A collapsed menu group or a drawer can hold links to pages nothing else
        // links to. Playwright's $$eval (DOM query in the page context), not JS eval().
        if (ctx.onLinks) {
          const hrefs = await page
            .$$eval("a[href]", (els) => els.map((e) => (e as HTMLAnchorElement).href))
            .catch(() => []);
          ctx.onLinks(hrefs);
        }

        // An id with a number in it may be a counter (`mat-dialog-3`, `ember812`):
        // open the same thing again and see whether it comes back under the same
        // id. Once per shape of id, so a site pays for it a handful of times.
        if (waitId && needsStabilityCheck(waitId) && (await enterParent())) {
          const again = await attempt(cand, action);
          const ids = again.kind
            ? [
                ...again.after.openModalIds.filter((x) => !again.before.openModalIds.includes(x)),
                ...again.after.openPanelIds.filter((x) => !again.before.openPanelIds.includes(x)),
              ]
            : [];
          if (ids.includes(waitId)) confirmStableId(waitId);
          else if (ids.length) {
            learnUnstableId(waitId, "reopen");
            state.recipe = [
              ...parent.recipe,
              ...buildSteps(cand, kind, action, undefined, after.modals > before.modals),
            ];
            state.siteKey = siteKeyFor(state.recipe, appeared);
            // The page is showing the state again: sign it without the id.
            const sig = (await takeSnapshot(page)).sig;
            state.signature = sig;
            seenSig.add(sig);
            log(`      ${id}: id ${waitId} changes when reopened — not waited for`);
          }
        }
      }
      if (!(await enterParent())) break;
    } catch {
      /* candidate not clickable / flaky — put the page back and move on */
      if (!probed) ctx.onQuiet?.({ trigger: quietLabel(cand), result: "click failed" });
      await enterParent().catch(() => false);
    }
  }
  return found;
}

/**
 * Probe candidate triggers and record the ones that produce a real UI mutation
 * as replayable states.
 *
 * `discovery.interactions.auto: false` records the default render only. Otherwise
 * `nestDepth` controls how deep probing goes: 1 (the default) captures single
 * mutations, and >1 also probes *inside* each opened state — a filter panel within
 * an open modal, say — recording the combined click sequence as one recipe. Nesting multiplies work,
 * so `maxPerPage` still caps the total states per route.
 */
export async function discoverStates(
  context: BrowserContext,
  routeUrl: string,
  route: RouteNode,
  config: Config,
  log: (msg: string) => void,
  onQuiet?: ProbeContext["onQuiet"],
  onLinks?: ProbeContext["onLinks"],
): Promise<StateNode[]> {
  const states: StateNode[] = [defaultState()];
  const interactions = config.discovery.interactions;
  if (!interactions.auto) return states;

  const waitUntil = config.stabilize.waitStrategy;
  const page = await context.newPage();
  try {
    await gotoRoute(page, routeUrl, waitUntil);
    const doc = await markDocument(page);
    const baseline = await takeSnapshot(page);
    const ctx: ProbeContext = {
      page,
      routeUrl,
      waitUntil,
      interactions,
      route,
      states,
      seenSig: new Set<string>(),
      containers: new Map<string, string>(),
      urls: new Map([[states[0].id, baseline.url]]),
      doc,
      // Equal to the baseline, not empty: a route can have regions open from the
      // start (a hidden trigger left at aria-expanded="true", an open <details>), and
      // demanding none made its own baseline unrecognisable — every probe reloaded.
      atBaseline: (s) => sameRegions(s, baseline),
      capLogged: false,
      stats: { navigations: 0, reused: 0 },
      log,
      onQuiet,
      onLinks,
    };

    let frontier = [states[0]];
    for (let depth = 1; depth <= interactions.nestDepth && frontier.length; depth++) {
      const next: StateNode[] = [];
      for (const parent of frontier) {
        if (states.length - 1 >= interactions.maxPerPage) break;
        next.push(...(await probeFrom(ctx, parent)));
      }
      frontier = next;
    }

    // Form probing runs last and on a clean page: it leaves fields focused and
    // possibly showing errors, which would poison any subsequent trigger probe.
    if (interactions.formStates && states.length - 1 < interactions.maxPerPage) {
      await gotoRoute(page, routeUrl, waitUntil);
      const { states: formStates, note } = await discoverFormStates(
        page,
        interactions.clickTimeoutMs,
      );
      for (const state of formStates) {
        if (states.length - 1 >= interactions.maxPerPage) break;
        states.push(state);
        log(`    + ${state.kind}: ${state.label}`);
      }
      if (note && !formStates.length) log(`    · forms: ${note}`);
    }

    // Worth a line: re-navigation is the dominant cost of probing, and this is the
    // only place that says how much of it was avoided.
    const { navigations, reused } = ctx.stats;
    if (navigations + reused > 0) {
      log(`    · ${ctx.route.id}: ${navigations} reload(s), ${reused} reuse(s) while probing`);
    }
  } finally {
    await page.close().catch(() => {});
  }
  return states;
}
