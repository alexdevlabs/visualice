import { describe, expect, it } from "vitest";
import {
  focusRingChanged,
  targetFor,
  touchRecipe,
  validationAppeared,
  type FocusStyle,
  type ValidationSignals,
} from "../src/crawl/discover-forms";

const style = (over: Partial<FocusStyle> = {}): FocusStyle => ({
  outline: "none 0px rgb(0, 0, 0)",
  outlineOffset: "0px",
  boxShadow: "none",
  borderColor: "rgb(200, 200, 200)",
  backgroundColor: "rgb(255, 255, 255)",
  ...over,
});

const signals = (over: Partial<ValidationSignals> = {}): ValidationSignals => ({
  invalid: 0,
  alerts: 0,
  describedBy: 0,
  ...over,
});

describe("focusRingChanged", () => {
  it("is false when focusing draws nothing — there is no state to capture", () => {
    expect(focusRingChanged(style(), style())).toBe(false);
  });

  it("notices any of the ways a focus ring is drawn", () => {
    expect(focusRingChanged(style(), style({ outline: "solid 2px rgb(0, 90, 255)" }))).toBe(true);
    expect(focusRingChanged(style(), style({ boxShadow: "rgb(0, 90, 255) 0px 0px 0px 3px" }))).toBe(
      true,
    );
    expect(focusRingChanged(style(), style({ borderColor: "rgb(0, 90, 255)" }))).toBe(true);
    expect(focusRingChanged(style(), style({ outlineOffset: "2px" }))).toBe(true);
    expect(focusRingChanged(style(), style({ backgroundColor: "rgb(240, 245, 255)" }))).toBe(true);
  });
});

describe("validationAppeared", () => {
  it("fires when an error marker shows up that wasn't there", () => {
    expect(validationAppeared(signals(), signals({ invalid: 2 }))).toBe(true);
    expect(validationAppeared(signals(), signals({ alerts: 1 }))).toBe(true);
    expect(validationAppeared(signals(), signals({ describedBy: 3 }))).toBe(true);
  });

  it("does not fire on markers that were already there", () => {
    // A form that ships `aria-describedby` hints on every field isn't in error.
    expect(validationAppeared(signals({ describedBy: 4 }), signals({ describedBy: 4 }))).toBe(
      false,
    );
    expect(validationAppeared(signals({ invalid: 1 }), signals({ invalid: 1 }))).toBe(false);
  });

  it("does not fire when markers go away", () => {
    expect(validationAppeared(signals({ invalid: 3 }), signals({ invalid: 0 }))).toBe(false);
  });
});

describe("targetFor", () => {
  it("prefers a test id, which is put there to be targeted", () => {
    expect(targetFor({ testId: "email", id: "contact-email", name: "email", index: 3 })).toEqual({
      testId: "email",
    });
  });

  it("prefers an id", () => {
    expect(targetFor({ id: "contact-email", name: "email", index: 3 })).toEqual({
      selector: "#contact-email",
    });
  });

  it("falls back to the name when the id would need escaping", () => {
    expect(targetFor({ id: "field:email[0]", name: "email", index: 3 })).toEqual({
      selector: 'form [name="email"]',
    });
  });

  it("falls back to position when the field carries no handle at all", () => {
    const target = targetFor({ index: 2 });
    expect(target.nth).toBe(2);
    expect(target.selector).toContain("form input");
  });
});

describe("touchRecipe", () => {
  it("focuses and blurs each field, then waits for the errors to render", () => {
    const recipe = touchRecipe([
      { id: "a", index: 0 },
      { id: "b", index: 1 },
    ]);
    expect(recipe).toEqual([
      { action: "focus", target: { selector: "#a" } },
      { action: "blur" },
      { action: "focus", target: { selector: "#b" } },
      { action: "blur" },
      { action: "wait", ms: 300 },
    ]);
  });

  it("never submits anything — discovery must stay idempotent", () => {
    const actions = touchRecipe([{ id: "a", index: 0 }]).map((s) => s.action);
    expect(actions).not.toContain("click");
    expect(actions).not.toContain("press");
  });
});
