import { selectors, type Page, type Locator } from "playwright";
import type { Target } from "./types";

let testIdAttr = "data-testid";

/**
 * The attribute a `testId` target reads — `data-testid` unless the site uses another
 * (`data-test`, `data-cy`, `data-qa`). Playwright keeps it per process, as do we:
 * one run, one site, one attribute.
 */
export function useTestIdAttribute(name: string): void {
  if (name === testIdAttr) return;
  testIdAttr = name;
  selectors.setTestIdAttribute(name);
}

export const testIdAttribute = (): string => testIdAttr;

/**
 * Resolve a Target to a Playwright Locator, preferring robust strategies
 * (test id > role+name > label > text > raw CSS).
 */
export function locatorFor(page: Page, t: Target): Locator {
  let loc: Locator;
  if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.role && t.name)
    loc = page.getByRole(t.role as Parameters<Page["getByRole"]>[0], {
      name: t.name,
      exact: t.exact,
    });
  else if (t.role) loc = page.getByRole(t.role as Parameters<Page["getByRole"]>[0]);
  else if (t.label) loc = page.getByLabel(t.label, { exact: t.exact });
  else if (t.text) loc = page.getByText(t.text, { exact: t.exact });
  else if (t.selector) loc = page.locator(t.selector);
  else throw new Error(`Empty target: ${JSON.stringify(t)}`);
  if (typeof t.nth === "number") loc = loc.nth(t.nth);
  return loc;
}

export function describeTarget(t: Target): string {
  if (t.testId) return `testid=${t.testId}`;
  if (t.role && t.name) return `${t.role}:"${t.name}"`;
  if (t.role) return `role=${t.role}`;
  if (t.label) return `label="${t.label}"`;
  if (t.text) return `text="${t.text}"`;
  if (t.selector) return t.selector;
  return "?";
}

/**
 * What a "wait until visible" step waits on: the first match that is visible, not
 * the first match. A page that keeps a hidden tab panel or a closed drawer mounted
 * has matches that never show, and if one comes first in the document the step
 * would wait on it until it timed out, while the one it meant was on screen.
 */
export function visibleMatch(page: Pick<Page, "locator">, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first();
}
