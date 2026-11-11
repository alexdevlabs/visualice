import type { Page } from "playwright";
import { GENERATED_ID_SOURCE } from "./generated-ids";

/**
 * What a page is showing, reduced to what state discovery and capture compare:
 * which regions are open, on which document, at which URL.
 */
export interface Snapshot {
  modals: number;
  expanded: number;
  details: number;
  /** On-screen fixed overlays that aren't one of the regions above (off-canvas drawers). */
  overlays: number;
  /** One entry per currently-open region, sorted; the raw material for `sig`. */
  ids: string[];
  sig: string;
  openModalIds: string[];
  openPanelIds: string[];
  /** `location.href`. A probe that routes — by `pushState` or for real — changes it. */
  url: string;
  /**
   * The token `markDocument` left on this document, or null. A navigation replaces
   * the document, token and all, so this is what tells "the same page" from "a
   * page at the same URL with nothing open" — which is all a submitted form, or a
   * link to a page shaped like this one, looks like to the open-region check.
   */
  doc: string | null;
}

/** Where `markDocument` keeps its token. */
const DOC_KEY = "__visualiceDocument";

let documents = 0;

/**
 * Label the document the page is showing, and return the label. Call it straight
 * after a navigation you made on purpose; a later `takeSnapshot` whose `doc` differs
 * saw a document that arrived some other way.
 */
export async function markDocument(page: Page): Promise<string> {
  const token = `doc-${++documents}`;
  await page.evaluate(
    ([key, value]) => {
      (window as unknown as Record<string, string>)[key] = value;
    },
    [DOC_KEY, token] as const,
  );
  return token;
}

export function takeSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(
    ([docKey, generatedId]) => {
      // A generated id (React's useId, a library's counter) shifts with render order,
      // so it can't name a region from one load to the next.
      const generated = new RegExp(generatedId);
      const stableId = (id: string | null | undefined): string =>
        id && !generated.test(id) ? id : "";
      const vis = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };

      // Where an element sits in the document, as a sibling-index path. Two elements
      // that exist at the same time can't share one — but two that exist one after
      // the other can, which is the portal pattern (an overlay created under <body>
      // on open and removed on close), so the path is never used alone.
      const domPath = (el: Element): string => {
        const parts: string[] = [];
        let n: Element | null = el;
        while (n && n !== document.documentElement) {
          const parent: Element | null = n.parentElement;
          if (!parent) break;
          parts.unshift(`${n.tagName.toLowerCase()}${Array.from(parent.children).indexOf(n)}`);
          n = parent;
        }
        return parts.join(">");
      };

      // What the region says, hashed: the part of an unnamed region's identity that
      // a sibling mounted in the same spot doesn't share. Its opening text, or for a
      // region with none (an image lightbox), what it shows.
      const fingerprint = (el: Element): string => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
        const media = el.querySelector("img[src],video[src],iframe[src]")?.getAttribute("src");
        const basis = text || media || "";
        let h = 0x811c9dc5;
        for (let i = 0; i < basis.length; i++) {
          h ^= basis.charCodeAt(i);
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(36);
      };

      // The most specific name the region carries, falling back to where it is and
      // what it says. `aria-labelledby` is resolved because a dialog titled by its
      // own heading is the common markup, and that heading is exactly what tells two
      // of them apart. Deterministic for a given DOM, so a state re-probed still
      // dedupes against itself.
      const regionKey = (el: Element): string => {
        if (stableId(el.id)) return el.id;
        const label = el.getAttribute("aria-label");
        if (label) return label;
        const by = el.getAttribute("aria-labelledby");
        if (by) {
          const text = by
            .split(/\s+/)
            .map((id) =>
              (document.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim(),
            )
            .filter(Boolean)
            .join(" ")
            .slice(0, 60);
          if (text) return text;
        }
        return `@${domPath(el)}~${fingerprint(el)}`;
      };

      const modals = Array.from(
        document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]'),
      ).filter(vis);
      const expanded = Array.from(document.querySelectorAll('[aria-expanded="true"]'));
      const details = Array.from(document.querySelectorAll("details[open]")).filter(vis);
      // A fixed panel slid into view — an off-canvas drawer moved by a transform, with
      // no dialog role or aria-expanded to say so. Parked off-screen it doesn't count;
      // on screen it does. One that is always there (a cookie bar, a fixed header) is
      // in every snapshot, so it never reads as newly opened. Empty layers (backdrops)
      // and the regions already counted above are left out.
      const counted = [...modals, ...details];
      for (const e of expanded) {
        for (const id of (e.getAttribute("aria-controls") || "").split(/\s+/)) {
          const el = id && document.getElementById(id);
          if (el) counted.push(el);
        }
      }
      const overlays: Element[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode() as Element | null; n; ) {
        if (getComputedStyle(n).position !== "fixed") {
          n = walker.nextNode() as Element | null;
          continue;
        }
        const r = n.getBoundingClientRect();
        const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
        const onScreen = w >= 40 && h >= 40 && w * h >= 0.5 * r.width * r.height;
        const hasContent =
          (n.textContent || "").trim() !== "" || !!n.querySelector("img,svg,video");
        if (
          onScreen &&
          hasContent &&
          vis(n) &&
          n.getAttribute("aria-hidden") !== "true" &&
          !counted.some((c) => c.contains(n!) || n!.contains(c))
        ) {
          overlays.push(n);
        }
        // Nothing inside a fixed element is a separate overlay: skip its subtree.
        let next: Node | null = walker.nextSibling();
        while (!next && walker.parentNode()) next = walker.nextSibling();
        n = next as Element | null;
      }
      const ids = [
        ...modals.map((e) => `m:${regionKey(e)}`),
        ...overlays.map((e) => `f:${regionKey(e)}`),
        ...details.map((e) => `d:${regionKey(e)}`),
        // An `aria-expanded` element is the *trigger*; the region it opened is what
        // `aria-controls` names, so that stays the preferred key here.
        ...expanded.map((e) => `e:${stableId(e.getAttribute("aria-controls")) || regionKey(e)}`),
      ].sort();
      const openModalIds = modals.map((e) => e.id).filter(Boolean);
      // ARIA allows `aria-controls` to list several ids, and this becomes a selector
      // that needs exactly one: the first that is actually showing, else the first
      // that exists. A reference to an id the page doesn't have (markup that renamed
      // its panel and not the button) names nothing to wait for.
      const controlledId = (e: Element): string => {
        const ids = (e.getAttribute("aria-controls") || "")
          .split(/\s+/)
          .filter((id) => id && document.getElementById(id));
        const showing = ids.find((id) => vis(document.getElementById(id)!));
        return showing ?? ids[0] ?? "";
      };
      const openPanelIds = [
        ...details.map((e) => e.id).filter(Boolean),
        ...expanded.map(controlledId).filter(Boolean),
      ];
      const doc = (window as unknown as Record<string, string | undefined>)[docKey];
      return {
        modals: modals.length,
        expanded: expanded.length,
        details: details.length,
        overlays: overlays.length,
        ids,
        sig: ids.join("|"),
        openModalIds,
        openPanelIds,
        url: location.href,
        doc: doc ?? null,
      };
    },
    [DOC_KEY, GENERATED_ID_SOURCE] as const,
  );
}

/** Same open regions — the comparison that says "this is that state again". */
export function sameRegions(a: Snapshot, b: Snapshot): boolean {
  return (
    a.sig === b.sig &&
    a.modals === b.modals &&
    a.expanded === b.expanded &&
    a.details === b.details &&
    a.overlays === b.overlays
  );
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

const MAX_LINES = 40;
const LINE_CHARS = 140;

/** Lines of `after` that `before` doesn't have, as a multiset difference. */
export function addedLines(before: string[], after: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const l of before) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after) {
    const n = remaining.get(l) ?? 0;
    if (n > 0) remaining.set(l, n - 1);
    else if (!out.includes(l)) out.push(l);
  }
  return out.slice(0, MAX_LINES);
}

/** The page's visible text, one trimmed line each — what `addedLines` diffs. */
export const readLines = (page: Page): Promise<string[]> =>
  page
    .evaluate(
      (max) =>
        (document.body?.innerText ?? "")
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim().slice(0, max))
          .filter(Boolean),
      LINE_CHARS,
    )
    .catch(() => []);

/** What a page keeps in its origin's storage, key by key. */
export interface StorageDump {
  local: Record<string, string>;
  session: Record<string, string>;
}

/** Keys whose value differs between two storage dumps, added and removed included. */
export function changedKeys(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

/** Did anything between two dumps write to local or session storage? */
export const storageChanged = (before: StorageDump, after: StorageDump): boolean =>
  changedKeys(before.local, after.local).length > 0 ||
  changedKeys(before.session, after.session).length > 0;

export const readStorage = (page: Page): Promise<StorageDump> =>
  page
    // Flat on purpose: no named helpers inside the page (esbuild's keepNames).
    .evaluate(() => {
      const out: { local: Record<string, string>; session: Record<string, string> } = {
        local: {},
        session: {},
      };
      try {
        for (const [into, store] of [
          [out.local, localStorage],
          [out.session, sessionStorage],
        ] as const) {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (k !== null) into[k] = store.getItem(k) ?? "";
          }
        }
      } catch {
        /* storage blocked (sandboxed frame, opaque origin): report nothing changed */
      }
      return out;
    })
    .catch(() => ({ local: {}, session: {} }));

/** Put storage back the way a dump found it — undoing what a probe wrote. */
export const restoreStorage = (page: Page, dump: StorageDump): Promise<void> =>
  page
    .evaluate((d) => {
      try {
        for (const [store, values] of [
          [localStorage, d.local],
          [sessionStorage, d.session],
        ] as const) {
          store.clear();
          for (const [k, v] of Object.entries(values)) store.setItem(k, v);
        }
      } catch {
        /* storage blocked: nothing was written there either */
      }
    }, dump)
    .catch(() => {});
