import type { BrowserContext, Page } from "playwright";
import type { Config } from "../shared/config";
import type { RouteNode, StateNode, StateKind, RecipeStep, Target } from "../shared/types";
import { locatorFor } from "../shared/selectors";
import { stateSlug } from "../shared/slug";
import { uniqueId } from "../shared/url";
import { applyRecipe } from "./recipe";

interface RawCandidate {
  target: Target;
  label: string;
  hint?: StateKind;
  controls?: string;
  /** How to trigger this candidate; anchors in navs are hover-only (a click navigates). */
  probe?: "click" | "hover";
}

interface Snapshot {
  modals: number;
  expanded: number;
  details: number;
  /** One entry per currently-open region, sorted; the raw material for `sig`. */
  ids: string[];
  sig: string;
  openModalIds: string[];
  openPanelIds: string[];
}

type Interactions = Config["discovery"]["interactions"];

/**
 * Find clickable elements that plausibly open a modal/menu/accordion/tab.
 * `root` limits the search to one container — used when probing *inside* an
 * already-open state so nested discovery doesn't re-find the whole page chrome.
 */
async function collectCandidates(
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
  };
  const raw = await page.evaluate((cfg) => {
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
      const tid = el.getAttribute("data-testid");
      if (tid) return { testId: tid };
      if (el.id) return { selector: `#${CSS.escape(el.id)}` };
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
    }[] = [];
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
      const ty = el.getAttribute("type");
      if (ty === "submit" || ty === "reset") continue;
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
      out.push({
        target: targetFor(el),
        label,
        hint: hintFor(el),
        controls: el.getAttribute("aria-controls") || undefined,
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
        out.push({
          target: targetFor(a),
          label,
          hint: "menu",
          controls: a.getAttribute("aria-controls") || undefined,
          probe: "hover",
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

  return raw as RawCandidate[];
}

function takeSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const vis = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const modals = Array.from(
      document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]'),
    ).filter(vis);
    const expanded = Array.from(document.querySelectorAll('[aria-expanded="true"]'));
    const details = Array.from(document.querySelectorAll("details[open]")).filter(vis);
    const ids = [
      ...modals.map((e) => `m:${e.id || e.getAttribute("aria-label") || ""}`),
      ...details.map((e) => `d:${e.id || ""}`),
      ...expanded.map((e) => `e:${e.getAttribute("aria-controls") || e.id || ""}`),
    ].sort();
    const openModalIds = modals.map((e) => e.id).filter(Boolean);
    const openPanelIds = [
      ...details.map((e) => e.id).filter(Boolean),
      ...expanded.map((e) => e.getAttribute("aria-controls") || "").filter(Boolean),
    ];
    return {
      modals: modals.length,
      expanded: expanded.length,
      details: details.length,
      ids,
      sig: ids.join("|"),
      openModalIds,
      openPanelIds,
    };
  });
}

/**
 * Open regions present in `after` that weren't in `before` (multiset difference,
 * so two identically-labelled panels still count separately).
 */
export function addedRegions(
  before: Pick<Snapshot, "ids">,
  after: Pick<Snapshot, "ids">,
): string[] {
  const remaining = new Map<string, number>();
  for (const id of before.ids) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const added: string[] = [];
  for (const id of after.ids) {
    const n = remaining.get(id) ?? 0;
    if (n > 0) remaining.set(id, n - 1);
    else added.push(id);
  }
  return added;
}

function classifyChange(
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
  const lbl = (cand.label || "").toLowerCase();
  const menuish = cand.hint === "menu" || /menu|nav/.test(lbl);

  if (action === "hover") {
    if (menuish) return "menu";
    if (opened) return "popover";
    if (detailsMore) return "accordion";
    return "hover";
  }
  if (opened) return menuish ? "menu" : "modal";
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
): RecipeStep[] {
  const steps: RecipeStep[] = [{ action, target: cand.target }];
  // Prefer waiting for the exact element that opened — a generic [role=dialog] can
  // match an unrelated hidden element (e.g. a closed drawer) and never go visible.
  const id = cand.controls ?? openId;
  if (id) {
    steps.push({ action: "waitFor", selector: idSelector(id), state: "visible" });
  } else if (kind === "modal" || kind === "menu" || kind === "drawer") {
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
  atBaseline: (s: Snapshot) => boolean;
  /** So the maxPerPage-starvation notice is logged once per route, not per probe. */
  capLogged: boolean;
  log: (msg: string) => void;
}

/**
 * Probe every candidate trigger reachable from `parent`, recording the ones that
 * produce a real UI mutation. Returns the states found (the next depth's parents).
 */
async function probeFrom(ctx: ProbeContext, parent: StateNode): Promise<StateNode[]> {
  const { page, routeUrl, waitUntil, interactions, states, seenSig, containers, log } = ctx;
  const nested = parent.recipe.length > 0;

  // Restore the parent state. At the top level a cheap Escape usually suffices;
  // once we're nested, only replaying the parent's recipe is reliable.
  const enterParent = async (): Promise<boolean> => {
    if (!nested) {
      // Park the pointer first — hover-opened menus close on mouse-out, not Escape.
      await page.mouse.move(0, 0).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      if (ctx.atBaseline(await takeSnapshot(page))) return true;
      await page.goto(routeUrl, { waitUntil });
      return true;
    }
    try {
      await page.goto(routeUrl, { waitUntil });
      await applyRecipe(page, parent.recipe);
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
  }

  const attempt = async (cand: RawCandidate, action: "click" | "hover"): Promise<ProbeAttempt> => {
    const before = await takeSnapshot(page);
    const loc = locatorFor(page, cand.target);
    if (action === "hover") await loc.hover({ timeout: interactions.clickTimeoutMs });
    else await loc.click({ timeout: interactions.clickTimeoutMs });
    await page.waitForTimeout(interactions.settleMs);
    const after = await takeSnapshot(page);
    return { action, before, after, kind: classifyChange(before, after, cand, action) };
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
    try {
      let probe = await attempt(cand, cand.probe ?? "click");
      // A menu-hinted trigger whose click changed nothing may be a hover dropdown.
      if (!probe.kind && !cand.probe && interactions.hover && cand.hint === "menu") {
        if (!(await enterParent())) break;
        probe = await attempt(cand, "hover");
      }

      const { kind, before, after, action } = probe;
      if (kind && !seenSig.has(after.sig)) {
        seenSig.add(after.sig);

        const newModalId = after.openModalIds.find((x) => !before.openModalIds.includes(x));
        const newPanelId = after.openPanelIds.find((x) => !before.openPanelIds.includes(x));
        const openId = newModalId ?? newPanelId;

        const id = makeStateId(kind, cand.label, nested ? parent.id : "", states);
        const state: StateNode = {
          id,
          kind,
          label: nested ? `${parent.label} → ${cand.label || kind}` : cand.label || kind,
          trigger: cand.target,
          recipe: [...parent.recipe, ...buildSteps(cand, kind, action, openId)],
          signature: after.sig,
          source: "auto",
          shots: {},
        };
        states.push(state);
        found.push(state);
        const opened = cand.controls ?? openId;
        if (opened) containers.set(id, opened);
        log(`    + ${ctx.route.id}: ${id}`);
      }
      if (!(await enterParent())) break;
    } catch {
      /* candidate not clickable / flaky — put the page back and move on */
      await enterParent().catch(() => false);
    }
  }
  return found;
}

/**
 * Probe candidate triggers and record the ones that produce a real UI mutation
 * as replayable states.
 *
 * `discovery.interactions.nestDepth` controls how deep this goes: 0 captures the
 * default render only, 1 (the default) captures single mutations, and >1 also
 * probes *inside* each opened state — a filter panel within an open modal, say —
 * recording the combined click sequence as one recipe. Nesting multiplies work,
 * so `maxPerPage` still caps the total states per route.
 */
export async function discoverStates(
  context: BrowserContext,
  routeUrl: string,
  route: RouteNode,
  config: Config,
  log: (msg: string) => void,
): Promise<StateNode[]> {
  const states: StateNode[] = [
    { id: "default", kind: "default", label: "Default", recipe: [], source: "auto", shots: {} },
  ];
  const interactions = config.discovery.interactions;
  if (!interactions.auto || interactions.nestDepth < 1) return states;

  const waitUntil = config.stabilize.waitStrategy;
  const page = await context.newPage();
  try {
    await page.goto(routeUrl, { waitUntil });
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
      atBaseline: (s) => s.sig === baseline.sig && !s.modals && !s.expanded && !s.details,
      capLogged: false,
      log,
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
  } finally {
    await page.close().catch(() => {});
  }
  return states;
}
