import { describe, expect, it } from "vitest";
import {
  parseRoutesFile,
  renderRoutesFile,
  computeWanted,
  applyRoutesIntent,
  applyStateSkips,
  emptyRoutesIntent,
  unmappedRoutes,
} from "../src/crawl/routes-file";
import { ConfigSchema } from "../src/shared/config";
import type { InputManifest, StateNode } from "../src/shared/types";

const state = (id: string, extra: Partial<StateNode> = {}): StateNode => ({
  id,
  kind: "menu",
  label: id,
  recipe: [{ action: "click", target: { role: "button", name: "Open menu" } }],
  source: "auto",
  shots: {},
  ...extra,
});

const model = (): InputManifest => ({
  routes: [
    {
      id: "home",
      url: "/",
      title: "Acme · Home",
      depth: 0,
      states: [state("default", { kind: "default", recipe: [] }), state("menu-open")],
    },
    {
      id: "pricing",
      url: "/pricing",
      title: "Pricing",
      depth: 1,
      states: [
        state("default", { kind: "default", recipe: [] }),
        state("nav-hamburger", { devices: ["mobile"] }),
        state("newsletter-toast"),
      ],
    },
  ],
});

const FILE = `# Routes — https://staging.example.com

<!-- a legend comment that the parser must ignore -->

- / — Acme · Home
  - menu-open — click "Open menu"
  - [ ] search-open — the ⌘K search overlay
- /pricing — Pricing
  - nav-hamburger (mobile) — click "Open menu"
  - skip: newsletter-toast
- /app/reports — Reports
  - [ ] export-dialog — open Export, CSV options visible
- skip: /legal/**
`;

describe("parseRoutesFile", () => {
  it("extracts routes, states, wanted, skips and the target", () => {
    const intent = parseRoutesFile(FILE);
    expect(intent.target).toBe("https://staging.example.com");
    expect(intent.routes.map((r) => r.path)).toEqual(["/", "/pricing", "/app/reports"]);
    expect(intent.skipRoutes).toEqual(["/legal/**"]);
    const home = intent.routes[0];
    expect(home.label).toBe("Acme · Home");
    expect(home.states).toEqual([
      { id: "menu-open", description: 'click "Open menu"', wanted: undefined, skip: undefined },
      { id: "search-open", description: "the ⌘K search overlay", wanted: true, skip: undefined },
    ]);
    const pricing = intent.routes[1];
    expect(pricing.states.find((s) => s.id === "newsletter-toast")?.skip).toBe(true);
    // `(mobile)` marker between id and — is decoration, not part of the id
    expect(pricing.states[0].id).toBe("nav-hamburger");
  });

  it("tolerates junk lines and reports warnings for near-misses", () => {
    const intent = parseRoutesFile(
      [
        "random prose",
        "- not a path at all",
        "- /ok",
        "  - Weird!State — bad id",
        "  - fine-state",
        "- /ok — duplicate",
      ].join("\n"),
    );
    expect(intent.routes).toHaveLength(1);
    expect(intent.routes[0].states.map((s) => s.id)).toEqual(["fine-state"]);
    expect(intent.warnings).toHaveLength(3);
  });

  it("treats a checked box as realized, not wanted", () => {
    const intent = parseRoutesFile("- /\n  - [x] menu-open");
    expect(intent.routes[0].states[0].wanted).toBeUndefined();
  });

  it("ignores nested bullets with no route above them", () => {
    const intent = parseRoutesFile("  - orphan-state\n- /");
    expect(intent.routes[0].states).toEqual([]);
  });
});

describe("renderRoutesFile", () => {
  it("renders deterministically and round-trips idempotently", () => {
    const intent = parseRoutesFile(FILE);
    const first = renderRoutesFile(model(), intent, "https://staging.example.com");
    const second = renderRoutesFile(model(), parseRoutesFile(first), "https://staging.example.com");
    expect(second).toBe(first);
  });

  it("keeps wanted lines, skip tombstones and pending routes", () => {
    const out = renderRoutesFile(model(), parseRoutesFile(FILE), "https://staging.example.com");
    expect(out).toContain("- [ ] search-open — the ⌘K search overlay");
    expect(out).toContain("- skip: newsletter-toast");
    expect(out).toContain("- /app/reports");
    expect(out).toContain("- [ ] export-dialog — open Export, CSV options visible");
    expect(out).toContain("- skip: /legal/**");
    expect(out).not.toContain("- default"); // default state is implicit
  });

  it("flips a wanted line to realized once the cache has the state", () => {
    const m = model();
    m.routes[0].states.push(state("search-open", { source: "authored" }));
    const out = renderRoutesFile(m, parseRoutesFile(FILE), "https://staging.example.com");
    expect(out).not.toContain("[ ] search-open");
    expect(out).toContain("  - search-open (authored)");
  });

  it("marks device-restricted states and orders home first then by depth", () => {
    const out = renderRoutesFile(model(), emptyRoutesIntent(), "http://x");
    expect(out).toContain("  - nav-hamburger (mobile)");
    const routes = out.split("\n").filter((l) => l.startsWith("- "));
    expect(routes[0]).toMatch(/^- \/ /);
    expect(routes[1]).toMatch(/^- \/pricing/);
  });
});

describe("intent application", () => {
  it("computeWanted lists unmet requests, including on uncrawled routes", () => {
    const wanted = computeWanted(model(), parseRoutesFile(FILE));
    expect(wanted).toEqual([
      { route: "/", state: "search-open", description: "the ⌘K search overlay" },
      {
        route: "/app/reports",
        state: "export-dialog",
        description: "open Export, CSV options visible",
      },
    ]);
  });

  it("a plain line whose state vanished from the cache becomes wanted again", () => {
    const m = model();
    m.routes[0].states = m.routes[0].states.filter((s) => s.id !== "menu-open");
    const wanted = computeWanted(m, parseRoutesFile(FILE));
    expect(wanted.map((w) => w.state)).toContain("menu-open");
  });

  it("unmappedRoutes lists file pages the model has no route for, minus skips", () => {
    const intent = parseRoutesFile(FILE + "- /legal/privacy\n");
    expect(unmappedRoutes(model(), intent)).toEqual(["/app/reports"]);
  });

  it("applyRoutesIntent seeds file routes and excludes skip globs", () => {
    const config = ConfigSchema.parse({ seeds: ["/pricing"] });
    const out = applyRoutesIntent(config, parseRoutesFile(FILE));
    expect(out.seeds).toEqual(["/pricing", "/", "/app/reports"]);
    expect(out.scope.exclude).toContain("/legal/**");
    expect(config.seeds).toEqual(["/pricing"]); // non-mutating
  });

  it("applyStateSkips drops skipped states and skipped routes from capture input", () => {
    const m = model();
    m.routes.push({ id: "legal", url: "/legal/terms", depth: 1, states: [] });
    const out = applyStateSkips(m, parseRoutesFile(FILE));
    expect(out.routes.map((r) => r.url)).toEqual(["/", "/pricing"]);
    expect(out.routes[1].states.map((s) => s.id)).toEqual(["default", "nav-hamburger"]);
    expect(m.routes[1].states).toHaveLength(3); // input untouched
  });
});
