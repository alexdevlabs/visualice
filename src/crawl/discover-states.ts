import type { BrowserContext, Page } from "playwright";
import type { Config } from "../shared/config";
import type { RouteNode, StateNode, StateKind, RecipeStep, Target } from "../shared/types";
import { locatorFor } from "../shared/selectors";
import { stateSlug } from "../shared/slug";

interface RawCandidate {
  target: Target;
  label: string;
  hint?: StateKind;
  controls?: string;
}

interface Snapshot {
  modals: number;
  expanded: number;
  details: number;
  sig: string;
  openModalIds: string[];
  openPanelIds: string[];
}

type Interactions = Config["discovery"]["interactions"];

/** Find clickable elements that plausibly open a modal/menu/accordion/tab. */
async function collectCandidates(page: Page, interactions: Interactions): Promise<RawCandidate[]> {
  const arg = {
    denyLabels: interactions.denyLabels,
    denySelectors: interactions.denySelectors,
    extra: interactions.extraTriggers,
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
      if (el.tagName === "BUTTON" && text && text.length <= 40) return { role: "button", name: text };
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

    const els = Array.from(document.querySelectorAll(sel));
    const seen = new Set<Element>();
    const out: { target: Record<string, unknown>; label: string; hint?: string; controls?: string }[] = [];
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (!visible(el)) continue;
      if (el.tagName === "A") continue; // anchors are routes, not in-page states
      if (el.getAttribute("target") === "_blank") continue;
      if (el.hasAttribute("download")) continue;
      const ty = el.getAttribute("type");
      if (ty === "submit" || ty === "reset") continue;
      if (cfg.denySelectors.some((s) => { try { return el.matches(s); } catch { return false; } })) continue;
      const label = (
        el.getAttribute("aria-label") ||
        (el.textContent || "").replace(/\s+/g, " ").trim() ||
        el.getAttribute("title") ||
        ""
      ).slice(0, 60);
      if (deny.some((d) => label.toLowerCase().includes(d))) continue;
      out.push({
        target: targetFor(el),
        label,
        hint: hintFor(el),
        controls: el.getAttribute("aria-controls") || undefined,
      });
      if (out.length >= 40) break;
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
      sig: ids.join("|"),
      openModalIds,
      openPanelIds,
    };
  });
}

function classifyChange(before: Snapshot, after: Snapshot, cand: RawCandidate): StateKind | null {
  const opened = after.modals > before.modals;
  const expandedMore = after.expanded > before.expanded;
  const detailsMore = after.details > before.details;
  if (!opened && !expandedMore && !detailsMore && after.sig === before.sig) return null;

  const lbl = (cand.label || "").toLowerCase();
  if (opened) {
    if (cand.hint === "menu" || /menu|nav/.test(lbl)) return "menu";
    return "modal";
  }
  if (detailsMore) return "accordion";
  if (cand.hint === "tab") return "tab";
  return "accordion";
}

// Escape a value for use inside a double-quoted CSS attribute selector
// (`[id="..."]`), so ids containing quotes or backslashes don't break the selector.
function cssAttrValue(s: string): string {
  return s.replace(/[\\"]/g, "\\$&");
}

function buildRecipe(cand: RawCandidate, kind: StateKind, openId?: string): RecipeStep[] {
  const recipe: RecipeStep[] = [{ action: "click", target: cand.target }];
  // Prefer waiting for the exact element that opened — a generic [role=dialog] can
  // match an unrelated hidden element (e.g. a closed drawer) and never go visible.
  const id = cand.controls ?? openId;
  if (id) {
    recipe.push({ action: "waitFor", selector: `[id="${cssAttrValue(id)}"]`, state: "visible" });
  } else if (kind === "modal" || kind === "menu" || kind === "drawer") {
    recipe.push({ action: "waitFor", selector: 'dialog[open]:visible,[role="dialog"]:visible', state: "visible" });
  } else {
    recipe.push({ action: "wait", ms: 200 });
  }
  return recipe;
}

function makeStateId(kind: StateKind, label: string, existing: StateNode[]): string {
  const slug = stateSlug(label).slice(0, 32).replace(/-+$/, "");
  const base = slug ? `${kind}-${slug}` : kind;
  if (!existing.some((s) => s.id === base)) return base;
  let n = 2;
  while (existing.some((s) => s.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Probe candidate triggers and record the ones that produce a real UI mutation
 * as replayable states. Single-mutation only (nestDepth handling is future work).
 */
export async function discoverStates(
  context: BrowserContext,
  routeUrl: string,
  route: RouteNode,
  config: Config,
  log: (msg: string) => void,
): Promise<StateNode[]> {
  const states: StateNode[] = [{ id: "default", kind: "default", label: "Default", recipe: [], shots: {} }];
  if (!config.discovery.interactions.auto) return states;

  const waitUntil = config.stabilize.waitStrategy;
  const page = await context.newPage();
  try {
    await page.goto(routeUrl, { waitUntil });
    const candidates = await collectCandidates(page, config.discovery.interactions);
    const seenSig = new Set<string>();
    const maxStates = config.discovery.interactions.maxPerPage;
    const baseline = await takeSnapshot(page);
    const atBaseline = (s: Snapshot) =>
      s.sig === baseline.sig && !s.modals && !s.expanded && !s.details;

    for (const cand of candidates) {
      if (states.length - 1 >= maxStates) break;
      try {
        // Reset to a clean page between probes. Try a cheap Escape first (closes
        // most modals/menus); only pay for a full reload if the page didn't reset.
        await page.keyboard.press("Escape").catch(() => {});
        if (!atBaseline(await takeSnapshot(page))) {
          await page.goto(routeUrl, { waitUntil });
        }
        const before = await takeSnapshot(page);
        await locatorFor(page, cand.target).click({ timeout: 4000 });
        await page.waitForTimeout(250);
        const after = await takeSnapshot(page);

        const kind = classifyChange(before, after, cand);
        if (!kind) continue;
        if (seenSig.has(after.sig)) continue;
        seenSig.add(after.sig);

        const newModalId = after.openModalIds.find((x) => !before.openModalIds.includes(x));
        const newPanelId = after.openPanelIds.find((x) => !before.openPanelIds.includes(x));
        const openId = newModalId ?? newPanelId;

        const id = makeStateId(kind, cand.label, states);
        states.push({
          id,
          kind,
          label: cand.label || kind,
          trigger: cand.target,
          recipe: buildRecipe(cand, kind, openId),
          signature: after.sig,
          shots: {},
        });
        log(`    + ${route.id}: ${id}`);
      } catch {
        /* candidate not clickable / flaky — skip */
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return states;
}
