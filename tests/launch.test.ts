import { afterEach, describe, expect, it } from "vitest";
import { launchOptions, setHeaded } from "../src/shared/launch";

describe("launchOptions", () => {
  afterEach(() => setHeaded(false));

  it("launches headless unless --headed asked otherwise", () => {
    expect(launchOptions()).toEqual({});
    setHeaded(true);
    expect(launchOptions()).toEqual({ headless: false });
  });
});
