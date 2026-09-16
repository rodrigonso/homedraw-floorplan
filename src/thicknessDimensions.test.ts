import { describe, expect, it } from "vitest";
import { thicknessDimensionPosition } from "./dimensions";
import {
  addThicknessDimension, addWall, createEmptyPlan, deleteNode, deleteThicknessDimension, deleteWall,
  distance, getNodeDeletionInfo, mergeNodes, moveNode, resizeWall, setWallThickness, splitWall,
  updateThicknessDimension, validatePlan, wallPoints, type Plan, type ThicknessDimension,
} from "./model";
import { deleteSelection, getMarqueeSelection, moveSelection, selectionBounds, type SelectionItem } from "./selection";

function fixture(): Plan {
  return validatePlan({
    ...createEmptyPlan(),
    nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 }],
    walls: [
      { id: "wall", a: "a", b: "b", thickness: 150, dimension: true },
      { id: "other", a: "b", b: "c", thickness: 100, dimension: false },
    ],
  });
}

const measured = () => addThicknessDimension(fixture(), "wall");
const annotation = (plan: Plan): SelectionItem => ({ kind: "thickness", id: plan.thicknessDimensions![0].id });
function station(plan: Plan, dimension: ThicknessDimension) {
  const { a, b } = thicknessDimensionPosition(plan, dimension);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

describe("thickness measurement model and schema", () => {
  it("preserves legacy omission and supports independent annotations with stable IDs", () => {
    const original = fixture(), plan = addThicknessDimension(addThicknessDimension(original, "wall"), "wall", -1200);
    expect(validatePlan(original)).not.toHaveProperty("thicknessDimensions");
    expect(plan.thicknessDimensions!.map(dimension => dimension.offset)).toEqual([350, -1200]);
    expect(plan.thicknessDimensions![0].id).not.toBe(plan.thicknessDimensions![1].id);
    const id = plan.thicknessDimensions![0].id;
    expect(updateThicknessDimension(plan, id, { offset: 350 })).toBe(plan);
    const updated = updateThicknessDimension(plan, id, { offset: -4000 });
    expect(updated.thicknessDimensions![0]).toEqual({ ...plan.thicknessDimensions![0], offset: -4000 });
    expect(validatePlan(JSON.parse(JSON.stringify(updated)))).toEqual(updated);
    const deleted = deleteThicknessDimension(updated, id);
    expect(deleted.thicknessDimensions).toEqual([plan.thicknessDimensions![1]]);
    expect(deleted.walls).toEqual(original.walls);
    expect(original).not.toHaveProperty("thicknessDimensions");
  });

  it.each([NaN, Infinity, -Infinity, -100001, 100001])("rejects invalid offset %s on creation and update", offset => {
    const plan = measured();
    expect(() => addThicknessDimension(plan, "wall", offset)).toThrow(/offset/i);
    expect(() => updateThicknessDimension(plan, plan.thicknessDimensions![0].id, { offset })).toThrow(/offset/i);
  });

  it.each([
    undefined, null, {}, [null], [{ id: "dim", wallId: "missing", offset: 0 }],
    [{ id: "wall", wallId: "wall", offset: 0 }], [{ id: "dim", wallId: "wall" }],
    [{ id: "dim", wallId: "wall", offset: "350" }], [{ id: "dim", wallId: "wall", offset: 0, extra: 1 }],
    [{ id: "dim", wallId: "wall", offset: 0 }, { id: "dim", wallId: "other", offset: 0 }],
    Array.from({ length: 1001 }, (_, i) => ({ id: `dim${i}`, wallId: "wall", offset: 0 })),
  ])("rejects malformed collections %#", thicknessDimensions => {
    expect(() => validatePlan({ ...fixture(), thicknessDimensions })).toThrow();
  });

  it("rejects absent references and unsupported update fields", () => {
    const plan = measured(), id = plan.thicknessDimensions![0].id;
    expect(() => addThicknessDimension(plan, "missing")).toThrow(/no longer exists/);
    expect(() => updateThicknessDimension(plan, "missing", { offset: 0 })).toThrow(/no longer exists/);
    expect(() => deleteThicknessDimension(plan, "missing")).toThrow(/no longer exists/);
    const patch = { offset: 0, wallId: "other" };
    expect(() => updateThicknessDimension(plan, id, patch)).toThrow(/unsupported/);
    expect(() => updateThicknessDimension(plan, id, { ...patch, offset: plan.thicknessDimensions![0].offset }))
      .toThrow(/unsupported/);
  });

  it("retains collapsed annotations for repair, but does not create a direction for new ones", () => {
    const plan = measured(), collapsed = moveNode(plan, "b", { x: 0, y: 0 });
    expect(collapsed.thicknessDimensions).toEqual(plan.thicknessDimensions);
    expect(() => thicknessDimensionPosition(collapsed, collapsed.thicknessDimensions![0])).toThrow(/apart/);
    expect(() => addThicknessDimension(collapsed, "wall")).toThrow(/apart/);
    expect(validatePlan(collapsed)).toEqual(collapsed);
    const resized = setWallThickness(collapsed, "wall", 300);
    expect(resized.thicknessDimensions).toEqual(plan.thicknessDimensions);
    const repaired = moveNode(resized, "b", { x: 4000, y: 0 });
    const dim = thicknessDimensionPosition(repaired, repaired.thicknessDimensions![0]);
    expect(distance(dim.a, dim.b)).toBe(300);
  });
});

describe("face-to-face geometry and attachment", () => {
  it.each([0, Math.PI / 2, Math.PI, Math.PI / 6, -Math.PI / 3])("measures exactly across rotated faces (%s)", rotation => {
    const original = measured();
    const plan = validatePlan({ ...original, nodes: original.nodes.map(node => ({
      ...node, x: node.x * Math.cos(rotation) - node.y * Math.sin(rotation),
      y: node.x * Math.sin(rotation) + node.y * Math.cos(rotation),
    })) });
    for (const thickness of [10, 150, 1000]) for (const offset of [-6000, -2000, 0, 350]) {
      const resized = setWallThickness(plan, "wall", thickness);
      const dim = thicknessDimensionPosition(resized, { ...resized.thicknessDimensions![0], offset });
      expect(distance(dim.a, dim.b)).toBeCloseTo(thickness, 8);
      const center = { x: (dim.a.x + dim.b.x) / 2, y: (dim.a.y + dim.b.y) / 2 };
      expect(center.x).toBeCloseTo((4000 + offset) * Math.cos(rotation), 8);
      expect(center.y).toBeCloseTo((4000 + offset) * Math.sin(rotation), 8);
      expect(distance(center, dim.label)).toBeCloseTo(thickness / 2 + 350, 8);
      expect(dim.extensions).toHaveLength(offset > 0 || offset < -4000 ? 2 : 0);
      expect(dim.ticks).toHaveLength(2);
      expect(dim.ticks.every(tick => Math.abs(distance(...tick) - 90) < 1e-8)).toBe(true);
      expect(resized.nodes).toEqual(plan.nodes);
    }
  });

  it("starts outside extensions after the clamped face and overshoots the measurement", () => {
    const plan = measured(), dimension = plan.thicknessDimensions![0];
    const after = thicknessDimensionPosition(plan, { ...dimension, offset: 350 });
    expect(after.extensions).toEqual([
      [{ x: 4060, y: -75 }, { x: 4440, y: -75 }],
      [{ x: 4060, y: 75 }, { x: 4440, y: 75 }],
    ]);
    const before = thicknessDimensionPosition(plan, { ...dimension, offset: -4350 });
    expect(before.extensions).toEqual([
      [{ x: -60, y: -75 }, { x: -440, y: -75 }],
      [{ x: -60, y: 75 }, { x: -440, y: 75 }],
    ]);
  });

  it("retains the gap from endpoint B on resizing or moving hosts", () => {
    const plan = measured(), resized = resizeWall(plan, "wall", 6000);
    expect(station(resized, resized.thicknessDimensions![0])).toEqual({ x: 6350, y: 0 });
    const moved = moveSelection(plan, [{ kind: "wall", id: "wall" }, annotation(plan)], { x: 200, y: 100 });
    expect(moved.thicknessDimensions).toEqual(plan.thicknessDimensions);
    expect(station(moved, moved.thicknessDimensions![0])).toEqual({ x: 4550, y: 100 });
    const nodeMoved = moveSelection(plan, [{ kind: "node", id: "b" }, annotation(plan)], { x: 200, y: 100 });
    expect(nodeMoved.thicknessDimensions).toEqual(plan.thicknessDimensions);
  });
});

describe("topology preservation", () => {
  it("preserves fractional end offsets exactly when inserting unrelated walls or keeping the final segment", () => {
    const plan = addThicknessDimension(fixture(), "wall", 0.123456789);
    const unrelated = addWall(plan, { x: 10000, y: 0 }, { x: 15000, y: 0 }, 150);
    expect(unrelated.thicknessDimensions).toEqual(plan.thicknessDimensions);
    const split = splitWall(plan, "wall", 2000);
    expect(split.thicknessDimensions![0].offset).toBe(plan.thicknessDimensions![0].offset);
  });

  it("partitions each annotation once, including exact cuts and either overhang", () => {
    let plan = fixture();
    for (const offset of [-5000, -3000, -2000, -1000, 350]) plan = addThicknessDimension(plan, "wall", offset);
    const before = plan.thicknessDimensions!.map(dimension => station(plan, dimension));
    const split = splitWall(plan, "wall", 2000);
    expect(split.thicknessDimensions).toHaveLength(5);
    split.thicknessDimensions!.forEach((dimension, i) => {
      expect(station(split, dimension)).toEqual(before[i]);
      expect(dimension.id).toBe(plan.thicknessDimensions![i].id);
      expect(dimension.wallId === "wall").toBe(i < 2);
    });
  });

  it("carries updates through automatic partitions on several walls", () => {
    let plan = addThicknessDimension(addThicknessDimension(fixture(), "wall", -500), "other", -100);
    const before = plan.thicknessDimensions!.map(dimension => station(plan, dimension));
    plan = addWall(plan, { x: 2000, y: 0 }, { x: 4000, y: 1500 }, 150);
    expect(plan.thicknessDimensions!.map(dimension => station(plan, dimension))).toEqual(before);
    expect(plan.thicknessDimensions!.map(dimension => dimension.wallId)).not.toContain("wall");
    expect(plan.thicknessDimensions!.map(dimension => dimension.wallId)).not.toContain("other");
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "preserves stations through collinear joins with reversed hosts %s/%s", (first, second) => {
      let plan = splitWall(fixture(), "wall", 2000);
      const junction = plan.nodes.find(node => !fixture().nodes.some(original => original.id === node.id))!;
      const segments = plan.walls.filter(wall => wall.id !== "other");
      plan = validatePlan({ ...plan, walls: plan.walls.map(wall =>
        wall.id === segments[0].id && first || wall.id === segments[1].id && second ? { ...wall, a: wall.b, b: wall.a } : wall) });
      for (const wall of segments) for (const offset of [-2500, -500, 350]) plan = addThicknessDimension(plan, wall.id, offset);
      const before = plan.thicknessDimensions!.map(dimension => station(plan, dimension));
      expect(getNodeDeletionInfo(plan, junction.id).removedThickness).toBe(0);
      const joined = deleteNode(plan, junction.id);
      expect(joined.thicknessDimensions!.map(dimension => station(joined, dimension))).toEqual(before);
      expect(joined.thicknessDimensions!.every(dimension => dimension.wallId === "wall")).toBe(true);
    },
  );

  it("projects annotations onto noncollinear joined walls", () => {
    const plan = addThicknessDimension(measured(), "other", -500);
    const joined = deleteNode(plan, "b"), wall = joined.walls[0], [a, b] = wallPoints(joined, wall);
    const length = distance(a, b);
    for (const dimension of plan.thicknessDimensions!) {
      const point = station(plan, dimension);
      const projected = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length;
      expect(joined.thicknessDimensions!.find(item => item.id === dimension.id)!.offset).toBeCloseTo(projected - length);
    }
  });

  it("uses deterministic path coordinates when a joined wall collapses", () => {
    const plan = moveNode(addThicknessDimension(measured(), "other", -500), "c", { x: 0, y: 0 });
    const joined = deleteNode(plan, "b");
    expect(joined.thicknessDimensions!.map(dimension => dimension.offset)).toEqual([4350, 7500]);
    expect(validatePlan(joined)).toEqual(joined);
  });

  it("removes only annotations on deleted hosts or self-loop walls", () => {
    const plan = addThicknessDimension(measured(), "other");
    const remaining = [plan.thicknessDimensions![1]];
    expect(deleteWall(plan, "wall").thicknessDimensions).toEqual(remaining);
    expect(getNodeDeletionInfo(plan, "a").removedThickness).toBe(1);
    expect(deleteNode(plan, "a").thicknessDimensions).toEqual(remaining);
    expect(mergeNodes(plan, "a", "b").thicknessDimensions).toEqual(remaining);
    expect(deleteSelection(plan, [{ kind: "wall", id: "wall" }]).thicknessDimensions).toEqual(remaining);
  });
});

describe("thickness selection", () => {
  it("requires the entire callout, respects visibility, and omits annotations covered by walls", () => {
    const plan = measured(), item = annotation(plan), bounds = selectionBounds(plan, [item])!;
    const start = { x: bounds.x, y: bounds.y }, end = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
    expect(getMarqueeSelection(plan, start, end, true)).toEqual([item]);
    expect(getMarqueeSelection(plan, end, start, true)).toEqual([item]);
    expect(getMarqueeSelection(plan, start, end, false)).toEqual([]);
    expect(getMarqueeSelection(plan, start, { ...end, y: end.y - 0.01 }, true)).toEqual([]);
    expect(selectionBounds(plan, [item], false)).toBeNull();
    expect(getMarqueeSelection(plan, { x: -1000, y: -1000 }, { x: 6000, y: 6000 }, true))
      .toEqual(plan.walls.map(wall => ({ kind: "wall", id: wall.id })));
    expect(selectionBounds(plan, [{ kind: "wall", id: "wall" }])!.width).toBeGreaterThan(4000);
    expect(selectionBounds(plan, [{ kind: "wall", id: "wall" }], false)!.width).toBe(4000);
  });

  it("moves annotations along each host axis without changing geometry", () => {
    const plan = addThicknessDimension(measured(), "other");
    const selected: SelectionItem[] = plan.thicknessDimensions!.map(dimension => ({ kind: "thickness", id: dimension.id }));
    const moved = moveSelection(plan, selected, { x: 200, y: -400 });
    expect(moved.thicknessDimensions!.map(dimension => dimension.offset)).toEqual([550, -50]);
    expect(moved.nodes).toEqual(plan.nodes);
    expect(moved.walls).toEqual(plan.walls);
    expect(moveSelection(plan, [annotation(plan)], { x: 0, y: 300 })).toBe(plan);
    expect(deleteSelection(plan, selected).thicknessDimensions).toEqual([]);
    expect(deleteSelection(plan, selected).walls).toEqual(plan.walls);
  });

  it("handles collapsed selections without inventing a movement axis", () => {
    const plan = moveNode(measured(), "b", { x: 0, y: 0 }), item = annotation(plan);
    expect(selectionBounds(plan, [item])).not.toBeNull();
    expect(() => moveSelection(plan, [item], { x: 100, y: 0 })).toThrow(/apart/);
    expect(deleteSelection(plan, [item]).thicknessDimensions).toEqual([]);
  });
});
