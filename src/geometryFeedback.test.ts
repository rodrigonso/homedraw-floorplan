import { describe, expect, it } from "vitest";
import { addAngleDimension, addOpening, addWall, createEmptyPlan, getGeometryIssues, moveNode } from "./model";
import { geometryHighlights, openingPoints } from "./geometryFeedback";
import { wallGeometry } from "./wallGeometry";
import { dimensionPosition } from "./dimensions";
import { anglePosition, hasAngleGeometry } from "./angles";

describe("nonblocking geometry feedback", () => {
  it("highlights crossing walls without mutating or discarding their geometry", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
    plan = addWall(plan, { x: 2000, y: -1500 }, { x: 2000, y: 1500 }, 150);
    const before = JSON.stringify(plan);
    const highlights = geometryHighlights(plan, getGeometryIssues(plan));
    expect(highlights.filter(highlight => highlight.kind === "wall")).toHaveLength(2);
    expect(wallGeometry(plan).outlines.flat().every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("uses warning markers instead of undefined polygons and measurements for collapsed walls", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
    plan = addOpening(plan, plan.walls[0].id, "window", 1500, 1000);
    plan = moveNode(plan, plan.walls[0].b, { x: 0, y: 0 });
    expect(wallGeometry(plan)).toEqual({ fills: [], outlines: [] });
    expect(geometryHighlights(plan, getGeometryIssues(plan)).filter(highlight => highlight.kind === "node")).toHaveLength(2);
    expect(openingPoints(plan, plan.openings[0])).toBeNull();
    expect(() => dimensionPosition(plan, plan.walls[0])).toThrow(/junctions apart/);
    expect(plan.openings).toHaveLength(1);
  });

  it("preserves overhanging opening endpoints so they can be selected and corrected", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 1000, y: 0 }, 150);
    plan = addOpening(plan, plan.walls[0].id, "door", 1300, 800);
    expect(openingPoints(plan, plan.openings[0])).toEqual([{ x: 900, y: 0 }, { x: 1700, y: 0 }]);
    expect(geometryHighlights(plan, getGeometryIssues(plan)).some(highlight => highlight.kind === "opening")).toBe(true);
    const fixed = moveNode(plan, plan.walls[0].b, { x: 2000, y: 0 });
    expect(geometryHighlights(fixed, getGeometryIssues(fixed))).toEqual([]);
  });

  it("retains undefined angle annotations and restores them after the junction is repaired", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
    plan = addWall(plan, { x: 0, y: 0 }, { x: 0, y: 3000 }, 150);
    plan = addAngleDimension(plan, {
      wallA: plan.walls[0].id, wallB: plan.walls[1].id, vertex: plan.walls[0].a, radius: 500, clockwise: true,
    });
    const angle = plan.angleDimensions![0];
    const collapsed = moveNode(plan, plan.walls[0].b, { x: 0, y: 0 });
    expect(hasAngleGeometry(collapsed, angle)).toBe(false);
    expect(() => anglePosition(collapsed, angle)).toThrow(/junctions apart/);
    expect(geometryHighlights(collapsed, getGeometryIssues(collapsed)).some(highlight => highlight.kind === "angle")).toBe(true);
    const repaired = moveNode(collapsed, plan.walls[0].b, { x: 4000, y: 0 });
    expect(hasAngleGeometry(repaired, angle)).toBe(true);
    expect(anglePosition(repaired, angle).degrees).toBe(90);
  });
});
