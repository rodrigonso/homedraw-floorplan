import { describe, expect, it } from "vitest";
import { addWall, createEmptyPlan, moveNode, type AngleDimension } from "./model";
import { angleDimensionAt, anglePosition, formatAngle } from "./angles";

function corner(degrees = 90, rotation = 0) {
  const at = (angle: number) => ({
    x: Math.cos(angle * Math.PI / 180) * 4000, y: Math.sin(angle * Math.PI / 180) * 4000,
  });
  let plan = addWall(createEmptyPlan(), at(rotation), { x: 0, y: 0 }, 150);
  plan = addWall(plan, { x: 0, y: 0 }, at(rotation + degrees), 150);
  const position = at(rotation + degrees / 2);
  const dimension: AngleDimension = {
    ...angleDimensionAt(plan, plan.walls[0].id, plan.walls[1].id, position), id: "angle",
  };
  return { plan, dimension };
}

describe("angular dimensions", () => {
  it.each([30, 45, 90, 135, 180, 225, 270, 315])("measures the selected %s degree sector", degrees => {
    const { plan, dimension } = corner(degrees);
    const angle = anglePosition(plan, dimension);
    expect(angle.degrees).toBeCloseTo(degrees, 8);
    expect(anglePosition(plan, { ...dimension, clockwise: !dimension.clockwise }).degrees).toBeCloseTo(360 - degrees, 8);
    expect(angle.arc[0].x).toBeCloseTo(4000, 8);
    expect(angle.arc[0].y).toBeCloseTo(0, 8);
    for (const point of angle.arc) expect(Math.hypot(point.x, point.y)).toBeCloseTo(4000, 8);
    expect(angle.label.x).toBeCloseTo(Math.cos(degrees / 2 * Math.PI / 180) * 4000, 8);
    expect(angle.label.y).toBeCloseTo(Math.sin(degrees / 2 * Math.PI / 180) * 4000, 8);
  });

  it.each([-190, -90, 170, 300])("handles rotated rays across the angular branch cut at %s degrees", rotation => {
    const { plan, dimension } = corner(65, rotation);
    expect(anglePosition(plan, dimension).degrees).toBeCloseTo(65, 8);
    const reversed = { ...dimension, wallA: dimension.wallB, wallB: dimension.wallA, clockwise: !dimension.clockwise };
    const other = anglePosition(plan, reversed);
    expect(other.degrees).toBeCloseTo(65, 8);
    expect(other.label.x).toBeCloseTo(anglePosition(plan, dimension).label.x, 8);
    expect(other.label.y).toBeCloseTo(anglePosition(plan, dimension).label.y, 8);
  });

  it("chooses the outside angle from the placement point and bounds the minimum arc radius", () => {
    const { plan, dimension } = corner();
    const outside = angleDimensionAt(plan, dimension.wallA, dimension.wallB, { x: -600, y: -800 });
    expect(outside.radius).toBe(1000);
    expect(anglePosition(plan, { ...outside, id: "outside" }).degrees).toBeCloseTo(270);
    expect(angleDimensionAt(plan, dimension.wallA, dimension.wallB, { x: 1, y: 1 }).radius).toBe(100);
  });

  it("follows wall direction changes without changing radius or stored sector", () => {
    const { plan, dimension } = corner();
    const moved = moveNode(plan, plan.walls[1].b, { x: 2000, y: 2000 });
    const angle = anglePosition(moved, dimension);
    expect(angle.degrees).toBeCloseTo(45, 8);
    expect(Math.hypot(angle.label.x, angle.label.y)).toBeCloseTo(dimension.radius, 8);
  });

  it("formats readable degree labels in either measurement unit system", () => {
    expect(formatAngle(90)).toBe("90\u00b0");
    expect(formatAngle(123.456)).toBe("123.5\u00b0");
    expect(formatAngle(179.99999)).toBe("180\u00b0");
  });
});
