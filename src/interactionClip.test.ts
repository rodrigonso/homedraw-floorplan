import { describe, expect, it } from "vitest";
import { interactionClip } from "./interactionClip";

function area(path: string) {
  return Math.abs((path.match(/M[^Z]+Z/g) ?? []).reduce((sum, polygon) => {
    const points = [...polygon.matchAll(/(?:M|L)(-?[\d.]+),(-?[\d.]+)/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    return sum + points.reduce((sum, [x, y], i) => {
      const [nextX, nextY] = points[(i + 1) % points.length];
      return sum + (x * nextY - nextX * y) / 2;
    }, 0);
  }, 0));
}

describe("text interaction cutouts", () => {
  it("leaves the drafting layer unchanged when there are no text regions", () => {
    expect(interactionClip(100, 100, [])).toBeUndefined();
    expect(interactionClip(0, 100, [[10, 10, 30, 30]])).toBeUndefined();
  });
  it("removes text bounds without removing surrounding drafting space", () => {
    expect(area(interactionClip(100, 100, [[10, 10, 30, 30]])!)).toBe(9600);
  });
  it("unions overlapping text and handle regions instead of making the overlap intercept input", () => {
    expect(area(interactionClip(100, 100, [[10, 10, 30, 30], [20, 20, 40, 40]])!)).toBe(9300);
  });
  it("clips offscreen notes and permits text to cover the entire viewport", () => {
    expect(area(interactionClip(100, 100, [[-10, -10, 10, 10], [200, 200, 300, 300]])!)).toBe(9900);
    expect(interactionClip(100, 100, [[-10, -10, 110, 110]])).toBe("");
  });
});
