import type { Page } from "playwright";
import type { RecipeStep } from "../shared/types";
import { locatorFor } from "../shared/selectors";

export function resolveUrl(base: string, u: string): string {
  return /^https?:\/\//i.test(u) ? u : new URL(u, base).href;
}

/** Replay an ordered list of interaction steps on a page. */
export async function applyRecipe(page: Page, steps: RecipeStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.action) {
      case "navigate":
        await page.goto(new URL(step.url, page.url()).href);
        break;
      case "click":
        await locatorFor(page, step.target).click();
        break;
      case "hover":
        await locatorFor(page, step.target).hover();
        break;
      case "focus":
        await locatorFor(page, step.target).focus();
        break;
      case "blur":
        // Blur whatever is focused without moving focus somewhere that could open
        // its own state — a Tab press would land on the next control and focus that.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        break;
      case "fill":
        await locatorFor(page, step.target).fill(step.value);
        break;
      case "press":
        if (step.target) await locatorFor(page, step.target).press(step.key);
        else await page.keyboard.press(step.key);
        break;
      case "waitFor":
        if (step.selector)
          await page
            .locator(step.selector)
            .first()
            .waitFor({ state: step.state ?? "visible", timeout: step.timeoutMs });
        else if (step.url) await page.waitForURL(step.url, { timeout: step.timeoutMs });
        else if (step.timeoutMs) await page.waitForTimeout(step.timeoutMs);
        break;
      case "scroll":
        if (step.to === "top") await page.evaluate(() => window.scrollTo(0, 0));
        else if (step.to === "bottom")
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        else await page.evaluate((y) => window.scrollTo(0, y), step.to);
        break;
      case "wait":
        await page.waitForTimeout(step.ms);
        break;
    }
  }
}
