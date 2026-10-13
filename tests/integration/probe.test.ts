import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../../src/shared/config";
import { probePage, type PageInventory, type ProbeOutcome } from "../../src/crawl/probe";
import { serveFiles, tempDir } from "./helpers";

/** A shop page in miniature: a sort control, a form with a submit, a cart, a dialog. */
const SHOP = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
  <h1>Products</h1>
  <a href="/item?id=1">Backpack</a> <a href="https://elsewhere.test/">Away</a>
  <select data-test="sort"><option value="az">A–Z</option><option value="lohi">Price</option></select>
  <button data-test="add">Add to cart</button><div id="badge"></div>
  <button id="open" aria-haspopup="dialog">Help</button>
  <dialog id="help"><p>Help text</p></dialog>
  <form id="login" novalidate onsubmit="event.preventDefault();document.getElementById('err').textContent='Error: Username is required'">
    <input data-test="user" aria-label="Username" required><input data-test="pass" type="password" aria-label="Password">
    <button data-test="go">Login</button><p id="err"></p>
  </form>
  <script>
    document.querySelector('[data-test=add]').onclick = () => {
      localStorage.setItem('cart', '1'); document.getElementById('badge').textContent = '1';
    };
    document.getElementById('open').onclick = () => document.getElementById('help').showModal();
  </script>
</body></html>`;

const config = (dir: string) =>
  ConfigSchema.parse({
    routesFile: false,
    output: { dir },
    testIdAttribute: "data-test",
    devices: [{ name: "small", width: 800, height: 600, dpr: 1 }],
    stabilize: { waitStrategy: "load" },
  });

describe("probePage", () => {
  const withSite = async (fn: (base: string, out: string) => Promise<void>) => {
    const { server, dir } = await serveFiles({ "index.html": SHOP });
    const out = await tempDir("probe");
    try {
      await fn(server.url, out);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  };

  it("inventories triggers, forms with their submit, loose controls and links", async () => {
    await withSite(async (base, out) => {
      const { inventory } = (await probePage({ config: config(out), baseUrl: base, url: "/" })) as {
        inventory: PageInventory;
      };
      expect(inventory.title).toBe("Shop");
      expect(inventory.headings).toEqual(["Products"]);
      expect(inventory.links).toEqual([{ path: "/item?id=1", text: "Backpack" }]);
      expect(inventory.triggers.map((t) => t.label)).toEqual(
        expect.arrayContaining(["Add to cart", "Help"]),
      );
      expect(inventory.controls).toEqual([
        expect.objectContaining({
          target: { testId: "sort" },
          type: "select",
          options: [
            { value: "az", label: "A–Z" },
            { value: "lohi", label: "Price" },
          ],
        }),
      ]);
      expect(inventory.forms).toHaveLength(1);
      expect(inventory.forms[0].submit).toEqual({ target: { testId: "go" }, label: "Login" });
      expect(inventory.forms[0].fields.map((f) => [f.label, f.required])).toEqual([
        ["Username", true],
        ["Password", false],
      ]);
    });
  }, 60_000);

  it("reports what a recipe opened, wrote and showed", async () => {
    await withSite(async (base, out) => {
      const probe = (recipe: unknown[]) =>
        probePage({
          config: config(out),
          baseUrl: base,
          url: "/",
          recipe: recipe as never,
        }) as Promise<ProbeOutcome>;

      const dialog = await probe([{ action: "click", target: { selector: "#open" } }]);
      expect(dialog.ok).toBe(true);
      expect(dialog.kind).toBe("modal");
      expect(dialog.opened).toEqual(["m:help"]);
      expect(dialog.suggestIsolate).toBe(false);

      const cart = await probe([{ action: "click", target: { testId: "add" } }]);
      expect(cart.appeared).toContain("1");
      expect(cart.storage.localStorage).toEqual(["cart"]);
      expect(cart.suggestIsolate).toBe(true);

      const error = await probe([{ action: "click", target: { testId: "go" } }]);
      expect(error.kind).toBe("validation");
      expect(error.appeared).toEqual(["Error: Username is required"]);
      expect(error.navigated).toBe(false);

      const broken = await probe([
        { action: "click", target: { testId: "add" } },
        { action: "click", target: { testId: "missing" } },
      ]);
      expect(broken.ok).toBe(false);
      expect(broken.error?.step).toBe(1);
    });
  }, 120_000);
});
