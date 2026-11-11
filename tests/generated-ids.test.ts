import { beforeEach, describe, expect, it } from "vitest";
import {
  confirmStableId,
  generatedIdSource,
  idOfSelector,
  idShape,
  isGeneratedId,
  learnUnstableId,
  learnedUnstableIds,
  namesGeneratedId,
  needsStabilityCheck,
  useUnstableIds,
} from "../src/crawl/generated-ids";
import { ConfigSchema } from "../src/shared/config";

beforeEach(() => useUnstableIds([]));

describe("generated ids: what's known without looking", () => {
  it("recognises React's useId in every version, alone or inside a library's id", () => {
    for (const id of [
      ":r1:",
      ":R5cpj6:",
      "«r1»",
      "_r_6_",
      "_r_1i5_",
      "_R_5cpj6_",
      "base-ui-_r_1aq_",
      "radix-:r3:",
      "headlessui-dialog-:r2:",
    ])
      expect(isGeneratedId(id), id).toBe(true);
  });

  it("recognises libraries that number their own ids", () => {
    for (const id of [
      "headlessui-menu-button-1",
      "mui-12",
      "react-select-2-input",
      "react-aria123",
    ])
      expect(isGeneratedId(id), id).toBe(true);
  });

  it("leaves ids an app chose alone", () => {
    for (const id of [
      "main",
      "settings-dialog",
      "react-select-reimport-form-network-input",
      "user_role",
      "nav-r1",
      "step-2",
      "mat-dialog-0",
    ])
      expect(isGeneratedId(id), id).toBe(false);
  });

  it("finds a generated id inside a selector, escaped or quoted", () => {
    expect(namesGeneratedId('[id="_r_1i5_"]')).toBe(true);
    expect(namesGeneratedId('[id="base-ui-_r_1aq_"]')).toBe(true);
    expect(namesGeneratedId("#base-ui-_r_2_")).toBe(true);
    expect(namesGeneratedId("#radix-\\:r3\\:")).toBe(true);
    expect(namesGeneratedId("#settings-dialog")).toBe(false);
    expect(namesGeneratedId('dialog[open]:visible,[role="dialog"]:visible')).toBe(false);
    expect(namesGeneratedId("table > tbody > tr:nth-of-type(1) button")).toBe(false);
  });

  it("reads the id out of a selector that is only an id", () => {
    expect(idOfSelector('[id="_r_6_"]')).toBe("_r_6_");
    expect(idOfSelector("#mat-dialog-3")).toBe("mat-dialog-3");
    expect(idOfSelector("#radix-\\:r3\\:")).toBe("radix-:r3:");
    expect(idOfSelector("#a .b")).toBeUndefined();
    expect(idOfSelector('dialog[open],[role="dialog"]')).toBeUndefined();
  });
});

describe("generated ids: what a project and a crawl add", () => {
  it("takes the project's own patterns from the config", () => {
    useUnstableIds(["^mat-dialog-\\d+$", "^ember\\d+$"]);
    expect(isGeneratedId("mat-dialog-0")).toBe(true);
    expect(isGeneratedId("ember812")).toBe(true);
    expect(isGeneratedId("ember-app")).toBe(false);
    // …and in the source the page-side checks compile.
    expect(new RegExp(generatedIdSource()).test("mat-dialog-7")).toBe(true);
  });

  it("rejects a pattern that isn't a regular expression when the config is read", () => {
    expect(() => ConfigSchema.parse({ discovery: { unstableIds: ["(unclosed"] } })).toThrow(
      /regular expression/,
    );
  });

  it("turns an id into the shape of its siblings", () => {
    expect(idShape("mat-dialog-3")).toBe("^mat\\-dialog\\-\\d+$");
    expect(idShape("ember812")).toBe("^ember\\d+$");
    expect(idShape("widget-k3j9x")).toBe("^widget\\-[0-9a-zA-Z]+$");
    expect(idShape("j_idt45")).toBe("^j_idt\\d+$");
    expect(idShape("__BVID__12")).toBe("^__BVID__\\d+$");
    // Nothing to generalise from, or nothing left that's specific:
    expect(idShape("settings")).toBeUndefined();
    expect(idShape("a1b2")).toBeUndefined();
    expect(idShape("123")).toBeUndefined();
  });

  it("learns a changing id's shape, so its siblings are avoided too", () => {
    expect(isGeneratedId("dlg-9")).toBe(false);
    expect(learnUnstableId("dlg-3", "reopen")).toBe("^dlg\\-\\d+$");
    expect(isGeneratedId("dlg-9")).toBe(true);
    expect(isGeneratedId("dlg-title-9")).toBe(false);
    expect(learnedUnstableIds()).toEqual([
      { pattern: "^dlg\\-\\d+$", example: "dlg-3", seen: "reopen" },
    ]);
    // A new run starts from the config again.
    useUnstableIds([]);
    expect(isGeneratedId("dlg-9")).toBe(false);
  });

  it("doesn't count a configured pattern as learned", () => {
    useUnstableIds(["^dlg\\-\\d+$"]);
    learnUnstableId("dlg-3", "loads");
    expect(learnedUnstableIds()).toEqual([]);
  });

  it("checks each shape of id once", () => {
    expect(needsStabilityCheck("step-2")).toBe(true);
    confirmStableId("step-2");
    expect(needsStabilityCheck("step-5")).toBe(false);
    // Known already, or no number to vary: nothing to check.
    expect(needsStabilityCheck("_r_6_")).toBe(false);
    expect(needsStabilityCheck("settings-dialog")).toBe(false);
  });
});
