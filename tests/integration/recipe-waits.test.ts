import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { applyRecipe } from "../../src/crawl/recipe";
import { useUnstableIds } from "../../src/crawl/generated-ids";
import { launchOptions } from "../../src/shared/launch";
import type { RecipeStep } from "../../src/shared/types";

/**
 * A recipe step that waits for an element by id, right after the click that opens
 * it: what discovery records for nearly every state. The id may have changed since
 * (a counter, React's useId), so the step also accepts "the click opened
 * something" — but only once the id has had its chance, and never for a click that
 * opened nothing.
 */

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch(launchOptions());
  useUnstableIds([]);
});

afterAll(async () => {
  await browser?.close();
});

const load = async (body: string) => {
  page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  return page;
};

const clickThenWait = (name: string, selector: string, timeoutMs?: number): RecipeStep[] => [
  { action: "click", target: { role: "button", name } },
  { action: "waitFor", selector, state: "visible", ...(timeoutMs ? { timeoutMs } : {}) },
];

describe("waiting for what a click opened, by id", () => {
  it("waits for a stable id's content, though the trigger flips at once", async () => {
    // The button says it's expanded straight away; the menu arrives later.
    const p = await load(`
      <button aria-controls="user-menu" aria-expanded="false" onclick="
        this.setAttribute('aria-expanded', 'true');
        setTimeout(() => {
          const m = document.createElement('ul');
          m.id = 'user-menu'; m.setAttribute('role', 'menu'); m.innerHTML = '<li>Profile</li>';
          document.body.append(m);
        }, 1200);">Account</button>`);
    await applyRecipe(p, clickThenWait("Account", "#user-menu"));
    expect(await p.locator("#user-menu").isVisible()).toBe(true);
    await p.close();
  });

  it("settles for the dialog the click opened when its id has changed", async () => {
    // Recorded as dlg-7; this load numbers it dlg-31.
    const p = await load(`
      <button onclick="
        const d = document.createElement('div');
        d.setAttribute('role', 'dialog'); d.id = 'dlg-31'; d.textContent = 'Preferences';
        document.body.append(d);">Preferences</button>`);
    await applyRecipe(p, clickThenWait("Preferences", '[id="dlg-7"]'));
    expect(await p.locator('[role="dialog"]').isVisible()).toBe(true);
    await p.close();
  });

  it("carries on when a generated id's panel replaced another, without counting up", async () => {
    // A single-open accordion: B opening closes A, so nothing *more* is open.
    const p = await load(`
      <button aria-expanded="true" onclick="">A</button>
      <div id="a" data-state="open">Panel A</div>
      <button aria-expanded="false" onclick="
        document.getElementById('a').removeAttribute('data-state');
        document.getElementById('a').hidden = true;
        const b = document.createElement('div');
        b.id = 'radix-:r9:'; b.setAttribute('data-state', 'open'); b.textContent = 'Panel B';
        document.body.append(b);">B</button>`);
    const started = Date.now();
    await applyRecipe(p, clickThenWait("B", "#radix-\\:r3\\:"));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await p.getByText("Panel B").isVisible()).toBe(true);
    await p.close();
  });

  it("still fails when the click opened nothing and the id never came", async () => {
    const p = await load(`<button onclick="">Nothing</button>`);
    await expect(applyRecipe(p, clickThenWait("Nothing", "#missing-1", 1500))).rejects.toThrow(
      /Timeout/,
    );
    await p.close();
  });
});
