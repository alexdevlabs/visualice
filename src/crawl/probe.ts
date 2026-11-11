import { chromium, firefox, webkit } from "playwright";
import type { BrowserContext, Page } from "playwright";
import type { Config } from "../shared/config";
import type { Device, RecipeStep, StateKind, Target } from "../shared/types";
import { testIdAttribute, useTestIdAttribute } from "../shared/selectors";
import { applyContextInit } from "./stabilize";
import { deviceContextOptions } from "./context-options";
import { applyRecipe, gotoRoute, resolveUrl } from "./recipe";
import { generatedIdSource, useUnstableIds } from "./generated-ids";
import {
  addedLines,
  addedRegions,
  changedKeys,
  markDocument,
  readLines,
  readStorage,
  takeSnapshot,
} from "./snapshot";

export { addedLines, changedKeys } from "./snapshot";
import { classifyChange, collectCandidates } from "./discover-states";
import { sentToLogin } from "./capture";
import { launchOptions } from "../shared/launch";

/**
 * `visualice probe`: one page, one recipe, and a report of what happened — the
 * engine's eyes, lent to an agent.
 *
 * Explore mode used to mean an agent driving a browser of its own and guessing
 * whether what it saw would replay. Probing runs the recipe through the same code
 * capture will (same context options, same session, same recipe runner), so a
 * recipe that probes cleanly is one that captures; and each call gets a browser of
 * its own, so several explorer agents can work a site side by side.
 *
 * Without a recipe it returns the page's inventory instead: the triggers discovery
 * would probe, the fields and submit buttons it never presses, the selects it can't
 * choose from, the links out — the evidence an agent decides from.
 */

/** A form control, with what an agent needs to fill, choose or submit it. */
export interface InventoryField {
  target: Target;
  label: string;
  type: string;
  required: boolean;
  /** A `<select>`'s options, by value and visible label. */
  options?: { value: string; label: string }[];
}

export interface InventoryForm {
  fields: InventoryField[];
  /** The button that submits it — never pressed by discovery, so never probed. */
  submit?: { target: Target; label: string };
}

export interface PageInventory {
  title: string;
  headings: string[];
  /** Same-origin links, as origin-relative paths with their text. */
  links: { path: string; text: string }[];
  /** What state discovery would click or hover: candidates for menus, modals, tabs. */
  triggers: { target: Target; label: string; hint?: StateKind; probe?: "click" | "hover" }[];
  forms: InventoryForm[];
  /** Controls outside any form (a sort dropdown, a search box). */
  controls: InventoryField[];
}

export interface ProbeOutcome {
  /** Where the probe started (the page's own URL, resolved). */
  url: string;
  /** Where the page is once the recipe has run, origin-relative. */
  finalPath: string;
  status?: number;
  ok: boolean;
  /** The step that threw, 0-based, and why. Steps before it ran. */
  error?: { step: number; message: string };
  /** The recipe loaded a different document — a link followed or a form submitted. */
  navigated: boolean;
  /** The page loaded as the login page: the saved session is gone. */
  sentToLogin: boolean;
  /** Regions the recipe opened (modals, drawers, panels), by snapshot key. */
  opened: string[];
  /** Best guess at the state's kind, when the recipe stayed on the page. */
  kind?: StateKind;
  /** Visible text lines that appeared — inline errors, toasts, counts. */
  appeared: string[];
  /** Visible text lines that went away. */
  disappeared: string[];
  /** What the recipe wrote to storage. Anything here wants `isolate: true`. */
  storage: { localStorage: string[]; sessionStorage: string[]; cookies: string[] };
  /** True when `storage` changed: capturing this state should be isolated. */
  suggestIsolate: boolean;
  /** The screenshot, when one was asked for. */
  shot?: string;
  /** The page's inventory after the recipe, when asked for (`--inventory`). */
  inventory?: PageInventory;
}

export interface ProbeOptions {
  config: Config;
  baseUrl: string;
  /** Path (or absolute URL) of the page to load. */
  url: string;
  recipe?: RecipeStep[];
  /** Device to probe as (by name); the first configured device otherwise. */
  device?: string;
  storageState?: string;
  /** Write a viewport screenshot, in CSS pixels, here. */
  shotPath?: string;
  /** Also report the inventory of the page the recipe left. */
  inventory?: boolean;
}

/**
 * A kind for what the recipe did, when it stayed on the page. Regions opening is
 * the discovery heuristic's call; text appearing with nothing opened is what an
 * inline error or a changed list looks like.
 */
export function guessKind(
  opened: StateKind | null,
  appeared: string[],
  recipe: RecipeStep[],
): StateKind | undefined {
  if (opened) return opened;
  if (!appeared.length) return undefined;
  if (appeared.some((l) => /error|required|invalid|must|can't|cannot|sorry/i.test(l)))
    return "validation";
  if (recipe.some((s) => s.action === "hover")) return "hover";
  return "other";
}

const readCookies = async (context: BrowserContext): Promise<Record<string, string>> =>
  Object.fromEntries((await context.cookies()).map((c) => [`${c.name}@${c.domain}`, c.value]));

/**
 * Fields, forms and loose controls. Written as one flat function on purpose: named
 * inner functions get an esbuild `__name()` wrapper that doesn't exist in the page
 * (see discover-forms.ts).
 */
async function readFormsAndControls(
  page: Page,
): Promise<{ forms: InventoryForm[]; controls: InventoryField[] }> {
  return page
    .evaluate(
      ([testIdAttr, generatedId]) => {
        const generated = new RegExp(generatedId);
        const forms: { fields: unknown[]; submit?: unknown }[] = [];
        const formIndex = new Map<Element, number>();
        const controls: unknown[] = [];
        const all = Array.from(
          document.querySelectorAll(
            "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), select, textarea",
          ),
        ) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
        for (const el of all) {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const tid = el.getAttribute(testIdAttr);
          const labelEl = el.labels && el.labels[0];
          const label = (
            el.getAttribute("aria-label") ||
            (labelEl ? labelEl.textContent : "") ||
            el.getAttribute("placeholder") ||
            el.getAttribute("name") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);
          const target = tid
            ? { testId: tid }
            : el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !generated.test(el.id)
              ? { selector: `#${el.id}` }
              : el.getAttribute("name")
                ? { selector: `[name="${el.getAttribute("name")}"]` }
                : label
                  ? { label }
                  : { selector: el.tagName.toLowerCase() };
          const field: Record<string, unknown> = {
            target,
            label,
            type:
              el.tagName === "SELECT"
                ? "select"
                : el.getAttribute("type") || el.tagName.toLowerCase(),
            required: el.required || el.getAttribute("aria-required") === "true",
          };
          if (el.tagName === "SELECT") {
            field.options = Array.from((el as HTMLSelectElement).options)
              .slice(0, 30)
              .map((o) => ({ value: o.value, label: o.text.trim() }));
          }
          const form = el.closest("form");
          if (!form) {
            controls.push(field);
            continue;
          }
          let i = formIndex.get(form);
          if (i === undefined) {
            i = forms.length;
            formIndex.set(form, i);
            const btn = form.querySelector(
              "button[type=submit], button:not([type]), input[type=submit]",
            ) as HTMLElement | null;
            const entry: { fields: unknown[]; submit?: unknown } = { fields: [] };
            if (btn) {
              const btid = btn.getAttribute(testIdAttr);
              const text = (btn.textContent || (btn as HTMLInputElement).value || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);
              entry.submit = {
                target: btid
                  ? { testId: btid }
                  : btn.id && /^[A-Za-z][\w-]*$/.test(btn.id) && !generated.test(btn.id)
                    ? { selector: `#${btn.id}` }
                    : text
                      ? { role: "button", name: text }
                      : { selector: "form [type=submit]" },
                label: text,
              };
            }
            forms.push(entry);
          }
          forms[i].fields.push(field);
        }
        return { forms, controls };
      },
      [testIdAttribute(), generatedIdSource()] as const,
    )
    .catch(() => ({ forms: [], controls: [] })) as Promise<{
    forms: InventoryForm[];
    controls: InventoryField[];
  }>;
}

/** What a page offers an explorer: see `PageInventory`. */
export async function readInventory(page: Page, config: Config): Promise<PageInventory> {
  const origin = new URL(page.url()).origin;
  const [title, headings, rawLinks, candidates, formsAndControls] = await Promise.all([
    page.title().catch(() => ""),
    page
      .$$eval("h1, h2, h3", (els) =>
        els.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
      )
      .catch(() => [] as string[]),
    page
      .$$eval("a[href]", (els) =>
        els.map((e) => ({
          href: (e as HTMLAnchorElement).href,
          text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        })),
      )
      .catch(() => [] as { href: string; text: string }[]),
    collectCandidates(page, config.discovery.interactions).catch(() => []),
    readFormsAndControls(page),
  ]);
  const links: PageInventory["links"] = [];
  const seen = new Set<string>();
  for (const l of rawLinks) {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const p = u.pathname + u.search + (u.hash.startsWith("#/") ? u.hash : "");
    if (seen.has(p)) continue;
    seen.add(p);
    links.push({ path: p, text: l.text });
    if (links.length >= 100) break;
  }
  return {
    title,
    headings: headings.slice(0, 20),
    links,
    triggers: candidates.map((c) => ({
      target: c.target,
      label: c.label,
      ...(c.hint ? { hint: c.hint } : {}),
      ...(c.probe ? { probe: c.probe } : {}),
    })),
    ...formsAndControls,
  };
}

/** The device to probe as: the named one, or the first configured. */
export function pickDevice(config: Config, name?: string): Device {
  if (!name) return config.devices[0];
  const device = config.devices.find((d) => d.name === name);
  if (!device) {
    throw new Error(
      `no device "${name}" in the config (have: ${config.devices.map((d) => d.name).join(", ")})`,
    );
  }
  return device;
}

/** Load a page, optionally run a recipe on it, and report — see the module comment. */
export async function probePage(
  opts: ProbeOptions,
): Promise<{ inventory: PageInventory } | ProbeOutcome> {
  const { config, baseUrl } = opts;
  useTestIdAttribute(config.testIdAttribute);
  useUnstableIds(config.discovery.unstableIds);
  const device = pickDevice(config, opts.device);
  const engines = { chromium, firefox, webkit };
  const browser = await engines[device.browser ?? "chromium"].launch(launchOptions());
  try {
    const context = await browser.newContext(
      deviceContextOptions(config, device, opts.storageState),
    );
    // Short: an agent iterating on a recipe wants a wrong target to fail fast.
    context.setDefaultTimeout(Math.min(config.politeness.timeoutMs, 8_000));
    await applyContextInit(context, config.stabilize);
    const page = await context.newPage();
    const url = resolveUrl(baseUrl, opts.url);
    const resp = await gotoRoute(page, url, config.stabilize.waitStrategy).catch(async () =>
      // A page that never goes network-idle still has something to show.
      gotoRoute(page, url, "load"),
    );
    const landed = page.url();
    const login = sentToLogin(config, baseUrl, { url: opts.url, finalUrl: opts.url }, landed);

    if (!opts.recipe) {
      if (login) throw new Error(`${opts.url} loaded the login page — the session has lapsed`);
      return { inventory: await readInventory(page, config) };
    }

    const docBefore = await markDocument(page);
    const before = await takeSnapshot(page);
    const linesBefore = await readLines(page);
    const storeBefore = await readStorage(page);
    const cookiesBefore = await readCookies(context);

    let error: ProbeOutcome["error"];
    for (let i = 0; i < opts.recipe.length; i++) {
      try {
        await applyRecipe(page, [opts.recipe[i]]);
      } catch (e) {
        error = { step: i, message: (e as Error).message.split("\n")[0] };
        break;
      }
    }
    // Let what the last step started finish: a fetch, a re-render, a transition.
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(config.discovery.interactions.settleMs);

    const after = await takeSnapshot(page).catch(() => before);
    const navigated = after.doc !== docBefore;
    const linesAfter = navigated ? [] : await readLines(page);
    const appeared = navigated ? [] : addedLines(linesBefore, linesAfter);
    const disappeared = navigated ? [] : addedLines(linesAfter, linesBefore);
    const storeAfter = await readStorage(page);
    const storage = {
      localStorage: changedKeys(storeBefore.local, storeAfter.local),
      sessionStorage: changedKeys(storeBefore.session, storeAfter.session),
      cookies: changedKeys(cookiesBefore, await readCookies(context)),
    };
    const first = opts.recipe.find((s) => s.action === "click" || s.action === "hover") as
      | { action: "click" | "hover"; target: Target }
      | undefined;
    const regionKind =
      navigated || !first
        ? null
        : classifyChange(
            before,
            after,
            { target: first.target, label: first.target.name ?? first.target.text ?? "" },
            first.action,
          );

    if (opts.shotPath) {
      await page.screenshot({ path: opts.shotPath, scale: "css" });
    }
    const origin = new URL(baseUrl).origin;
    const finalUrl = new URL(page.url());
    return {
      url,
      finalPath:
        finalUrl.origin === origin
          ? finalUrl.pathname + finalUrl.search + finalUrl.hash
          : finalUrl.href,
      status: resp?.status(),
      ok: !error && !login,
      ...(error ? { error } : {}),
      navigated,
      sentToLogin: login,
      opened: navigated ? [] : addedRegions(before, after),
      ...(navigated ? {} : { kind: guessKind(regionKind, appeared, opts.recipe) }),
      appeared,
      disappeared,
      storage,
      suggestIsolate: Object.values(storage).some((keys) => keys.length > 0),
      ...(opts.shotPath ? { shot: opts.shotPath } : {}),
      ...(opts.inventory ? { inventory: await readInventory(page, config) } : {}),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
