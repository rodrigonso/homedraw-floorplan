import { describe, expect, it } from "vitest";
import {
  addOpening, addRoom, addWall, createDemoPlan, createEmptyPlan, detectRooms, getGeometryIssues,
  moveNode, renameRoom, setDimensionOffset, validatePlan, wallPoints,
} from "./model";
import { dimensionPosition } from "./dimensions";
import { wallGeometry } from "./wallGeometry";

const rectangle = () => addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);

describe("moving wall junctions", () => {
  it("moves one shared corner without moving other endpoints or changing topology", () => {
    let plan = rectangle();
    const wall = plan.walls[0];
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Workshop");
    plan = addOpening(plan, wall.id, "window", 2000, 1000);
    plan = setDimensionOffset(plan, wall.id, -800);
    const before = JSON.stringify(plan);
    const moved = moveNode(plan, wall.b, { x: 4500, y: 500 });
    expect(moved.nodes.find(n => n.id === wall.b)).toEqual({ id: wall.b, x: 4500, y: 500 });
    expect(moved.nodes.filter(n => n.id !== wall.b)).toEqual(plan.nodes.filter(n => n.id !== wall.b));
    expect(moved.walls).toEqual(plan.walls);
    expect(moved.openings).toEqual(plan.openings);
    expect(moved.roomNames).toEqual(plan.roomNames);
    expect(detectRooms(moved)[0]).toMatchObject({ name: "Workshop", area: 11_750_000 });
    expect(dimensionPosition(moved, moved.walls[0]).offset).toBe(-800);
    expect(wallGeometry(moved).outlines).toHaveLength(2);
    expect(JSON.stringify(plan)).toBe(before);
    expect(validatePlan(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
  });

  it("updates all three walls at a T-junction and keeps their openings attached", () => {
    const plan = createDemoPlan();
    const node = plan.nodes.find(n => n.x === 4200 && n.y === 0)!;
    const connected = plan.walls.filter(w => w.a === node.id || w.b === node.id);
    expect(connected).toHaveLength(3);
    const moved = moveNode(plan, node.id, { x: 4450, y: 250 });
    for (const wall of connected) {
      expect(wallPoints(moved, wall)).toContainEqual({ id: node.id, x: 4450, y: 250 });
    }
    expect(moved.nodes.filter(n => n.id !== node.id)).toEqual(plan.nodes.filter(n => n.id !== node.id));
    expect(moved.openings).toEqual(plan.openings);
    expect(detectRooms(moved)).toHaveLength(2);
    expect(wallGeometry(moved).outlines).toHaveLength(3);
  });

  it("handles a free endpoint and no-op moves without introducing history-worthy changes", () => {
    const plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, 150);
    const node = plan.nodes[1];
    expect(moveNode(plan, node.id, node)).toBe(plan);
    const moved = moveNode(plan, node.id, { x: 3210.5, y: 470.25 });
    expect(moved.nodes[1]).toMatchObject({ x: 3210.5, y: 470.25 });
    expect(moved.nodes[0]).toEqual(plan.nodes[0]);
  });

  it("preserves distinct junction IDs when walls collapse and clears warnings on repair", () => {
    const plan = rectangle();
    const collapsed = moveNode(plan, plan.walls[0].b, { x: 0, y: 0 });
    expect(collapsed.nodes).toHaveLength(plan.nodes.length);
    expect(collapsed.walls).toEqual(plan.walls);
    expect(getGeometryIssues(collapsed).map(issue => issue.code))
      .toEqual(expect.arrayContaining(["short-wall", "coincident-nodes"]));
    expect(detectRooms(collapsed)).toEqual([]);
    const repaired = moveNode(collapsed, plan.walls[0].b, { x: 4000, y: 0 });
    expect(getGeometryIssues(repaired)).toEqual([]);
    expect(repaired).toEqual(plan);
    expect(detectRooms(repaired)).toHaveLength(1);
    const coincident = moveNode(plan, plan.walls[0].b, { x: 0, y: 3000 });
    expect(getGeometryIssues(coincident)).toContainEqual(expect.objectContaining({ code: "coincident-nodes" }));
    expect(detectRooms(coincident)).toEqual([]);
  });

  it("persists crossings immutably and permits repairing the same junction", () => {
    const plan = rectangle();
    const before = JSON.stringify(plan);
    const moved = moveNode(plan, plan.walls[0].b, { x: -1000, y: 1500 });
    expect(getGeometryIssues(moved)).toContainEqual(expect.objectContaining({ code: "wall-crossing" }));
    expect(detectRooms(moved)).toEqual([]);
    expect(getGeometryIssues(moveNode(moved, plan.walls[0].b, { x: 4000, y: 0 }))).toEqual([]);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("warns when node movements leave an attached opening outside its wall", () => {
    let plan = rectangle();
    plan = addOpening(plan, plan.walls[1].id, "door", 1200, 900);
    const moved = moveNode(plan, plan.walls[0].b, { x: 4000, y: 1800 });
    expect(moved.openings).toEqual(plan.openings);
    expect(getGeometryIssues(moved)).toContainEqual(expect.objectContaining({
      code: "opening-outside", wallIds: [plan.walls[1].id], openingIds: [plan.openings[0].id],
    }));
    expect(detectRooms(moved)).toHaveLength(1);
  });

  it.each([{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: -100001 }])("rejects an invalid position %j", position => {
    const plan = rectangle();
    expect(() => moveNode(plan, plan.nodes[0].id, position)).toThrow(/finite|within 100 m/);
  });

  it("reports a missing junction explicitly", () => {
    expect(() => moveNode(rectangle(), "missing", { x: 100, y: 100 })).toThrow(/junction no longer exists/);
  });
});
