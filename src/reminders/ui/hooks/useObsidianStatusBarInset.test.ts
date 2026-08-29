import { describe, expect, it } from "vitest";
import { calculateBottomOverlayInset } from "./useObsidianStatusBarInset";

function rect(top: number, right: number, bottom: number, left: number): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    height: bottom - top,
  } as DOMRect;
}

describe("calculateBottomOverlayInset", () => {
  it("returns the overlapping status bar height", () => {
    expect(calculateBottomOverlayInset(
      rect(0, 724, 1624, 0),
      rect(1570, 724, 1624, 0),
    )).toBe(54);
  });

  it("ignores an overlay outside the host horizontally", () => {
    expect(calculateBottomOverlayInset(
      rect(0, 500, 800, 0),
      rect(770, 900, 800, 600),
    )).toBe(0);
  });

  it("ignores an overlay below the host", () => {
    expect(calculateBottomOverlayInset(
      rect(0, 500, 700, 0),
      rect(720, 500, 750, 0),
    )).toBe(0);
  });
});
