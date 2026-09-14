import { describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createSceneCache, type PlanShape } from "./sceneCache";

const shape = (id: string, x = 0): PlanShape => ({ id, type: "rectangle", x, y: 0, width: 100, height: 100 });
function setup() {
  let nonce = 0;
  const convert = vi.fn((shapes: PlanShape[]): ExcalidrawElement[] => shapes.map(shape => ({
    id: shape.id, type: "rectangle", x: shape.x ?? 0, y: shape.y ?? 0, width: 100, height: 100,
    angle: 0 as ExcalidrawElement["angle"], strokeColor: "#444", backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roundness: null, roughness: 0, opacity: 100,
    seed: 1, version: 1, versionNonce: ++nonce, index: null, isDeleted: false, groupIds: [], frameId: null,
    boundElements: null, updated: 0, link: null, locked: true,
  })));
  return { cache: createSceneCache(convert), convert };
}

describe("incremental scene conversion", () => {
  it("reuses element objects and the scene array for equivalent shapes", () => {
    const { cache, convert } = setup();
    const first = cache.render([shape("a"), shape("b")]);
    expect(cache.render([shape("a"), shape("b")])).toBe(first);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("converts only changed shapes and advances their versions without mutating the old scene", () => {
    const { cache, convert } = setup();
    const first = cache.render([shape("a"), shape("b")]);
    const before = JSON.stringify(first);
    const next = cache.render([shape("a", 250), shape("b")]);
    expect(convert.mock.lastCall![0]).toEqual([shape("a", 250)]);
    expect(next[0]).not.toBe(first[0]);
    expect(next[0].version).toBe(first[0].version + 1);
    expect(next[0].versionNonce).not.toBe(first[0].versionNonce);
    expect(next[1]).toBe(first[1]);
    expect(JSON.stringify(first)).toBe(before);
  });

  it("preserves existing indices while leaving new shapes for Excalidraw to order", () => {
    const { cache } = setup();
    const first = cache.render([shape("a"), shape("b")]);
    Object.assign(first[0], { index: "a0" });
    Object.assign(first[1], { index: "a1" });
    const next = cache.render([shape("a", 25), shape("new"), shape("b")]);
    expect(next.map(element => element.index)).toEqual(["a0", null, "a1"]);
    expect(next[2]).toBe(first[1]);
  });

  it("tracks draw order without converting unchanged parts", () => {
    const { cache, convert } = setup();
    const first = cache.render([shape("a"), shape("b")]);
    const reversed = cache.render([shape("b"), shape("a")]);
    expect(reversed).toEqual([first[1], first[0]]);
    expect(reversed[0]).toBe(first[1]);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("retains canvas caches when Excalidraw only repairs fractional indices", () => {
    const { cache, convert } = setup();
    const first = cache.render([shape("a"), shape("b")]);
    for (const [i, element] of first.entries()) {
      Object.assign(element, { index: `a${i}`, version: element.version + 1, versionNonce: 100 + i, updated: 123 });
    }
    expect(cache.render([shape("a"), shape("b")])).toBe(first);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("evicts removed parts instead of retaining drag or undo history", () => {
    const { cache, convert } = setup();
    const first = cache.render([shape("a"), shape("b")]);
    expect(cache.render([shape("b")])).toEqual([first[1]]);
    const restored = cache.render([shape("a"), shape("b")]);
    expect(restored[0]).not.toBe(first[0]);
    expect(restored[1]).toBe(first[1]);
    expect(convert.mock.lastCall![0]).toEqual([shape("a")]);
    expect(cache.render([])).toEqual([]);
  });

  it("invalidates elements changed by Excalidraw rather than reusing stale render data", () => {
    const { cache } = setup();
    const [first] = cache.render([shape("a")]);
    Object.assign(first, { x: 999, version: first.version + 1, versionNonce: 1000 });
    const [restored] = cache.render([shape("a")]);
    expect(restored).not.toBe(first);
    expect(restored.x).toBe(0);
    expect(restored.version).toBe(first.version + 1);
  });

  it("can invalidate all text and shape measurements after fonts load", () => {
    const { cache, convert } = setup();
    const first = cache.render([shape("a")]);
    cache.clear();
    expect(cache.render([shape("a")])[0]).not.toBe(first[0]);
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it("does not share caches between editors or exports", () => {
    const first = setup(), second = setup();
    expect(first.cache.render([shape("a")])[0]).not.toBe(second.cache.render([shape("a")])[0]);
  });

  it("surfaces a missing converted element rather than omitting drawing geometry", () => {
    const cache = createSceneCache(() => []);
    expect(() => cache.render([shape("a")])).toThrow("Could not render plan element a");
  });
});
