import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { chromium } from "playwright";
import { discoverFormStates } from "../../src/crawl/discover-forms";
import { applyRecipe } from "../../src/crawl/recipe";
import { serveFiles } from "./helpers";

/**
 * The two form states the DOM-diffing prober can't see, end to end in a browser:
 * a focus ring (pure CSS — nothing is added or removed) and a validation error
 * (only appears once a field has been touched). The recipes recorded here have to
 * reproduce the state at capture time, so each test replays the recipe on a fresh
 * page rather than trusting the probe's own leftover DOM.
 */

const page = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Form</title>${head}</head>
<body>${body}</body></html>`;

/** Validates on blur, the way form libraries do — no submit involved. */
const BLUR_VALIDATED = page(
  `<form>
     <label>Email <input id="email" name="email" required aria-invalid="false"></label>
     <label>Name <input id="name" name="name" required aria-invalid="false"></label>
     <button type="submit">Send</button>
   </form>
   <script>
     for (const el of document.querySelectorAll('input[required]')) {
       el.addEventListener('blur', () => {
         const bad = !el.value.trim();
         el.setAttribute('aria-invalid', String(bad));
         let err = el.parentElement.querySelector('.err');
         if (bad && !err) {
           err = document.createElement('span');
           err.className = 'err';
           err.setAttribute('role', 'alert');
           err.textContent = 'Required';
           el.parentElement.appendChild(err);
         }
       });
     }
   </script>`,
  `<style>input:focus { outline: 3px solid #05f; }</style>`,
);

/** Same markup, but nothing styles focus and nothing validates. */
const INERT = page(
  `<form>
     <label>Email <input id="email" name="email"></label>
     <label>Name <input id="name" name="name"></label>
   </form>`,
  `<style>input:focus { outline: none; }</style>`,
);

/** A single-field newsletter box — on every page of a real site. */
const NEWSLETTER = page(
  `<form><input id="news" name="news" required><button>Join</button></form>`,
  `<style>input:focus { outline: 3px solid #05f; }</style>`,
);

async function withPage<T>(
  html: string,
  fn: (p: import("playwright").Page, url: string) => Promise<T>,
): Promise<T> {
  const { server, dir } = await serveFiles({ "index.html": html });
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await p.goto(server.url, { waitUntil: "load" });
    return await fn(p, server.url);
  } finally {
    await browser.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("form state discovery", () => {
  it("records focus and validation states, with recipes that reproduce them", async () => {
    await withPage(BLUR_VALIDATED, async (p, url) => {
      const { states } = await discoverFormStates(p, 4000);
      expect(states.map((s) => s.id)).toEqual(["focus-form", "validation-form"]);
      expect(states.map((s) => s.kind)).toEqual(["focus", "validation"]);

      // Replay each recipe on a clean page and check the state actually appears.
      for (const state of states) {
        await p.goto(url, { waitUntil: "load" });
        await applyRecipe(p, state.recipe);
        if (state.kind === "focus") {
          expect(await p.evaluate(() => document.activeElement?.id)).toBe("email");
        } else {
          expect(await p.locator('[role="alert"]').count()).toBeGreaterThan(0);
          expect(await p.locator('[aria-invalid="true"]').count()).toBe(2);
          // …and nothing was submitted: still on the same page.
          expect(p.url()).toBe(url + "/");
        }
      }
    });
  }, 60_000);

  it("records nothing when focusing and touching change nothing", async () => {
    await withPage(INERT, async (p) => {
      const { states, note } = await discoverFormStates(p, 4000);
      expect(states).toEqual([]);
      expect(note).toContain("neither focus nor touching");
    });
  }, 60_000);

  it("ignores a one-field signup box, which every page of a site carries", async () => {
    await withPage(NEWSLETTER, async (p) => {
      const { states, note } = await discoverFormStates(p, 4000);
      expect(states).toEqual([]);
      expect(note).toContain("at least two visible fields");
    });
  }, 60_000);
});
