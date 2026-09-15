import { describe, expect, it } from "vitest";
import {
  addAngleDimension, addOpening, addRoom, addWall, createDemoPlan, createEmptyPlan, detectRooms,
  distance, getGeometryIssues, moveNode, renameRoom, setDimensionOffset, splitWall, toggleDimension,
  validatePlan, wallPoints, type Plan,
} from "./model";
import { openingPoints } from "./geometryFeedback";
import { anglePosition } from "./angles";
import { wallGeometry } from "./wallGeometry";

const singleWall = () => addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);

describe("inserting a wall junction", () => {
  it.each([
    [{ x: 0, y: 0 }, { x: 4000, y: 0 }],
    [{ x: 1000, y: 4000 }, { x: 1000, y: 0 }],
    [{ x: -2000, y: -3000 }, { x: 1000, y: 1000 }],
    [{ x: 100000, y: 100000 }, { x: 97000, y: 96000 }],
  ])("splits %j to %j without moving the wall or losing its settings", (a, b) => {
    let plan = addWall(createEmptyPlan(), a, b, 230);
    const originalWall = plan.walls[0];
    plan = setDimensionOffset(plan, originalWall.id, -750);
    plan = toggleDimension(plan, originalWall.id);
    const before = JSON.stringify(plan);
    const offset = distance(a, b) * 0.3;
    const split = splitWall(plan, originalWall.id, offset);
    const node = split.nodes.at(-1)!;
    expect(split.nodes.slice(0, -1)).toEqual(plan.nodes);
    expect(split.walls).toHaveLength(2);
    expect(split.walls[0]).toEqual({ ...plan.walls[0], b: node.id });
    expect(split.walls[1]).toEqual({ ...plan.walls[0], id: expect.any(String), a: node.id });
    expect(split.walls[1].id).not.toBe(originalWall.id);
    expect(node.x).toBeCloseTo(a.x + (b.x - a.x) * 0.3, 6);
    expect(node.y).toBeCloseTo(a.y + (b.y - a.y) * 0.3, 6);
    expect(distance(...wallPoints(split, split.walls[0]))).toBeCloseTo(offset, 6);
    expect(distance(...wallPoints(split, split.walls[1]))).toBeCloseTo(distance(a, b) - offset, 6);
    expect(getGeometryIssues(split)).toEqual([]);
    expect(wallGeometry(split).outlines).toHaveLength(1);
    expect(validatePlan(JSON.parse(JSON.stringify(split)))).toEqual(split);
    expect(Object.hasOwn(split, "angleDimensions")).toBe(false);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("preserves every opening's world position, width, swing, order and identifier", () => {
    let plan = singleWall();
    const wall = plan.walls[0];
    for (const offset of [-500, 600, 2000, 3000, 4700]) {
      plan = addOpening(plan, wall.id, "window", offset, 900);
    }
    plan = addWall(plan, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, 180);
    plan = addOpening(plan, plan.walls[1].id, "door", 1500, 850);
    const split = splitWall(plan, wall.id, 2000);
    expect(split.openings.map(opening => opening.id)).toEqual(plan.openings.map(opening => opening.id));
    plan.openings.forEach((opening, i) => {
      const actual = split.openings[i];
      expect(actual).toMatchObject({ id: opening.id, width: opening.width, kind: opening.kind, flip: opening.flip });
      expect(openingPoints(split, actual)).toEqual(openingPoints(plan, opening));
    });
    expect(split.openings[0].offset).toBe(-500);
    expect(split.openings[2]).toMatchObject({ wallId: split.walls[1].id, offset: 0 });
    expect(split.openings[4].offset).toBe(2700);
    expect(split.openings[5]).toEqual(plan.openings[5]);
    expect(getGeometryIssues(split)).toContainEqual(expect.objectContaining({ code: "opening-outside" }));
  });

  it.each([false, true])("retargets angles at both original endpoints (reversed wall order: %s)", reversed => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const wall = plan.walls[0];
    for (const [neighbor, vertex] of [[plan.walls[3], wall.a], [plan.walls[1], wall.b]] as const) {
      plan = addAngleDimension(plan, {
        wallA: reversed ? neighbor.id : wall.id, wallB: reversed ? wall.id : neighbor.id,
        vertex, radius: 600, clockwise: true,
      });
    }
    const split = splitWall(plan, wall.id, 1700);
    expect(split.angleDimensions).toHaveLength(2);
    plan.angleDimensions!.forEach((angle, i) => {
      const next = split.angleDimensions![i];
      expect(next).toEqual({
        ...angle,
        [reversed ? "wallB" : "wallA"]: angle.vertex === wall.b ? split.walls[1].id : wall.id,
      });
      expect(anglePosition(split, next).degrees).toBeCloseTo(anglePosition(plan, angle).degrees, 8);
      expect(anglePosition(split, next).vertex).toEqual(anglePosition(plan, angle).vertex);
    });
    expect(getGeometryIssues(split)).toEqual([]);
  });

  it("keeps room names and areas on both sides of a partition and through repeated splits", () => {
    const plan = createDemoPlan();
    const partition = plan.walls.find(wall => wallPoints(plan, wall).every(node => node.x === 4200))!;
    const expected = detectRooms(plan).map(({ name, area }) => ({ name, area })).sort((a, b) => a.name.localeCompare(b.name));
    let split = splitWall(plan, partition.id, 2400);
    for (let i = 0; i < 5; i++) {
      split = splitWall(split, partition.id, distance(...wallPoints(split, split.walls.find(wall => wall.id === partition.id)!)) / 2);
      expect(detectRooms(split).map(({ name, area }) => ({ name, area })).sort((a, b) => a.name.localeCompare(b.name))).toEqual(expected);
      expect(Object.keys(split.roomNames)).toHaveLength(2);
    }
    expect(getGeometryIssues(split)).toEqual([]);
  });

  it("connects both new segments to a draggable node while retaining their room name", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Workshop");
    const split = splitWall(plan, plan.walls[0].id, 2000);
    const node = split.nodes.at(-1)!;
    const moved = moveNode(split, node.id, { x: 2000, y: -500 });
    expect(moved.nodes.filter(item => item.id !== node.id)).toEqual(plan.nodes);
    expect(moved.walls.filter(wall => wall.a === node.id || wall.b === node.id)).toHaveLength(2);
    expect(detectRooms(moved)[0]).toMatchObject({ name: "Workshop", area: 13_000_000 });
    expect(wallGeometry(moved).outlines).toHaveLength(2);
  });

  it("does not merge coincident geometry or invalidate overlapping angle rays", () => {
    const plan = validatePlan({
      ...createEmptyPlan(),
      nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 2000, y: 0 }],
      walls: [
        { id: "long", a: "a", b: "b", thickness: 150, dimension: true },
        { id: "short", a: "a", b: "c", thickness: 150, dimension: true },
      ],
      angleDimensions: [{ id: "angle", wallA: "long", wallB: "short", vertex: "a", radius: 500, clockwise: true }],
    });
    const split = splitWall(plan, "long", 2000);
    expect(split.nodes.at(-1)!.id).not.toBe("c");
    expect(split.angleDimensions).toEqual(plan.angleDimensions);
    expect(getGeometryIssues(split)).toContainEqual(expect.objectContaining({ code: "coincident-nodes" }));
    expect(wallGeometry(split).outlines.flat().every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0, 4000, 4001])("rejects an invalid split offset %s without changing the plan", offset => {
    const plan = singleWall();
    const before = JSON.stringify(plan);
    expect(() => splitWall(plan, plan.walls[0].id, offset)).toThrow(/finite|between/);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("reports missing and collapsed walls instead of inventing a direction", () => {
    const plan = singleWall();
    expect(() => splitWall(plan, "missing", 2000)).toThrow(/no longer exists/);
    const collapsed = moveNode(plan, plan.walls[0].b, plan.nodes[0]);
    expect(() => splitWall(collapsed, plan.walls[0].id, 0)).toThrow(/junctions apart/);
  });

  it("keeps short segments as warned geometry instead of discarding the split", () => {
    const plan = singleWall();
    const split = splitWall(plan, plan.walls[0].id, 0.5);
    expect(split.walls).toHaveLength(2);
    expect(getGeometryIssues(split)).toContainEqual(expect.objectContaining({ code: "short-wall" }));
  });

  it("retains structural collection limits", () => {
    const plan: Plan = {
      ...createEmptyPlan(),
      nodes: Array.from({ length: 1001 }, (_, i) => ({ id: `n${i}`, x: i, y: 0 })),
      walls: Array.from({ length: 1000 }, (_, i) => ({ id: `w${i}`, a: `n${i}`, b: `n${i + 1}`, thickness: 150, dimension: true })),
    };
    expect(() => splitWall(validatePlan(plan), "w0", 0.5)).toThrow(/walls/i);
  });
});
