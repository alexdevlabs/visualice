import { describe, expect, it } from "vitest";
import { AuthoredFileSchema, mergeAuthored } from "../src/crawl/author";
import type { InputManifest } from "../src/shared/types";

const model = (): InputManifest => ({
  routes: [
    {
      id: "cart",
      url: "/cart",
      depth: 0,
      states: [
        { id: "default", kind: "default", label: "Default", recipe: [], shots: {} },
        {
          id: "menu",
          kind: "menu",
          label: "Menu",
          recipe: [{ action: "click", target: { testId: "menu" } }],
          source: "auto",
          shots: {},
        },
      ],
    },
  ],
});

const file = (raw: unknown) => AuthoredFileSchema.parse(raw);

describe("mergeAuthored", () => {
  it("adds states to their page, authored and with no shots", () => {
    const r = mergeAuthored(model(), [
      file({
        states: [
          {
            page: "/cart",
            id: "with-items",
            kind: "other",
            label: "Cart with items",
            isolate: true,
            recipe: [{ action: "click", target: { testId: "add" } }],
            shots: { desktop: { full: "stale.png" } },
          },
        ],
      }),
    ]);
    const state = r.model.routes[0].states[2];
    expect(state).toMatchObject({ id: "with-items", source: "authored", isolate: true, shots: {} });
    expect(r.added).toEqual([{ page: "/cart", state: "with-items" }]);
  });

  it("applies one state to every page it names", () => {
    const m = model();
    m.routes.push({ id: "cart-2", url: "/cart/2", depth: 0, states: [] });
    const r = mergeAuthored(m, [
      file({ states: [{ page: ["/cart", "/cart/2"], id: "promo", label: "Promo", recipe: [] }] }),
    ]);
    expect(r.added).toEqual([
      { page: "/cart", state: "promo" },
      { page: "/cart/2", state: "promo" },
    ]);
  });

  it("replaces a state with the same id, auto or not", () => {
    const r = mergeAuthored(model(), [
      file({
        states: [
          {
            page: "/cart",
            id: "menu",
            kind: "drawer",
            label: "Menu",
            recipe: [{ action: "click", target: { testId: "menu-btn" } }],
          },
        ],
      }),
    ]);
    expect(r.model.routes[0].states).toHaveLength(2);
    expect(r.model.routes[0].states[1]).toMatchObject({ kind: "drawer", source: "authored" });
    expect(r.replaced).toEqual([{ page: "/cart", state: "menu" }]);
  });

  it("holds back states for unknown pages and collects proposed pages", () => {
    const r = mergeAuthored(model(), [
      file({
        states: [{ page: "/editor", id: "draft", label: "Draft", recipe: [] }],
        pages: ["/editor", "/cart"],
      }),
    ]);
    expect(r.unknownPages).toEqual(["/editor"]);
    expect(r.proposedPages).toEqual(["/editor"]);
    expect(r.added).toEqual([]);
  });

  it("matches pages through the canonical form", () => {
    const r = mergeAuthored(
      model(),
      [file({ states: [{ page: "/cart/", id: "x", label: "X", recipe: [] }] })],
      (p) => p.replace(/\/$/, ""),
    );
    expect(r.added).toEqual([{ page: "/cart", state: "x" }]);
  });

  it("rejects a malformed state with a pointed path", () => {
    expect(() =>
      AuthoredFileSchema.parse({
        states: [{ page: "/cart", id: "x", recipe: [{ action: "clik" }] }],
      }),
    ).toThrow();
  });
});
