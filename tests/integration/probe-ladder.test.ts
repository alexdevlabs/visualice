import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../../src/shared/config";
import { discoverPipeline } from "../../src/crawl/discover";
import type { RecipeStep, StateNode } from "../../src/shared/types";
import { serveFiles } from "./helpers";

/**
 * State discovery walks a ladder: probe a trigger, put the page back, probe the
 * next. Putting it back cheaply — by recognising that the page is already where it
 * should be — is what makes discovery fast, and recognising it *wrongly* is what
 * makes it record states that don't exist. Each site here is the smallest page
 * that separates the two.
 */

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>[role=dialog]{position:fixed;top:40px;left:40px;width:240px;height:120px;background:#fff;border:1px solid}</style>
  </head><body>${body}</body></html>`;

const config = (interactions: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    ...extra,
    routesFile: false,
    scope: { maxPages: 1 },
    politeness: { minDelayMs: 0 },
    stabilize: { waitStrategy: "load" },
    discovery: { mobileStates: false, interactions: { formStates: false, ...interactions } },
  });

async function discover(
  files: Record<string, string>,
  interactions?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Promise<{ states: StateNode[]; logs: string[] }> {
  const { server, dir } = await serveFiles(files);
  const logs: string[] = [];
  try {
    const m = await discoverPipeline({
      config: config(interactions, extra),
      baseUrl: server.url,
      log: (msg) => logs.push(msg),
    });
    return { states: m.routes.find((r) => r.url === "/")!.states, logs };
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const waitSelectors = (recipe: RecipeStep[]) =>
  recipe.flatMap((s) => (s.action === "waitFor" && s.selector ? [s.selector] : []));

/** A dialog toggled by a button, closed by Escape — the same script on both pages. */
const helpScript = (dialogId: string) => `<script>
  const d = document.getElementById("${dialogId}");
  document.getElementById("help-btn").addEventListener("click", () => { d.hidden = false; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") d.hidden = true; });
</script>`;

describe("the probe ladder", () => {
  it("notices when a probe navigated away, instead of probing the next page", async () => {
    // A <button> with no `type` inside a <form> is a submit button. Probing it leaves
    // the route; the destination has no open regions either, so a check that only
    // looks at open regions takes it for the route and probes on from there.
    const { states } = await discover({
      "index.html": page(
        "Origin",
        `<h1>Origin</h1>
         <form action="/dest.html"><button>Go</button></form>
         <button id="help-btn" aria-haspopup="dialog">Help</button>
         <div id="help" role="dialog" hidden>Origin help</div>
         ${helpScript("help")}`,
      ),
      "dest.html": page(
        "Destination",
        `<h1>Destination</h1>
         <button id="help-btn" aria-haspopup="dialog">Help</button>
         <div id="dest-help" role="dialog" hidden>Destination help</div>
         ${helpScript("dest-help")}`,
      ),
    });
    const help = states.find((s) => s.kind === "modal");
    expect(help, "the route's own dialog is found").toBeDefined();
    // Recorded against the route, so replaying it from the route reproduces it.
    expect(waitSelectors(help!.recipe)).toEqual(['[id="help"]']);
    expect(help!.signature).toBe("m:help");
    expect(states.some((s) => JSON.stringify(s).includes("dest-help"))).toBe(false);
  }, 60_000);

  it("recognises the route's baseline even when it has open regions of its own", async () => {
    // A hidden mobile-menu trigger left at aria-expanded="true" is a permanent open
    // region. Demanding zero open regions made the baseline unrecognisable, so every
    // probe paid for a reload.
    const { logs } = await discover({
      "index.html": page(
        "Baseline",
        `<button style="display:none" aria-expanded="true" aria-controls="mnav">Menu</button>
         <nav id="mnav" style="display:none">nav</nav>
         <button id="a">Alpha</button><button id="b">Beta</button><button id="c">Gamma</button>`,
      ),
    });
    const line = logs.find((l) => /reload\(s\), \d+ reuse\(s\)/.test(l));
    expect(line, logs.join("\n")).toBeDefined();
    const [, reloads, reuses] = /(\d+) reload\(s\), (\d+) reuse\(s\)/.exec(line!)!;
    expect(Number(reloads)).toBe(0); // three probes that changed nothing need no reload
    expect(Number(reuses)).toBeGreaterThan(0);
  }, 60_000);

  it("tells apart two unnamed dialogs mounted at the same place in turn", async () => {
    // The portal pattern: an overlay is created under <body> on open and removed on
    // close, so the second one occupies exactly the DOM position the first did.
    const { states } = await discover({
      "index.html": page(
        "Portals",
        `<button id="one">Share</button><button id="two">Report</button>
         <script>
           const open = (text) => {
             const d = document.createElement("div");
             d.setAttribute("role", "dialog");
             d.textContent = text;
             document.body.appendChild(d);
           };
           document.getElementById("one").addEventListener("click", () => open("Share this page"));
           document.getElementById("two").addEventListener("click", () => open("Report a problem"));
           document.addEventListener("keydown", (e) => {
             if (e.key === "Escape") document.querySelectorAll("[role=dialog]").forEach((d) => d.remove());
           });
         </script>`,
      ),
    });
    const modals = states.filter((s) => s.kind === "modal");
    expect(modals.map((s) => s.label).sort()).toEqual(["Report", "Share"]);
  }, 60_000);

  it("waits for one real element when aria-controls lists several", async () => {
    // ARIA allows a space-separated id list; `[id="a b"]` matches nothing, so the
    // state could never be captured and nothing could be discovered inside it.
    const { states } = await discover(
      {
        "index.html": page(
          "Controls",
          `<button id="t" aria-expanded="false" aria-controls="panel-a panel-b">Details</button>
           <div id="panel-a" hidden><button id="more" aria-haspopup="dialog">More</button></div>
           <div id="panel-b" hidden>Second panel</div>
           <div id="more-dialog" role="dialog" hidden>More detail</div>
           <script>
             const t = document.getElementById("t");
             t.addEventListener("click", () => {
               const open = t.getAttribute("aria-expanded") !== "true";
               t.setAttribute("aria-expanded", String(open));
               for (const id of ["panel-a", "panel-b"]) document.getElementById(id).hidden = !open;
             });
             document.getElementById("more").addEventListener("click", () => {
               document.getElementById("more-dialog").hidden = false;
             });
           </script>`,
        ),
      },
      { nestDepth: 2 },
    );
    const details = states.find((s) => s.label === "Details");
    expect(details, states.map((s) => s.id).join(", ")).toBeDefined();
    expect(waitSelectors(details!.recipe)).toEqual(['[id="panel-a"]']);
    // …and the panel it opened is a real scope, so the dialog inside it is found.
    const nested = states.find((s) => s.label.startsWith("Details →"));
    expect(nested, states.map((s) => s.id).join(", ")).toBeDefined();
    expect(nested!.recipe.slice(0, details!.recipe.length)).toEqual(details!.recipe);
  }, 60_000);

  it("doesn't wait for a panel aria-controls names but the page doesn't have", async () => {
    // The Toolshop's mobile Filters button: aria-controls="collapseExample", and no
    // element with that id. Waiting for it fails every capture of the state.
    const { states } = await discover({
      "index.html": page(
        "Dangling",
        `<button id="t" aria-expanded="false" aria-controls="collapseExample">Filters</button>
         <div id="filters" hidden>Sort by price</div>
         <script>
           const t = document.getElementById("t");
           t.addEventListener("click", () => {
             const open = t.getAttribute("aria-expanded") !== "true";
             t.setAttribute("aria-expanded", String(open));
             document.getElementById("filters").hidden = !open;
           });
         </script>`,
      ),
    });
    const filters = states.find((s) => s.label === "Filters");
    expect(filters, states.map((s) => s.id).join(", ")).toBeDefined();
    expect(waitSelectors(filters!.recipe)).toEqual([]);
  }, 60_000);

  it("isolates a state whose trigger writes to storage, and undoes the write", async () => {
    // The Toolshop's Testing Guide remembers it was opened: left in storage, every
    // later page loads with it open and its trigger renamed.
    const { states } = await discover({
      "index.html": page(
        "Stored",
        `<button id="g" aria-expanded="false" aria-controls="guide">Guide</button>
         <div id="guide" hidden>How to test</div>
         <button id="h" aria-expanded="false" aria-controls="help">Help</button>
         <div id="help" hidden>Ask us</div>
         <script>
           const toggle = (btn, panel, remember) => {
             const b = document.getElementById(btn);
             b.addEventListener("click", () => {
               const open = b.getAttribute("aria-expanded") !== "true";
               b.setAttribute("aria-expanded", String(open));
               document.getElementById(panel).hidden = !open;
               if (remember) localStorage.setItem("guide-open", String(open));
             });
           };
           toggle("g", "guide", true);
           toggle("h", "help", false);
           if (localStorage.getItem("guide-open") === "true") document.body.dataset.leaked = "yes";
         </script>`,
      ),
    });
    const guide = states.find((s) => s.label === "Guide");
    const help = states.find((s) => s.label === "Help");
    expect(guide?.isolate).toBe(true);
    expect(help, states.map((s) => s.id).join(", ")).toBeDefined();
    expect(help!.isolate).toBeUndefined();
  }, 60_000);

  it("finds an off-canvas drawer that slides in, under the site's own test-id attribute", async () => {
    // react-burger-menu's shape: a fixed panel parked off-screen by a transform, no
    // dialog role, no aria-expanded — opening it only moves it into view. The site
    // marks its controls with data-test, not data-testid.
    const { states } = await discover(
      {
        "index.html": page(
          "Drawer",
          `<style>#wrap{position:fixed;top:0;left:0;width:240px;height:100%;background:#eee;transform:translateX(-240px)}
                  #wrap.open{transform:none}</style>
           <button data-test="open-menu">Open Menu</button>
           <div id="wrap" aria-hidden="true"><nav><a href="#">All Items</a><a href="#">About</a></nav></div>
           <script>
             const w = document.getElementById("wrap");
             document.querySelector("[data-test=open-menu]").addEventListener("click", () => {
               w.classList.add("open"); w.setAttribute("aria-hidden", "false");
             });
             document.addEventListener("keydown", (e) => {
               if (e.key === "Escape") { w.classList.remove("open"); w.setAttribute("aria-hidden", "true"); }
             });
           </script>`,
        ),
      },
      {},
      { testIdAttribute: "data-test" },
    );
    const menu = states.find((s) => s.kind === "menu");
    expect(menu, JSON.stringify(states)).toBeDefined();
    expect(menu!.trigger).toEqual({ testId: "open-menu" });
    expect(menu!.signature).toBe("f:wrap");
    // No dialog opened, so the recipe doesn't wait for one (it would never appear).
    expect(waitSelectors(menu!.recipe)).toEqual([]);
  }, 60_000);
});
