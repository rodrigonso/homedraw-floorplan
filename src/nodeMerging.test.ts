import { describe, expect, it } from "vitest";
import {
  addAngleDimension, addOpening, addRoom, addWall, createEmptyPlan, detectRooms, getGeometryIssues,
  mergeNodes, moveNode, renameRoom, splitWall, validatePlan, type Plan,
} from "./model";
import { wallGeometry } from "./wallGeometry";

const openRoom = (): Plan => validatePlan({
  ...createEmptyPlan(),
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 },
    { id: "d", x: 0, y: 3000 }, { id: "loose", x: 0, y: 600 },
  ],
  walls: [
    { id: "top", a: "a", b: "b", thickness: 150, dimension: true, dimensionOffset: -500 },
    { id: "right", a: "b", b: "c", thickness: 150, dimension: true },
    { id: "bottom", a: "c", b: "d", thickness: 150, dimension: true },
    { id: "left", a: "d", b: "loose", thickness: 150, dimension: false, dimensionOffset: 750 },
  ],
});

describe("combining wall junctions", () => {
  it("closes an open room while retaining wall settings, openings and other endpoint positions", () => {
    let plan = addOpening(openRoom(), "left", "door", 1000, 800);
    plan = validatePlan({ ...plan, openings: [{ ...plan.openings[0], flip: true, hingeAtEnd: true }] });
    const before = JSON.stringify(plan);
    expect(detectRooms(plan)).toEqual([]);
    const merged = mergeNodes(plan, "loose", "a");
    expect(merged.nodes).toEqual(plan.nodes.filter(node => node.id !== "loose"));
    expect(merged.walls).toEqual(plan.walls.map(wall => wall.id === "left" ? { ...wall, b: "a" } : wall));
    expect(merged.openings).toEqual(plan.openings);
    expect(detectRooms(merged)).toMatchObject([{ area: 12_000_000 }]);
    expect(getGeometryIssues(merged)).toEqual([]);
    expect(wallGeometry(merged).outlines).toHaveLength(2);
    expect(validatePlan(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("reattaches all walls at a junction and retargets angles without moving the target", () => {
    const plan = validatePlan({
      ...openRoom(),
      nodes: [...openRoom().nodes, { id: "end", x: -2000, y: 600 }, { id: "other", x: -1000, y: 2000 }],
      walls: [...openRoom().walls,
        { id: "branch", a: "loose", b: "end", thickness: 200, dimension: true },
        { id: "spur", a: "other", b: "loose", thickness: 100, dimension: true }],
      angleDimensions: [
        { id: "source-angle", wallA: "left", wallB: "branch", vertex: "loose", radius: 500, clockwise: true },
        { id: "outer-angle", wallA: "left", wallB: "bottom", vertex: "d", radius: 600, clockwise: false },
        { id: "target-angle", wallA: "top", wallB: "right", vertex: "b", radius: 700, clockwise: true },
      ],
    });
    const next = mergeNodes(plan, "loose", "a");
    expect(next.nodes).toEqual(plan.nodes.filter(node => node.id !== "loose"));
    expect(next.walls.filter(wall => wall.a === "a" || wall.b === "a")).toHaveLength(4);
    expect(next.angleDimensions).toEqual(plan.angleDimensions!.map(angle =>
      angle.vertex === "loose" ? { ...angle, vertex: "a" } : angle));
    expect(validatePlan(next)).toEqual(next);
  });

  it("removes only self-loop walls and their dependent openings and angle measurements", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const [top, right, bottom] = plan.walls;
    plan = addOpening(plan, top.id, "window", 2000, 900);
    plan = addOpening(plan, right.id, "door", 1500, 800);
    plan = addAngleDimension(plan, { wallA: top.id, wallB: right.id, vertex: top.b, radius: 500, clockwise: true });
    plan = addAngleDimension(plan, { wallA: right.id, wallB: bottom.id, vertex: right.b, radius: 500, clockwise: true });
    const next = mergeNodes(plan, top.b, top.a);
    expect(next.walls.map(wall => wall.id)).toEqual(plan.walls.slice(1).map(wall => wall.id));
    expect(next.openings).toEqual(plan.openings.slice(1));
    expect(next.angleDimensions).toEqual(plan.angleDimensions!.slice(1));
    expect(detectRooms(next)[0].area).toBe(6_000_000);
    expect(getGeometryIssues(next)).toEqual([]);
  });

  it("can collapse the last wall to an empty plan without leaving unused nodes", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, 150);
    plan = addOpening(plan, plan.walls[0].id, "window", 1000, 700);
    expect(mergeNodes(plan, plan.nodes[0].id, plan.nodes[1].id)).toEqual(createEmptyPlan());
  });

  it("retains duplicate walls as editable warnings but removes ambiguous angles", () => {
    const plan = validatePlan({
      ...createEmptyPlan(),
      nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 3000, y: 0 }, { id: "c", x: 0, y: 3000 }],
      walls: [
        { id: "first", a: "a", b: "b", thickness: 150, dimension: true },
        { id: "second", a: "c", b: "a", thickness: 200, dimension: false },
      ],
      openings: [{ id: "door", wallId: "second", kind: "door", offset: 1000, width: 800, flip: false }],
      angleDimensions: [{ id: "angle", wallA: "first", wallB: "second", vertex: "a", radius: 500, clockwise: true }],
    });
    const next = mergeNodes(plan, "b", "c");
    expect(next.walls).toHaveLength(2);
    expect(next.openings).toEqual(plan.openings);
    expect(next.angleDimensions).toEqual([]);
    expect(getGeometryIssues(next)).toContainEqual(expect.objectContaining({ code: "wall-overlap" }));
    expect(wallGeometry(next).outlines.length).toBeGreaterThan(0);
  });

  for (const coincident of [false, true]) it(`preserves named rooms when combining an inserted node, coincident=${coincident}`, () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Studio");
    const target = plan.nodes.find(node => node.id === plan.walls[0].a)!;
    plan = splitWall(plan, plan.walls[0].id, 1000);
    const source = plan.nodes.at(-1)!;
    if (coincident) plan = moveNode(plan, source.id, target);
    const next = mergeNodes(plan, source.id, target.id);
    expect(detectRooms(next)).toMatchObject([{ name: "Studio", area: 12_000_000 }]);
    expect(Object.keys(next.roomNames)).toEqual([detectRooms(next)[0].id]);
    expect(getGeometryIssues(next)).toEqual([]);
  });

  it("preserves unrelated room names and does not overwrite an existing target room name", () => {
    let plan = openRoom();
    plan = validatePlan({ ...plan, roomNames: {
      "room:a:b:c:d": "Existing name", "room:a:b:c:d:loose": "Historical name", "room:x:y:z": "Other room",
    } });
    const next = mergeNodes(plan, "loose", "a");
    expect(next.roomNames).toEqual({ "room:a:b:c:d": "Existing name", "room:x:y:z": "Other room" });
  });

  it("keeps no-op merges unchanged and reports missing nodes explicitly", () => {
    const plan = openRoom(), before = JSON.stringify(plan);
    expect(mergeNodes(plan, "a", "a")).toBe(plan);
    expect(() => mergeNodes(plan, "missing", "a")).toThrow(/selected junction no longer exists/);
    expect(() => mergeNodes(plan, "a", "missing")).toThrow(/target junction no longer exists/);
    expect(JSON.stringify(plan)).toBe(before);
  });
});
