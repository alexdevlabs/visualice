import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { ConfigSchema } from "../../src/shared/config";
import { discoverPipeline } from "../../src/crawl/discover";
import type { RecipeStep } from "../../src/shared/types";
import { serveFiles, silent } from "./helpers";

/**
 * Discovery behaviours that need a real browser but no screenshots: robots.txt
 * enforcement and nested (nestDepth > 1) state discovery.
 */

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const LINKS = page(
  "Home",
  `<h1>Home</h1><a href="/public">public</a> <a href="/private">private</a>`,
);

const ROBOTS_SITE = {
  "index.html": LINKS,
  "public.html": page("Public", "<h1>Public</h1>"),
  "private.html": page("Private", "<h1>Private</h1>"),
  "robots.txt": "User-agent: *\nDisallow: /private\n",
};

const baseConfig = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    routesFile: false,
    scope: { maxPages: 10, maxDepth: 2 },
    politeness: { minDelayMs: 0 },
    stabilize: { waitStrategy: "domcontentloaded" },
    ...over,
  });

describe("robots.txt enforcement", () => {
  it("skips disallowed paths when politeness.respectRobots is on", async () => {
    const { server, dir } = await serveFiles(ROBOTS_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig(),
        baseUrl: server.url,
        log: silent,
      });
      const urls = m.routes.map((r) => r.url);
      expect(urls).toContain("/");
      expect(urls).toContain("/public");
      expect(urls).not.toContain("/private");
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("crawls the same path once respectRobots is off", async () => {
    const { server, dir } = await serveFiles(ROBOTS_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({ politeness: { minDelayMs: 0, respectRobots: false } }),
        baseUrl: server.url,
        log: silent,
      });
      expect(m.routes.map((r) => r.url)).toContain("/private");
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// A client-rendered feed: the shell is there at domcontentloaded, the links to the
// articles arrive with a fetch after it (the RealWorld/Conduit shape).
const FEED_SITE = {
  "index.html": page(
    "Feed",
    `<h1>Feed</h1><ul id="feed"></ul>
     <script>
       // A real API answers in tens to hundreds of ms; a local file server, at once.
       setTimeout(() => fetch('/feed.json').then((r) => r.json()).then((items) => {
         document.getElementById('feed').innerHTML =
           items.map((i) => '<li><a href="' + i.href + '">' + i.title + '</a></li>').join('');
       }), 300);
     </script>`,
  ),
  "feed.json": JSON.stringify([{ href: "/article", title: "An article" }]),
  "article.html": page("Article", "<h1>Article</h1>"),
};

describe("links rendered from fetched data", () => {
  it("follows links a page renders after its data arrives", async () => {
    const { server, dir } = await serveFiles(FEED_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({ stabilize: { waitStrategy: "networkidle" } }),
        baseUrl: server.url,
        log: silent,
      });
      expect(m.routes.map((r) => r.url)).toContain("/article");
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// A modal that itself contains a disclosure — the shape nestDepth > 1 exists for.
const NESTED_SITE = {
  "index.html": page(
    "Nested",
    `<h1>Nested</h1>
     <button id="open" aria-haspopup="dialog" aria-controls="search-modal">Search</button>
     <dialog id="search-modal">
       <details id="filters"><summary>Filters</summary><p>Roast, origin, price.</p></details>
       <button id="close">Close</button>
     </dialog>
     <script>
       document.getElementById('open').addEventListener('click', () =>
         document.getElementById('search-modal').showModal());
       document.getElementById('close').addEventListener('click', () =>
         document.getElementById('search-modal').close());
     </script>`,
  ),
};

const clicks = (recipe: RecipeStep[]) => recipe.filter((s) => s.action === "click").length;

describe("nested state discovery", () => {
  it("stops at single mutations with the default nestDepth", async () => {
    const { server, dir } = await serveFiles(NESTED_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig(),
        baseUrl: server.url,
        log: silent,
      });
      const states = m.routes[0].states;
      expect(states.map((s) => s.id)).toContain("modal-search");
      expect(states.every((s) => clicks(s.recipe) <= 1)).toBe(true);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("records a combined recipe for a state opened inside another state", async () => {
    const { server, dir } = await serveFiles(NESTED_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({ discovery: { interactions: { nestDepth: 2 } } }),
        baseUrl: server.url,
        log: silent,
      });
      const states = m.routes[0].states;
      const nested = states.filter((s) => clicks(s.recipe) === 2);
      expect(nested).toHaveLength(1);

      const [child] = nested;
      const parent = states.find((s) => s.id === "modal-search")!;
      expect(child.id.startsWith(parent.id)).toBe(true);
      expect(child.kind).toBe("accordion");
      expect(child.label).toContain("→");
      // the parent's recipe is the prefix of the child's
      expect(child.recipe.slice(0, parent.recipe.length)).toEqual(parent.recipe);
      expect(child.recipe.at(-1)).toMatchObject({ selector: '[id="filters"]' });
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not mistake the modal's own close button for a new state", async () => {
    const { server, dir } = await serveFiles(NESTED_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({ discovery: { interactions: { nestDepth: 2 } } }),
        baseUrl: server.url,
        log: silent,
      });
      expect(m.routes[0].states.map((s) => s.label.toLowerCase()).join(" ")).not.toContain("close");
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("captures only the default render with auto off", async () => {
    const { server, dir } = await serveFiles(NESTED_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({ discovery: { interactions: { auto: false } } }),
        baseUrl: server.url,
        log: silent,
      });
      expect(m.routes[0].states.map((s) => s.id)).toEqual(["default"]);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// A shop header: a Categories dropdown on every page, folded away on a phone.
const header = `<style>@media (max-width: 600px) { .desk { display: none } }</style>
  <nav class="desk"><button id="cats-btn" aria-expanded="false" aria-controls="cats">Categories</button>
  <ul id="cats" hidden><li>Hand Tools</li><li>Power Tools</li></ul></nav>
  <script>
    const b = document.getElementById("cats-btn");
    b.addEventListener("click", () => {
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      document.getElementById("cats").hidden = !open;
    });
  </script>`;

// A phone lays out a page without a viewport meta at 980px, media queries and all.
const responsive = (title: string, body: string) =>
  page(title, body).replace("<head>", '<head><meta name="viewport" content="width=device-width">');

const SHOP_SITE = {
  "index.html": responsive("Home", `${header}<h1>Home</h1><a href="/contact">contact</a>`),
  "contact.html": responsive("Contact", `${header}<h1>Contact</h1>`),
};

describe("page chrome", () => {
  it("keeps a state every page shares once, and off the devices that hide it", async () => {
    const { server, dir } = await serveFiles(SHOP_SITE);
    try {
      const config = baseConfig();
      const m = await discoverPipeline({ config, baseUrl: server.url, log: silent });
      const cats = (url: string) =>
        m.routes.find((r) => r.url === url)?.states.filter((s) => s.label === "Categories") ?? [];
      expect(cats("/")).toHaveLength(1);
      expect(cats("/contact")).toHaveLength(0);
      const desktop = config.devices.filter((d) => !d.mobile).map((d) => d.name);
      expect(cats("/")[0].devices).toEqual(desktop);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

const CATALOG_SITE = {
  "index.html": page(
    "Shop",
    `<h1>Shop</h1>${[1, 2, 3, 4, 5].map((i) => `<a href="/product/p${i}">P${i}</a>`).join(" ")}
     <a href="/about">about</a>`,
  ),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].map((i) => [`product/p${i}.html`, page(`P${i}`, `<h1>P${i}</h1>`)]),
  ),
  "about.html": page("About", "<h1>About</h1>"),
};

describe("template sampling", () => {
  it("keeps the first few pages of a sampled glob, plus any seeded by name", async () => {
    const { server, dir } = await serveFiles(CATALOG_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({
          scope: { maxPages: 10, maxDepth: 2, samples: { "/product/*": 2 } },
          seeds: ["/product/p5"],
          discovery: { interactions: { auto: false } },
        }),
        baseUrl: server.url,
        log: silent,
      });
      expect(m.routes.map((r) => r.url).sort()).toEqual([
        "/",
        "/about",
        "/product/p1",
        "/product/p2",
        "/product/p5",
      ]);
    } finally {
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
