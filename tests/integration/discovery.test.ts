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

  it("captures only the default render at nestDepth 0", async () => {
    const { server, dir } = await serveFiles(NESTED_SITE);
    try {
      const m = await discoverPipeline({
        config: baseConfig({ discovery: { interactions: { nestDepth: 0 } } }),
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
