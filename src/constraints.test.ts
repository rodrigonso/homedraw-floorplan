import { describe, expect, it } from "vitest";
import { constrainToAxis, createEmptyPlan, snapPoint } from "./model";

describe("right-angle constraints", () => {
  it.each([
    [{ x: 373, y: 110 }, { x: 373, y: 35 }],
    [{ x: 110, y: 373 }, { x: 25, y: 373 }],
    [{ x: -373, y: 110 }, { x: -373, y: 35 }],
    [{ x: 110, y: -373 }, { x: 25, y: -373 }],
    [{ x: 125, y: 135 }, { x: 125, y: 35 }],
  ])("chooses the nearest axis from a non-grid origin for %j", (point, expected) => {
    expect(constrainToAxis(point, { x: 25, y: 35 })).toEqual(expected);
  });

  it("does not quantize or clamp a constrained position", () => {
    expect(constrainToAxis({ x: 277.25, y: 173.5 }, { x: 0, y: 0 })).toEqual({ x: 277.25, y: 0 });
    expect(constrainToAxis({ x: 100000, y: 400 }, { x: -100000, y: 0 })).toEqual({ x: 100000, y: 0 });
    expect(snapPoint(createEmptyPlan(), { x: 373, y: 110 }, 0, 0, { x: 25, y: 35 }, true)).toEqual({ x: 373, y: 35 });
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite coordinates (%s)", value => {
    expect(() => constrainToAxis({ x: value, y: 0 }, { x: 0, y: 0 })).toThrow(/finite/);
    expect(() => constrainToAxis({ x: 0, y: 0 }, { x: 0, y: value })).toThrow(/finite/);
  });
});
