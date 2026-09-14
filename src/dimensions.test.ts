import { describe, expect, it } from "vitest";
import {
  addOpening, addRoom, addWall, createEmptyPlan, moveWall, resizeWall,
  setDimensionOffset, setWallThickness, toggleDimension, validatePlan,
} from "./model";
import { dimensionPosition, draggedDimensionOffset } from "./dimensions";

const rectangle = () => addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);

describe("attached dimension placement", () => {
  it("keeps default outward placement and accepts existing project files without offsets", () => {
    const plan = rectangle();
    expect(validatePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(dimensionPosition(plan, plan.walls[0])).toMatchObject({
      a: { x: 0, y: -425 }, b: { x: 4000, y: -425 }, offset: -425,
    });
    expect(dimensionPosition(plan, plan.walls[1])).toMatchObject({
      a: { x: 4425, y: 0 }, b: { x: 4425, y: 3000 }, offset: -425,
    });
  });

  it.each([-1200, 0, 350, 2400])("round-trips a signed offset of %s without changing geometry", offset => {
    let plan = rectangle();
    plan = addOpening(plan, plan.walls[0].id, "window", 2000, 1000);
    const changed = setDimensionOffset(plan, plan.walls[0].id, offset);
    expect(plan.walls[0].dimensionOffset).toBeUndefined();
    expect(changed.nodes).toEqual(plan.nodes);
    expect(changed.openings).toEqual(plan.openings);
    expect(changed.walls.slice(1)).toEqual(plan.walls.slice(1));
    expect(changed.walls[0]).toEqual({ ...plan.walls[0], dimensionOffset: offset });
    expect(validatePlan(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    expect(dimensionPosition(changed, changed.walls[0])).toMatchObject({
      label: { x: 2000, y: offset }, a: { x: 0, y: offset }, b: { x: 4000, y: offset },
    });
    expect(setDimensionOffset(changed, changed.walls[0].id, offset)).toBe(changed);
  });

  it("keeps manual placement fixed when new rooms move the plan's center", () => {
    const base = rectangle();
    const plan = setDimensionOffset(base, base.walls[0].id, -750);
    const previous = dimensionPosition(plan, plan.walls[0]);
    const extended = addRoom(plan, { x: 0, y: -20000 }, { x: 4000, y: 0 }, 150);
    expect(dimensionPosition(extended, extended.walls.find(w => w.id === plan.walls[0].id)!)).toEqual(previous);
  });

  it("follows wall movement, rotation and resize without changing the stored offset", () => {
    const base = rectangle();
    let plan = setDimensionOffset(base, base.walls[1].id, -650);
    plan = resizeWall(plan, plan.walls[0].id, 4500);
    const tilted = dimensionPosition(plan, plan.walls[1]);
    expect(tilted.offset).toBe(-650);
    const a = plan.nodes.find(n => n.id === plan.walls[1].a)!;
    expect(Math.hypot(tilted.a.x - a.x, tilted.a.y - a.y)).toBeCloseTo(650);
    plan = moveWall(plan, plan.walls[1].id, { x: 200, y: 100 });
    const moved = dimensionPosition(plan, plan.walls[1]);
    expect(moved.label.x - tilted.label.x).toBeCloseTo(200);
    expect(moved.label.y - tilted.label.y).toBeCloseTo(100);
    plan = setWallThickness(plan, plan.walls[1].id, 300);
    expect(dimensionPosition(plan, plan.walls[1])).toEqual(moved);
    plan = toggleDimension(plan, plan.walls[1].id);
    plan = toggleDimension(plan, plan.walls[1].id);
    expect(plan.walls[1].dimensionOffset).toBe(-650);
  });

  it("preserves offsets on both segments when a wall is split at a junction", () => {
    const base = rectangle();
    let plan = setDimensionOffset(base, base.walls[0].id, -900);
    plan = addWall(plan, { x: 2000, y: 0 }, { x: 2000, y: 3000 }, 150);
    expect(plan.walls.filter(w => w.dimensionOffset === -900)).toHaveLength(2);
    expect(validatePlan(plan)).toEqual(plan);
  });

  it.each([NaN, Infinity, -Infinity, 100001, -100001, null, "500", undefined])("rejects an invalid imported offset %s", offset => {
    const plan = rectangle();
    const invalid = { ...plan, walls: [{ ...plan.walls[0], dimensionOffset: offset }, ...plan.walls.slice(1)] };
    expect(() => validatePlan(invalid)).toThrow(/Dimension offset/);
  });

  it("rejects invalid mutations and missing walls", () => {
    const plan = rectangle();
    expect(() => setDimensionOffset(plan, plan.walls[0].id, Infinity)).toThrow(/Dimension offset/);
    expect(() => setDimensionOffset(plan, plan.walls[0].id, -100001)).toThrow(/Dimension offset/);
    expect(() => setDimensionOffset(plan, "missing", 100)).toThrow(/no longer exists/);
  });

  it.each([0, 45, 90, 135, 180, -45, -90])("constrains a drag perpendicular to a %s degree wall", degrees => {
    const angle = degrees * Math.PI / 180;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: direction.x * 4000, y: direction.y * 4000 }, 150);
    const { axis, offset } = dimensionPosition(plan, plan.walls[0]);
    const start = { x: 240, y: 340 };
    const current = { x: start.x + axis.x * 600 + direction.x * 400, y: start.y + axis.y * 600 + direction.y * 400 };
    expect(draggedDimensionOffset(offset, axis, start, current)).toBeCloseTo(offset + 600);
    expect(draggedDimensionOffset(offset, axis, start, {
      x: start.x + direction.x * 700, y: start.y + direction.y * 700,
    })).toBeCloseTo(offset);
  });

  it("points extension lines toward the chosen side of the wall", () => {
    const plan = rectangle();
    const outside = dimensionPosition(plan, { ...plan.walls[0], dimensionOffset: -800 });
    const inside = dimensionPosition(plan, { ...plan.walls[0], dimensionOffset: 800 });
    expect(outside.normal.y).toBe(-1);
    expect(inside.normal.y).toBe(1);
  });
});
