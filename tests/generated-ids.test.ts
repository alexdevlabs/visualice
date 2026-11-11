import { describe, expect, it } from "vitest";
import { isGeneratedId, namesGeneratedId } from "../src/crawl/generated-ids";

describe("generated ids", () => {
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
      "error",
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
});
