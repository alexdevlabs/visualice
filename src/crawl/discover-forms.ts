import type { Page } from "playwright";
import type { RecipeStep, StateNode, Target } from "../shared/types";
import { describeTarget, locatorFor } from "../shared/selectors";

/**
 * Form states: focus rings and validation errors.
 *
 * The click/hover prober finds states by diffing the DOM, which never sees either
 * of these. A focus ring is pure CSS — nothing is added or removed — and a
 * validation error only appears once a field has been *touched*, which no click on
 * a trigger will do. Both are states a UI catalog is expected to contain, and both
 * are otherwise invisible to it.
 *
 * Neither probe ever submits a form. Discovery's contract is that it performs no
 * non-idempotent action, and "click submit and see what happens" is exactly that.
 * The validation state comes from focusing and blurring required fields — the
 * "touched and left empty" path every form library hangs its errors off — and
 * nothing else.
 */

/** The visual properties a focus ring is drawn with. */
export interface FocusStyle {
  outline: string;
  outlineOffset: string;
  boxShadow: string;
  borderColor: string;
  backgroundColor: string;
}

/**
 * True when focusing visibly changed the control. Without this check every page
 * with an input would gain a "focused" state, most of them pixel-identical to the
 * default render — a catalog is worth less for every shot in it that shows nothing.
 */
export function focusRingChanged(before: FocusStyle, after: FocusStyle): boolean {
  return (Object.keys(before) as (keyof FocusStyle)[]).some((k) => before[k] !== after[k]);
}

/** Signals that a form is showing errors. Counted before and after touching it. */
export interface ValidationSignals {
  invalid: number;
  alerts: number;
  describedBy: number;
}

/** True when touching the fields surfaced something that wasn't there before. */
export function validationAppeared(before: ValidationSignals, after: ValidationSignals): boolean {
  return (
    after.invalid > before.invalid ||
    after.alerts > before.alerts ||
    after.describedBy > before.describedBy
  );
}

const FIELD_SELECTOR =
  "form input:not([type=hidden]):not([type=submit]):not([type=button]), form select, form textarea";

/**
 * Below this many visible fields a `<form>` is treated as an inline control (a
 * newsletter box, a one-field search) rather than a form worth its own states.
 */
const MIN_FORM_FIELDS = 2;

/** Ids safe to drop straight into a CSS selector, with no escaping rules to get wrong. */
const SIMPLE_ID = /^[A-Za-z][\w-]*$/;

export interface FieldInfo {
  id?: string;
  name?: string;
  index: number;
}

/** A target for one field, preferring the most stable handle it carries. */
export function targetFor(info: FieldInfo): Target {
  if (info.id && SIMPLE_ID.test(info.id)) return { selector: `#${info.id}` };
  if (info.name) return { selector: `form [name="${info.name}"]` };
  // Positional fallback: the field has no stable handle of its own.
  return { selector: FIELD_SELECTOR, nth: info.index };
}

/** The focus/blur pairs that reproduce "every required field has been touched". */
export function touchRecipe(fields: FieldInfo[]): RecipeStep[] {
  const steps: RecipeStep[] = [];
  for (const field of fields) {
    steps.push({ action: "focus", target: targetFor(field) });
    steps.push({ action: "blur" });
  }
  // Error messages are usually rendered a tick later, sometimes with a transition.
  steps.push({ action: "wait", ms: 300 });
  return steps;
}

export interface FormProbeResult {
  states: StateNode[];
  /** Why nothing was recorded, for the log. */
  note?: string;
}

interface FormScan {
  first: FieldInfo;
  required: FieldInfo[];
}


/**
 * Visible fields of the page's forms, and which of them are required.
 *
 * Written without named inner functions on purpose: esbuild's `keepNames` wraps
 * those in a `__name()` helper that doesn't exist inside the browser, so a
 * refactor into tidy little helpers here throws a ReferenceError in the page and
 * silently reports "no fields".
 */
async function scanFields(page: Page): Promise<FormScan | null> {
  return page
    .evaluate(
      ({ fieldSelector, minFields }) => {
        // Group by owning form: the first field and the required fields have to
        // belong to the same one, or the recipe touches two unrelated forms.
        const byForm = new Map<
          Element,
          { id?: string; name?: string; index: number; required: boolean }[]
        >();
        const all = Array.from(document.querySelectorAll(fieldSelector));
        for (let index = 0; index < all.length; index++) {
          const el = all[index] as HTMLInputElement;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const form = el.form ?? el.closest("form");
          if (!form) continue;
          const entry = {
            id: el.id || undefined,
            name: el.name || undefined,
            index,
            required: el.required || el.getAttribute("aria-required") === "true",
          };
          const fields = byForm.get(form);
          if (fields) fields.push(entry);
          else byForm.set(form, [entry]);
        }

        // The first form substantial enough to be worth a state. A single-input
        // signup box in a footer is on every page of a site; capturing its focus
        // ring ten times is noise, not a catalog.
        for (const fields of byForm.values()) {
          if (fields.length < minFields) continue;
          const required = [];
          for (const f of fields) {
            // A handful is plenty: touching thirty fields to show the same error
            // styling costs time and tells you nothing extra.
            if (f.required && required.length < 8) required.push(f);
          }
          return { first: fields[0], required };
        }
        return null;
      },
      { fieldSelector: FIELD_SELECTOR, minFields: MIN_FORM_FIELDS },
    )
    .catch(() => null);
}

const readFocusStyle = (page: Page, target: Target): Promise<FocusStyle | null> =>
  locatorFor(page, target)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el as HTMLElement);
      return {
        outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
        outlineOffset: s.outlineOffset,
        boxShadow: s.boxShadow,
        borderColor: s.borderColor,
        backgroundColor: s.backgroundColor,
      };
    })
    .catch(() => null);

const readSignals = (page: Page): Promise<ValidationSignals> =>
  page
    .evaluate(() => ({
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      alerts: document.querySelectorAll('[role="alert"]').length,
      describedBy: document.querySelectorAll("form [aria-describedby]").length,
    }))
    .catch(() => ({ invalid: 0, alerts: 0, describedBy: 0 }));

/**
 * Probe the page's form fields for a focused state and a validation state. At most
 * one of each per route: a page with five forms would otherwise multiply the
 * catalog for very little extra information.
 *
 * The page is left dirty — focused and possibly showing errors — so callers must
 * re-navigate before probing anything else.
 */
export async function discoverFormStates(page: Page, timeoutMs: number): Promise<FormProbeResult> {
  const scan = await scanFields(page);
  if (!scan) return { states: [], note: "no form with at least two visible fields" };

  const states: StateNode[] = [];
  const target = targetFor(scan.first);

  const beforeStyle = await readFocusStyle(page, target);
  if (beforeStyle) {
    await locatorFor(page, target)
      .first()
      .focus({ timeout: timeoutMs })
      .catch(() => {});
    const afterStyle = await readFocusStyle(page, target);
    if (afterStyle && focusRingChanged(beforeStyle, afterStyle)) {
      states.push({
        id: "focus-form",
        kind: "focus",
        label: "Form field focused",
        trigger: target,
        recipe: [{ action: "focus", target }],
        // A signature keyed on the field is what stops the mobile discovery pass
        // from re-adding the same state under a deduplicated id; a form that only
        // exists on mobile targets a different field and still comes through.
        signature: `focus:${describeTarget(target)}`,
        source: "auto",
        shots: {},
      });
    }
  }

  if (scan.required.length) {
    const before = await readSignals(page);
    const recipe = touchRecipe(scan.required);
    // Replay the exact recipe that will be stored: if these steps don't produce the
    // errors, the state wouldn't reproduce at capture time either.
    for (const step of recipe) {
      if (step.action === "focus") {
        await locatorFor(page, step.target)
          .first()
          .focus({ timeout: timeoutMs })
          .catch(() => {});
      } else if (step.action === "blur") {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      } else if (step.action === "wait") {
        await page.waitForTimeout(step.ms);
      }
    }

    if (validationAppeared(before, await readSignals(page))) {
      states.push({
        id: "validation-form",
        kind: "validation",
        label: "Form validation errors",
        recipe,
        signature: `validation:${scan.required.map((f) => describeTarget(targetFor(f))).join("|")}`,
        source: "auto",
        shots: {},
      });
    }
  }

  return {
    states,
    note: states.length
      ? undefined
      : "form found, but neither focus nor touching required fields changed anything",
  };
}
