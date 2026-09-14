import { describe, expect, it } from "vitest";
import {
  addAngleDimension, addOpening, addRoom, addWall, angleVertex, createEmptyPlan, detectRooms,
  distance, getGeometryIssues, moveNode, parseAngle, renameRoom, resizeAngle, setDimensionOffset, validatePlan, wallPoints, type Plan,
} from "./model";
import { anglePosition } from "./angles";

function annotate(plan: Plan, wallA = plan.walls[0].id, wallB = plan.walls[1].id, clockwise = true) {
  return addAngleDimension(plan, { wallA, wallB, vertex: angleVertex(plan, wallA, wallB).id, radius: 750, clockwise });
}

function corner(clockwise = true, reversed = false) {
  let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
  plan = addWall(plan, { x: 0, y: 0 }, { x: 0, y: 3000 }, 150);
  if (reversed) plan = validatePlan({ ...plan, walls: plan.walls.map(wall => ({ ...wall, a: wall.b, b: wall.a })) });
  return annotate(plan, plan.walls[0].id, plan.walls[1].id, clockwise);
}

describe("editing measured angles", () => {
  it.each([true, false])("preserves wall lengths and attachment with clockwise=%s", clockwise => {
    for (const reversed of [true, false]) {
      for (const degrees of [30, 60, 90, 112.5, 180, 225, 270, 359]) {
        let plan = corner(clockwise, reversed);
        const dimension = plan.angleDimensions![0];
        const wall = plan.walls.find(wall => wall.id === dimension.wallB)!;
        const vertex = plan.nodes.find(node => node.id === dimension.vertex)!;
        const movingEnd = wallPoints(plan, wall).find(node => node.id !== vertex.id)!;
        plan = addOpening(plan, wall.id, "window", 1500, 1000);
        plan = setDimensionOffset(plan, wall.id, -500);
        const before = JSON.stringify(plan);
        const moved = resizeAngle(plan, dimension.id, degrees);
        expect(anglePosition(moved, dimension).degrees).toBeCloseTo(degrees, 8);
        expect(distance(...wallPoints(moved, wall))).toBeCloseTo(3000, 8);
        expect(moved.nodes.filter(node => node.id !== movingEnd.id)).toEqual(plan.nodes.filter(node => node.id !== movingEnd.id));
        expect(moved.walls).toEqual(plan.walls);
        expect(moved.openings).toEqual(plan.openings);
        expect(moved.angleDimensions).toEqual(plan.angleDimensions);
        expect(JSON.stringify(plan)).toBe(before);
        expect(validatePlan(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
      }
    }
  });

  it("reshapes neighbors at the moved endpoint while preserving room identity", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Office");
    plan = annotate(plan, plan.walls[0].id, plan.walls[3].id);
    const dimension = plan.angleDimensions![0];
    const bottomWall = plan.walls[2];
    const moved = resizeAngle(plan, dimension.id, 80);
    const movingNode = moved.nodes.find(node => node.id === bottomWall.b)!;
    expect(movingNode.x).toBeCloseTo(3000 * Math.cos(80 * Math.PI / 180), 8);
    expect(movingNode.y).toBeCloseTo(3000 * Math.sin(80 * Math.PI / 180), 8);
    expect(detectRooms(moved)[0].id).toBe(detectRooms(plan)[0].id);
    expect(detectRooms(moved)[0].name).toBe("Office");
    expect(detectRooms(moved)[0].area).not.toBe(detectRooms(plan)[0].area);
    expect(distance(...wallPoints(moved, bottomWall))).not.toBe(distance(...wallPoints(plan, bottomWall)));
  });

  it("keeps no-op edits out of history, including fractional angles", () => {
    const plan = corner();
    const dimension = plan.angleDimensions![0];
    expect(resizeAngle(plan, dimension.id, 90)).toBe(plan);
    const fractional = resizeAngle(plan, dimension.id, 73.123456);
    expect(resizeAngle(fractional, dimension.id, anglePosition(fractional, dimension).degrees)).toBe(fractional);
  });

  it("persists rotations with crossing and opening-fit warnings without mutating input", () => {
    const room = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    let plan = annotate(room, room.walls[0].id, room.walls[3].id);
    const dimension = plan.angleDimensions![0];
    const before = JSON.stringify(plan);
    const crossing = resizeAngle(plan, dimension.id, 300);
    expect(anglePosition(crossing, dimension).degrees).toBeCloseTo(300);
    expect(getGeometryIssues(crossing)).toContainEqual(expect.objectContaining({ code: "wall-crossing" }));
    expect(detectRooms(crossing)).toEqual([]);
    expect(getGeometryIssues(resizeAngle(crossing, dimension.id, 90))).toEqual([]);
    expect(JSON.stringify(plan)).toBe(before);
    plan = addOpening(plan, plan.walls[2].id, "window", 3500, 800);
    const shortened = resizeAngle(plan, dimension.id, 80);
    expect(getGeometryIssues(shortened)).toContainEqual(expect.objectContaining({ code: "opening-outside" }));
    expect(shortened.openings).toEqual(plan.openings);
    expect(plan.nodes).toEqual(room.nodes);
  });

  it("warns about overlap with a third wall but rejects positions outside the drawing bounds", () => {
    let plan = corner();
    const dimension = plan.angleDimensions![0];
    plan = addWall(plan, { x: 0, y: 0 }, { x: -4000, y: 0 }, 150);
    const overlapping = resizeAngle(plan, dimension.id, 180);
    expect(getGeometryIssues(overlapping)).toContainEqual(expect.objectContaining({ code: "wall-overlap" }));
    expect(getGeometryIssues(resizeAngle(overlapping, dimension.id, 90))).toEqual([]);
    let edge = addWall(createEmptyPlan(), { x: 99000, y: 0 }, { x: 99000, y: 4000 }, 150);
    edge = addWall(edge, { x: 99000, y: 0 }, { x: 95000, y: 0 }, 150);
    edge = annotate(edge);
    expect(() => resizeAngle(edge, edge.angleDimensions![0].id, 270)).toThrow(/within 100 m/);
  });

  it.each(["wallA", "wallB"] as const)("rejects an undefined %s ray until its endpoint is repaired", reference => {
    const plan = corner();
    const dimension = plan.angleDimensions![0];
    const vertex = plan.nodes.find(node => node.id === dimension.vertex)!;
    const wall = plan.walls.find(wall => wall.id === dimension[reference])!;
    const end = wallPoints(plan, wall).find(node => node.id !== vertex.id)!;
    for (const length of [0, 0.5]) {
      const collapsed = moveNode(plan, end.id, { x: vertex.x + length, y: vertex.y });
      const before = JSON.stringify(collapsed);
      expect(getGeometryIssues(collapsed)).toContainEqual(expect.objectContaining({
        code: "undefined-angle", angleIds: [dimension.id],
      }));
      expect(() => resizeAngle(collapsed, dimension.id, 60)).toThrow(/angle is undefined/);
      expect(JSON.stringify(collapsed)).toBe(before);
      const repaired = moveNode(collapsed, end.id, end);
      expect(getGeometryIssues(repaired)).toEqual([]);
      expect(anglePosition(resizeAngle(repaired, dimension.id, 60), dimension).degrees).toBeCloseTo(60);
    }
  });

  it.each([0, -90, 360, 361, NaN, Infinity])("rejects invalid numeric angle %s", degrees => {
    const plan = corner();
    expect(() => resizeAngle(plan, plan.angleDimensions![0].id, degrees)).toThrow(/Angle must/);
  });

  it("reports missing angle measurements", () => {
    expect(() => resizeAngle(corner(), "missing", 60)).toThrow(/angle dimension no longer exists/);
  });
});

describe("degree input", () => {
  it.each([
    ["90", 90], [" 112.5 deg ", 112.5], ["270\u00b0", 270], ["45 degrees", 45],
    ["+75.25 DEGREE", 75.25], [".5", .5], ["180.", 180], ["359.9999", 359.9999],
  ])("parses %s", (text, degrees) => expect(parseAngle(text)).toBe(degrees));

  it.each(["", " ", "0", "-45", "360", "450", "NaN", "Infinity", "90foo", "90 deg x", "90 m", "1 rad", "1/2", "90 45", "9".repeat(121)])(
    "rejects invalid angle input %j", text => expect(() => parseAngle(text)).toThrow(),
  );
});
