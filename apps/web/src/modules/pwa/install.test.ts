import { describe, expect, it } from "vitest";
import { isIosDevice, isStandaloneDisplay } from "./install";

describe("isIosDevice", () => {
  it("detects iPhone, iPad and iPod user agents only", () => {
    expect(isIosDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe(false);
    expect(isIosDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
  });
});

describe("isStandaloneDisplay", () => {
  it("treats either the display-mode media query or iOS navigator.standalone as installed", () => {
    expect(isStandaloneDisplay(true)).toBe(true);
    expect(isStandaloneDisplay(false, true)).toBe(true);
    expect(isStandaloneDisplay(false, false)).toBe(false);
    expect(isStandaloneDisplay(false)).toBe(false);
  });
});
