import { describe, expect, it } from "vitest";
import {
  addOpening, addRoom, addWall, createDemoPlan, createEmptyPlan, deleteOpening, deleteWall,
  detectRooms, distance, formatArea, formatLength, getGeometryIssues, isWallDegenerate, moveNode, moveWall, parseLength, parsePosition, projectToWall,
  renameRoom, resizeWall, setWallThickness, snapPoint, toggleDimension, updateOpening,
  validatePlan, wallPoints,
  type Plan, type Point, type Wall,
} from "./model";

const p = (x: number, y: number): Point => ({ x, y });
const rectangle = () => addRoom(createEmptyPlan(), p(0, 0), p(4_000, 3_000), 150);
const singleWall = () => addWall(createEmptyPlan(), p(0, 0), p(4_000, 0), 150);
const firstWall = (plan: Plan): Wall => plan.walls[0]!;
const wallFrom = (plan: Plan, a: Point, b: Point): Wall => {
  const wall = plan.walls.find(wall => {
    const [start, end] = wallPoints(plan, wall);
    return (distance(start, a) < 1e-6 && distance(end, b) < 1e-6) ||
      (distance(start, b) < 1e-6 && distance(end, a) < 1e-6);
  });
  if (!wall) throw new Error("Test wall not found");
  return wall;
};
const clone = (plan: Plan): Plan => JSON.parse(JSON.stringify(plan)) as Plan;

describe("rooms and connected wall construction", () => {
  it("starts with a valid, persistable empty plan and no rooms", () => {
    const plan = createEmptyPlan();
    expect(validatePlan(plan)).toEqual(plan);
    expect(detectRooms(plan)).toEqual([]);
    expect(plan.nodes).toEqual([]);
  });

  it("detects one exact rectangle, excluding the exterior face", () => {
    const plan = rectangle();
    expect(plan.nodes).toHaveLength(4);
    expect(plan.walls).toHaveLength(4);
    expect(plan.walls.every(wall => wall.dimension)).toBe(true);
    const rooms = detectRooms(plan);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ area: 12_000_000, center: p(2_000, 1_500), name: "Room" });
    expect(rooms[0]!.points).toHaveLength(4);
    expect(rooms[0]!.nodeIds.every(nodeId => plan.nodes.some(node => node.id === nodeId))).toBe(true);
  });

  it("normalizes reversed rectangle corners", () => {
    const plan = addRoom(createEmptyPlan(), p(4_000, 3_000), p(0, 0), 150);
    expect(detectRooms(plan)[0]!.area).toBe(12_000_000);
  });

  it("reuses the shared boundary when adding an adjacent room", () => {
    const original = rectangle();
    const shared = wallFrom(original, p(4_000, 0), p(4_000, 3_000));
    const next = addRoom(original, p(4_000, 0), p(6_000, 3_000), 120);
    expect(next.nodes).toHaveLength(6);
    expect(next.walls).toHaveLength(7);
    expect(next.walls.find(wall => wall.id === shared.id)).toEqual(shared);
    expect(detectRooms(next).map(room => room.area).sort((a, b) => a - b)).toEqual([6_000_000, 12_000_000]);
    expect(original.nodes).toHaveLength(4);
    expect(original.walls).toHaveLength(4);
  });

  it("splits and reuses a partially shared boundary", () => {
    const next = addRoom(rectangle(), p(4_000, 1_000), p(6_000, 2_000), 150);
    expect(next.nodes).toHaveLength(8);
    expect(next.walls).toHaveLength(9);
    expect(detectRooms(next).map(room => room.area).sort((a, b) => a - b)).toEqual([2_000_000, 12_000_000]);
    expect(wallFrom(next, p(4_000, 1_000), p(4_000, 2_000))).toBeDefined();
  });

  it("splits an existing wall at a new endpoint into a connected T junction", () => {
    const original = singleWall();
    const snapshot = clone(original);
    const next = addWall(original, p(2_000, 0), p(2_000, 2_000), 100);
    expect(next.nodes).toHaveLength(4);
    expect(next.walls).toHaveLength(3);
    const junction = next.nodes.find(node => node.x === 2_000 && node.y === 0)!;
    expect(next.walls.filter(wall => wall.a === junction.id || wall.b === junction.id)).toHaveLength(3);
    expect(detectRooms(next)).toEqual([]);
    expect(original).toEqual(snapshot);
  });

  it("splits both boundaries when drawing a partition", () => {
    const next = addWall(rectangle(), p(2_000, 0), p(2_000, 3_000), 100);
    expect(next.nodes).toHaveLength(6);
    expect(next.walls).toHaveLength(7);
    expect(detectRooms(next).map(room => room.area)).toEqual([6_000_000, 6_000_000]);
  });

  it("splits a new wall at an existing junction along its interior", () => {
    const initial = addWall(createEmptyPlan(), p(2_000, 0), p(2_000, 2_000), 100);
    const next = addWall(initial, p(0, 0), p(4_000, 0), 150);
    expect(next.walls).toHaveLength(3);
    expect(next.nodes).toHaveLength(4);
    expect(validatePlan(next)).toEqual(next);
  });

  it("persists duplicate, overlapping, collapsed, and crossing walls with warnings", () => {
    const plan = singleWall();
    const duplicate = addWall(plan, p(4_000, 0), p(0, 0), 150);
    expect(duplicate.walls).toHaveLength(2);
    expect(getGeometryIssues(duplicate)).toContainEqual(expect.objectContaining({
      code: "wall-overlap", wallIds: expect.arrayContaining(duplicate.walls.map(wall => wall.id)),
    }));
    expect(getGeometryIssues(addWall(plan, p(2_000, 0), p(5_000, 0), 150)))
      .toContainEqual(expect.objectContaining({ code: "wall-overlap" }));
    const collapsed = addWall(plan, p(0, 0), p(0, 0), 150);
    expect(collapsed.walls).toHaveLength(2);
    expect(collapsed.walls[1]!.a).not.toBe(collapsed.walls[1]!.b);
    expect(getGeometryIssues(collapsed).map(issue => issue.code)).toEqual(expect.arrayContaining(["short-wall", "coincident-nodes"]));
    const crossing = addWall(plan, p(2_000, -1_000), p(2_000, 1_000), 150);
    expect(crossing.walls).toHaveLength(2);
    expect(crossing.nodes).toHaveLength(4);
    expect(crossing.nodes.some(node => node.x === 2_000 && node.y === 0)).toBe(false);
    expect(getGeometryIssues(crossing)).toContainEqual(expect.objectContaining({ code: "wall-crossing" }));
    for (const accepted of [duplicate, collapsed, crossing]) expect(validatePlan(clone(accepted))).toEqual(accepted);
    expect(() => addRoom(plan, p(0, 0), p(4_000, 0), 150)).toThrow(/wide/);
    expect(() => addRoom(rectangle(), p(0, 0), p(4_000, 3_000), 150)).toThrow(/already exists/);
  });

  it("preserves input while adding a room that crosses existing geometry", () => {
    const original = addWall(createEmptyPlan(), p(3_000, 1_000), p(5_000, 1_000), 100);
    const snapshot = clone(original);
    const next = addRoom(original, p(0, 0), p(4_000, 3_000), 150);
    expect(next.walls).toHaveLength(5);
    expect(getGeometryIssues(next)).toContainEqual(expect.objectContaining({ code: "wall-crossing" }));
    expect(detectRooms(next)).toEqual([]);
    expect(original).toEqual(snapshot);
  });

  it("detects concave rooms with a polygon centroid, not a bounding-box center", () => {
    let plan = createEmptyPlan();
    const points = [p(0, 0), p(4_000, 0), p(4_000, 1_000), p(1_000, 1_000), p(1_000, 3_000), p(0, 3_000)];
    for (let i = 0; i < points.length; i++) plan = addWall(plan, points[i]!, points[(i + 1) % points.length]!, 100);
    const room = detectRooms(plan)[0]!;
    expect(room.area).toBe(6_000_000);
    expect(room.center.x).toBeCloseTo(1_500);
    expect(room.center.y).toBeCloseTo(1_000);
  });

  it("handles open branches and separate components without inventing rooms", () => {
    let plan = addWall(rectangle(), p(0, 0), p(-1_000, -1_000), 100);
    plan = addWall(plan, p(2_000, 0), p(2_000, 1_000), 100);
    plan = addWall(plan, p(10_000, 10_000), p(11_000, 10_000), 100);
    expect(detectRooms(plan)).toHaveLength(1);
    expect(detectRooms(plan)[0]!.area).toBe(12_000_000);
    plan = addRoom(plan, p(6_000, 0), p(8_000, 2_000), 150);
    expect(detectRooms(plan).map(room => room.area).sort((a, b) => a - b)).toEqual([4_000_000, 12_000_000]);
  });

  it("has stable room identifiers regardless of wall order, directions, or movement", () => {
    let plan = rectangle();
    const roomId = detectRooms(plan)[0]!.id;
    plan = renameRoom(plan, roomId, "  Studio  ");
    const reordered = { ...plan, walls: [...plan.walls].reverse().map(wall => ({ ...wall, a: wall.b, b: wall.a })) };
    expect(detectRooms(reordered)[0]!.id).toBe(roomId);
    const moved = moveWall(plan, firstWall(plan).id, p(0, -500));
    expect(detectRooms(moved)[0]).toMatchObject({ id: roomId, name: "Studio", area: 14_000_000 });
    expect(() => renameRoom(plan, roomId, " ")).toThrow(/name/i);
    expect(() => renameRoom(plan, "missing", "Studio")).toThrow(/no longer enclosed/);
  });

  it("provides a complete two-room demo", () => {
    const plan = createDemoPlan();
    expect(validatePlan(clone(plan))).toEqual(plan);
    expect(plan.walls).toHaveLength(7);
    expect(plan.openings).toHaveLength(5);
    expect(Math.max(...plan.nodes.map(node => node.x))).toBe(6_800);
    expect(Math.max(...plan.nodes.map(node => node.y))).toBe(4_800);
    expect(detectRooms(plan).map(room => room.name).sort()).toEqual(["Kitchen", "Living room"]);
    expect(detectRooms(plan).reduce((total, room) => total + room.area, 0)).toBe(32_640_000);
    expect(plan.walls.filter(wall => wall.dimension)).toHaveLength(6);
    const clearOuterWall = wallFrom(plan, p(0, 4_800), p(4_200, 4_800));
    expect(distance(...wallPoints(plan, clearOuterWall))).toBeGreaterThan(1_200);
    expect(plan.openings.some(opening => opening.wallId === clearOuterWall.id)).toBe(false);
    expect(clearOuterWall.dimension).toBe(true);
  });
});

describe("attached openings", () => {
  it("stores absolute center offsets, edits immutably, and deletes", () => {
    const original = singleWall();
    const wall = firstWall(original);
    const added = addOpening(original, wall.id, "door", 1_500, 900);
    const opening = added.openings[0]!;
    expect(opening).toMatchObject({ wallId: wall.id, kind: "door", offset: 1_500, width: 900, flip: false });
    const updated = updateOpening(added, opening.id, { width: 1_000, offset: 2_000, flip: true });
    expect(updated.openings[0]).toMatchObject({ width: 1_000, offset: 2_000, flip: true });
    expect(added.openings[0]).toEqual(opening);
    expect(original.openings).toEqual([]);
    expect(deleteOpening(updated, opening.id).openings).toEqual([]);
  });

  it("warns about out-of-bounds and overlapping openings, allowing touching edges", () => {
    const base = singleWall();
    const wallId = firstWall(base).id;
    const plan = addOpening(base, wallId, "window", 1_000, 1_000);
    expect(getGeometryIssues(addOpening(plan, wallId, "door", 1_600, 900)))
      .toContainEqual(expect.objectContaining({ code: "opening-overlap" }));
    for (const offset of [200, 3_800]) {
      expect(getGeometryIssues(addOpening(plan, wallId, "door", offset, 900)))
        .toContainEqual(expect.objectContaining({ code: "opening-outside" }));
    }
    expect(() => addOpening(plan, wallId, "door", 2_000, 0)).toThrow(/at least 1 mm/);
    expect(() => updateOpening(plan, plan.openings[0]!.id, { width: Infinity })).toThrow(/finite/);
    expect(getGeometryIssues(updateOpening(plan, plan.openings[0]!.id, { offset: -1 })))
      .toContainEqual(expect.objectContaining({ code: "opening-outside" }));
    expect(getGeometryIssues(addOpening(plan, wallId, "door", 2_000, 1_000))).toEqual([]);
    expect(getGeometryIssues(addOpening(base, wallId, "window", 2_000, 4_000))).toEqual([]);
  });

  it("reassigns openings and center offsets when a wall splits", () => {
    let plan = singleWall();
    const originalWall = firstWall(plan);
    plan = addOpening(plan, originalWall.id, "window", 750, 500);
    plan = addOpening(plan, originalWall.id, "door", 3_000, 900);
    const originalOpenings = structuredClone(plan.openings);
    const next = addWall(plan, p(2_000, 0), p(2_000, 2_000), 100);
    const before = wallFrom(next, p(0, 0), p(2_000, 0));
    const after = wallFrom(next, p(2_000, 0), p(4_000, 0));
    expect(before.id).toBe(originalWall.id);
    expect(next.openings.find(opening => opening.kind === "window")).toMatchObject({ wallId: before.id, offset: 750 });
    expect(next.openings.find(opening => opening.kind === "door")).toMatchObject({ wallId: after.id, offset: 1_000 });
    expect(next.openings.map(opening => opening.id).sort()).toEqual(originalOpenings.map(opening => opening.id).sort());
    expect(plan.openings).toEqual(originalOpenings);
  });

  it("retains a split-through opening with a warning, but does not warn at its edge", () => {
    const original = singleWall();
    const plan = addOpening(original, firstWall(original).id, "door", 2_000, 1_000);
    const split = addWall(plan, p(2_000, 0), p(2_000, 2_000), 100);
    expect(split.openings).toHaveLength(1);
    expect(split.openings[0]).toMatchObject({ id: plan.openings[0]!.id, offset: 0, width: 1_000 });
    expect(getGeometryIssues(split)).toContainEqual(expect.objectContaining({
      code: "opening-outside", openingIds: [plan.openings[0]!.id],
    }));
    const next = addWall(plan, p(1_500, 0), p(1_500, 2_000), 100);
    expect(next.openings[0]).toMatchObject({ offset: 500, width: 1_000 });
    expect(getGeometryIssues(next)).toEqual([]);
  });

  it("preserves an opening in the reused portion of an adjacent room boundary", () => {
    let plan = rectangle();
    const wall = wallFrom(plan, p(4_000, 0), p(4_000, 3_000));
    plan = addOpening(plan, wall.id, "door", 1_500, 800);
    const next = addRoom(plan, p(4_000, 1_000), p(6_000, 2_000), 150);
    const shared = wallFrom(next, p(4_000, 1_000), p(4_000, 2_000));
    expect(next.openings[0]).toMatchObject({ wallId: shared.id, offset: 500, width: 800 });
  });

  it("assigns every opening once by center, including centers beyond either end and on cuts", () => {
    let plan = singleWall();
    const wallId = firstWall(plan).id;
    for (const offset of [-500, 0, 1_000, 2_000, 3_000, 4_000, 4_500]) {
      plan = addOpening(plan, wallId, "window", offset, 200);
    }
    const before = clone(plan);
    const unrelated = addWall(plan, p(10_000, 0), p(11_000, 0), 100);
    expect(unrelated.openings).toEqual(plan.openings);
    const split = addWall(plan, p(1_000, 0), p(3_000, 0), 100);
    expect(split.openings.map(opening => opening.id)).toEqual(plan.openings.map(opening => opening.id));
    for (const opening of split.openings) {
      const wall = split.walls.find(wall => wall.id === opening.wallId)!;
      const [start] = wallPoints(split, wall);
      const original = plan.openings.find(item => item.id === opening.id)!;
      expect(start.x + opening.offset).toBe(original.offset);
    }
    const first = wallFrom(split, p(0, 0), p(1_000, 0));
    const last = wallFrom(split, p(3_000, 0), p(4_000, 0));
    expect(split.openings[0]).toMatchObject({ wallId: first.id, offset: -500 });
    expect(split.openings[2]).toMatchObject({ offset: 0 });
    expect(split.openings[4]).toMatchObject({ wallId: last.id, offset: 0 });
    expect(split.openings[6]).toMatchObject({ wallId: last.id, offset: 1_500 });
    expect(getGeometryIssues(split).find(issue => issue.code === "opening-outside")!.openingIds).toHaveLength(6);
    expect(plan).toEqual(before);
  });

  it("flags all nested overlaps and clears opening warnings on repair", () => {
    let plan = singleWall();
    const wallId = firstWall(plan).id;
    plan = addOpening(plan, wallId, "window", 2_000, 4_000);
    plan = addOpening(plan, wallId, "door", 1_000, 100);
    plan = addOpening(plan, wallId, "door", 3_000, 100);
    const issues = getGeometryIssues(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "opening-overlap", wallIds: [wallId] });
    expect(issues[0]!.openingIds.sort()).toEqual(plan.openings.map(opening => opening.id).sort());
    const repaired = updateOpening(plan, plan.openings[0]!.id, { width: 100 });
    expect(getGeometryIssues(repaired)).toEqual([]);
    const outside = updateOpening(repaired, repaired.openings[0]!.id, { offset: -100 });
    expect(getGeometryIssues(outside)).toHaveLength(1);
    expect(getGeometryIssues(deleteOpening(outside, outside.openings[0]!.id))).toEqual([]);
  });
});

describe("derived geometry warnings", () => {
  it("aggregates dense conflicts by code without changing persisted data or sharing warning arrays", () => {
    const plan = singleWall();
    plan.walls = Array.from({ length: 1_000 }, (_, index) => ({ ...firstWall(plan), id: `wall-${index}` }));
    const before = JSON.stringify(plan);
    const issues = getGeometryIssues(plan);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "wall-overlap", openingIds: [], angleIds: [], nodeIds: plan.nodes.map(node => node.id),
    });
    expect(issues[0]!.wallIds).toHaveLength(1_000);
    expect(issues[0]!.message).not.toBe("");
    issues[0]!.wallIds.length = 0;
    expect(getGeometryIssues(plan)[0]!.wallIds).toHaveLength(1_000);
    expect(JSON.stringify(plan)).toBe(before);
    expect(JSON.stringify(validatePlan(plan))).toBe(before);
    expect(Object.hasOwn(plan, "geometryIssues")).toBe(false);
  });

  it("includes every coincident junction and its incident walls", () => {
    let plan = addWall(createEmptyPlan(), p(0, 0), p(0, 0), 100);
    plan = addWall(plan, p(0, 0), p(0, 0), 100);
    const issue = getGeometryIssues(plan).find(issue => issue.code === "coincident-nodes")!;
    expect(issue.nodeIds.sort()).toEqual(plan.nodes.map(node => node.id).sort());
    expect(issue.wallIds.sort()).toEqual(plan.walls.map(wall => wall.id).sort());
    expect(plan.nodes).toHaveLength(3);
    expect(detectRooms(plan)).toEqual([]);
  });

  it("keeps invalid drawings editable through unrelated changes and deletion", () => {
    const base = singleWall();
    const crossed = addWall(base, p(2_000, -1_000), p(2_000, 1_000), 100);
    const crossingWall = crossed.walls[1]!;
    const extended = addWall(crossed, p(10_000, 0), p(11_000, 0), 150);
    const changed = toggleDimension(setWallThickness(extended, extended.walls[2]!.id, 200), firstWall(extended).id);
    expect(getGeometryIssues(changed)).toContainEqual(expect.objectContaining({ code: "wall-crossing" }));
    const deleted = deleteWall(changed, changed.walls[2]!.id);
    expect(deleted.walls).toHaveLength(2);
    expect(getGeometryIssues(deleted)).toHaveLength(1);
    expect(getGeometryIssues(moveWall(deleted, crossingWall.id, p(3_000, 0)))).toEqual([]);
    expect(getGeometryIssues(deleteWall(deleted, crossingWall.id))).toEqual([]);
    const duplicate = addWall(base, p(0, 0), p(4_000, 0), 100);
    expect(getGeometryIssues(deleteWall(duplicate, duplicate.walls[1]!.id))).toEqual([]);
  });

  it("preserves zero and short walls while inserting further geometry without accidental zero segments", () => {
    let plan = addWall(createEmptyPlan(), p(2_000, 0), p(2_000, 0), 100);
    const collapsed = firstWall(plan);
    plan = addOpening(plan, collapsed.id, "door", -100, 200);
    const next = addWall(plan, p(0, 0), p(4_000, 0), 150);
    expect(next.walls).toHaveLength(3);
    expect(next.walls.filter(wall => isWallDegenerate(next, wall)).map(wall => wall.id)).toEqual([collapsed.id]);
    expect(next.openings).toEqual(plan.openings);
    expect(next.walls.every(wall => wall.a !== wall.b)).toBe(true);
    expect(validatePlan(next)).toEqual(next);
    const atInterior = addWall(singleWall(), p(2_000, 0), p(2_000, 0), 100);
    expect(atInterior.walls).toHaveLength(3);
    expect(atInterior.walls.filter(wall => isWallDegenerate(atInterior, wall))).toHaveLength(1);
    const short = addWall(createEmptyPlan(), p(0, 0), p(0.5, 0), 100);
    expect(isWallDegenerate(short, firstWall(short))).toBe(true);
    expect(addWall(short, p(2_000, 0), p(3_000, 0), 100).walls).toHaveLength(2);
    expect(() => resizeWall(short, firstWall(short).id, 2_000)).toThrow(/shorter than 1 mm/);
    expect(() => resizeWall(plan, collapsed.id, 2_000)).toThrow(/shorter than 1 mm/);
    const repaired = moveNode(short, firstWall(short).b, p(1, 0));
    expect(isWallDegenerate(repaired, firstWall(repaired))).toBe(false);
    expect(getGeometryIssues(repaired)).toEqual([]);
  });

  it("suppresses only conflicted room boundaries and ignores opening warnings for areas", () => {
    const two = addRoom(rectangle(), p(6_000, 0), p(8_000, 2_000), 150);
    const originalRooms = detectRooms(two);
    const duplicate = addWall(two, p(0, 0), p(4_000, 0), 100);
    const issues = getGeometryIssues(duplicate);
    expect(detectRooms(duplicate, issues)).toEqual(detectRooms(duplicate));
    expect(detectRooms(duplicate).map(room => room.area)).toEqual([4_000_000]);
    const crossing = addWall(two, p(2_000, -1_000), p(2_000, 1_000), 100);
    expect(detectRooms(crossing).map(room => room.area)).toEqual([4_000_000]);
    const collapsed = moveNode(two, firstWall(two).b, p(0, 0));
    expect(detectRooms(collapsed).map(room => room.area)).toEqual([4_000_000]);
    let openings = addOpening(two, firstWall(two).id, "window", -100, 500);
    openings = addOpening(openings, firstWall(two).id, "door", 0, 500);
    expect(getGeometryIssues(openings).map(issue => issue.code)).toEqual(["opening-outside", "opening-overlap"]);
    expect(detectRooms(openings)).toEqual(originalRooms);
  });

  it("does not invent a merged face by dropping an invalid partition from the graph", () => {
    const divided = addWall(rectangle(), p(2_000, 0), p(2_000, 3_000), 100);
    expect(detectRooms(divided)).toHaveLength(2);
    const conflicted = addWall(divided, p(1_500, 1_500), p(2_500, 1_500), 100);
    expect(getGeometryIssues(conflicted)).toHaveLength(1);
    expect(detectRooms(conflicted)).toEqual([]);
  });

  it("does not merge across a skipped short partition or suppress a room for a short dangling branch", () => {
    const points = [
      p(0, 0), p(2_000, 0), p(2_000, 1_499.75), p(4_000, 0),
      p(4_000, 3_000), p(2_000, 1_500.25), p(2_000, 3_000), p(0, 3_000),
    ];
    let plan = createEmptyPlan();
    for (let i = 0; i < points.length; i++) {
      plan = addWall(plan, points[i]!, points[(i + 1) % points.length]!, 100);
    }
    expect(detectRooms(plan)).toHaveLength(1);
    const partitioned = addWall(plan, points[2]!, points[5]!, 100);
    expect(getGeometryIssues(partitioned).map(issue => issue.code)).toEqual(["short-wall"]);
    expect(detectRooms(partitioned)).toEqual([]);
    const branch = addWall(rectangle(), p(0, 0), p(-0.5, 0), 100);
    expect(getGeometryIssues(branch).map(issue => issue.code)).toEqual(["short-wall"]);
    expect(detectRooms(branch).map(room => room.area)).toEqual([12_000_000]);
  });
});

describe("wall editing and deletion", () => {
  it("resizes from the start and keeps connected walls on the same end node", () => {
    const plan = rectangle();
    const wall = firstWall(plan);
    const [a, b] = wallPoints(plan, wall);
    const next = resizeWall(plan, wall.id, 5_000);
    expect(next.nodes.find(node => node.id === a.id)).toEqual(a);
    expect(next.nodes.find(node => node.id === b.id)).toMatchObject(p(5_000, 0));
    expect(next.walls.filter(item => item.a === b.id || item.b === b.id)).toHaveLength(2);
    expect(distance(...wallPoints(next, next.walls.find(item => item.id === wall.id)!))).toBe(5_000);
    expect(plan.nodes.find(node => node.id === b.id)).toEqual(b);
    expect(detectRooms(next)[0]!.area).toBe(13_500_000);
  });

  it("resizes diagonal walls along their original direction", () => {
    const plan = addWall(createEmptyPlan(), p(100, 200), p(400, 600), 100);
    const next = resizeWall(plan, firstWall(plan).id, 1_000);
    expect(wallPoints(next, firstWall(next))[1]).toMatchObject(p(700, 1_000));
  });

  it("moves both endpoints and preserves connected walls and attached openings", () => {
    let plan = rectangle();
    const wall = firstWall(plan);
    plan = addOpening(plan, wall.id, "window", 2_000, 1_000);
    const next = moveWall(plan, wall.id, p(0, -500));
    expect(wallPoints(next, firstWall(next)).map(({ x, y }) => ({ x, y }))).toEqual([p(0, -500), p(4_000, -500)]);
    expect(next.openings).toEqual(plan.openings);
    expect(next.nodes).toHaveLength(4);
    expect(detectRooms(next)[0]!.area).toBe(14_000_000);
  });

  it("accepts spatially conflicting edits while rejecting invalid numeric input", () => {
    const plan = rectangle();
    const wall = firstWall(plan);
    expect(() => resizeWall(plan, wall.id, 0)).toThrow(/at least 1 mm/);
    expect(getGeometryIssues(moveWall(plan, wall.id, p(0, 3_000))))
      .toContainEqual(expect.objectContaining({ code: "short-wall" }));
    const obstructed = addWall(plan, p(2_000, -2_000), p(2_000, -500), 100);
    expect(getGeometryIssues(moveWall(obstructed, wall.id, p(0, -1_000))))
      .toContainEqual(expect.objectContaining({ code: "wall-crossing" }));
    expect(() => moveWall(plan, wall.id, p(NaN, 0))).toThrow(/finite/);
    expect(() => resizeWall(plan, wall.id, 100_001)).toThrow(/100 m/);
    const withOpening = addOpening(plan, wall.id, "window", 3_000, 1_000);
    const shortened = resizeWall(withOpening, wall.id, 3_000);
    expect(shortened.openings).toEqual(withOpening.openings);
    expect(getGeometryIssues(shortened)).toContainEqual(expect.objectContaining({ code: "opening-outside" }));
    const connected = wallFrom(plan, p(4_000, 0), p(4_000, 3_000));
    const onConnectedWall = addOpening(plan, connected.id, "door", 2_000, 1_000);
    expect(getGeometryIssues(moveWall(onConnectedWall, wall.id, p(0, 1_000))))
      .toContainEqual(expect.objectContaining({ code: "opening-outside" }));
  });

  it("updates thickness and dimension visibility without changing geometry", () => {
    const plan = singleWall();
    const wall = firstWall(plan);
    expect(firstWall(setWallThickness(plan, wall.id, 250)).thickness).toBe(250);
    expect(firstWall(toggleDimension(plan, wall.id)).dimension).toBe(!wall.dimension);
    expect(() => setWallThickness(plan, wall.id, 9)).toThrow(/between 10 and 1000/);
    expect(() => setWallThickness(plan, wall.id, 1_001)).toThrow(/between 10 and 1000/);
    expect(firstWall(plan)).toEqual(wall);
  });

  it("cascades openings and prunes only unused nodes", () => {
    let plan = rectangle();
    const wall = firstWall(plan);
    plan = addOpening(plan, wall.id, "door", 1_000, 900);
    plan = addOpening(plan, plan.walls[1]!.id, "window", 1_000, 900);
    const next = deleteWall(plan, wall.id);
    expect(next.walls).toHaveLength(3);
    expect(next.nodes).toHaveLength(4);
    expect(next.openings).toHaveLength(1);
    expect(detectRooms(next)).toEqual([]);
    const standalone = singleWall();
    expect(deleteWall(standalone, firstWall(standalone).id).nodes).toEqual([]);
    expect(plan.openings).toHaveLength(2);
  });

  it("merges adjacent rooms when the partition is deleted", () => {
    const plan = createDemoPlan();
    const partition = wallFrom(plan, p(4_200, 0), p(4_200, 4_800));
    const next = deleteWall(plan, partition.id);
    expect(detectRooms(next)).toHaveLength(1);
    expect(detectRooms(next)[0]!.area).toBe(32_640_000);
    expect(next.openings.some(opening => opening.wallId === partition.id)).toBe(false);
  });

  it("reports stale selections rather than silently ignoring edits", () => {
    const plan = rectangle();
    expect(() => moveWall(plan, "missing", p(1, 0))).toThrow(/no longer exists/);
    expect(() => resizeWall(plan, "missing", 1_000)).toThrow(/no longer exists/);
    expect(() => setWallThickness(plan, "missing", 100)).toThrow(/no longer exists/);
    expect(() => toggleDimension(plan, "missing")).toThrow(/no longer exists/);
    expect(() => deleteWall(plan, "missing")).toThrow(/no longer exists/);
    expect(() => addOpening(plan, "missing", "door", 1_000, 900)).toThrow(/no longer exists/);
    expect(() => updateOpening(plan, "missing", { flip: true })).toThrow(/no longer exists/);
    expect(() => deleteOpening(plan, "missing")).toThrow(/no longer exists/);
  });
});

describe("projection and snapping", () => {
  it("projects every nonzero wall normally and snaps safely around collapsed walls", () => {
    expect(projectToWall(p(0.25, 1), p(0, 0), p(0.5, 0))).toEqual({
      point: p(0.25, 0), offset: 0.25, distance: 1,
    });
    expect(projectToWall(p(5e-201, 1), p(0, 0), p(1e-200, 0))).toEqual({
      point: p(5e-201, 0), offset: 5e-201, distance: 1,
    });
    const collapsed = addWall(createEmptyPlan(), p(100, 100), p(100, 100), 100);
    expect(snapPoint(collapsed, p(110, 110), 0, 50)).toEqual(p(100, 100));
    expect(snapPoint(collapsed, p(250, 150), 100, 10)).toEqual(p(300, 200));
    expect(snapPoint(collapsed, p(250, 110), 100, 10, p(0, 100), true)).toEqual(p(300, 100));
    expect(() => projectToWall(p(NaN, 0), p(0, 0), p(0, 0))).toThrow(/finite/);
  });

  it("projects to a finite segment with an absolute offset", () => {
    expect(projectToWall(p(1_500, 200), p(0, 0), p(4_000, 0))).toEqual({
      point: p(1_500, 0), offset: 1_500, distance: 200,
    });
    expect(projectToWall(p(-100, 0), p(0, 0), p(4_000, 0))).toEqual({ point: p(0, 0), offset: 0, distance: 100 });
    expect(projectToWall(p(5_000, 0), p(0, 0), p(4_000, 0))).toEqual({ point: p(4_000, 0), offset: 4_000, distance: 1_000 });
    expect(projectToWall(p(300, 100), p(0, 0), p(300, 400)).offset).toBeCloseTo(260);
    expect(projectToWall(p(0, 0), p(1, 1), p(1, 1))).toEqual({
      point: p(1, 1), offset: 0, distance: Math.SQRT2,
    });
  });

  it("prioritizes nodes, then walls, then grid", () => {
    const plan = singleWall();
    expect(snapPoint(plan, p(30, 10), 100, 50)).toEqual(p(0, 0));
    expect(snapPoint(plan, p(1_535, 10), 100, 50)).toEqual(p(1_535, 0));
    expect(snapPoint(plan, p(1_535, 260), 100, 50)).toEqual(p(1_500, 300));
    expect(snapPoint(createEmptyPlan(), p(430, 470), 100, 50, p(425, 475))).toEqual(p(425, 475));
  });

  it("keeps orthogonal node, wall, and grid snaps on the chosen axis", () => {
    const origin = p(25, 35);
    const empty = createEmptyPlan();
    expect(snapPoint(empty, p(373, 110), 100, 20, origin, true)).toEqual(p(400, 35));
    expect(snapPoint(empty, p(110, 373), 100, 20, origin, true)).toEqual(p(25, 400));
    expect(snapPoint(empty, p(35, 39), 100, 20, origin, true)).toEqual(origin);
    const plan = addWall(empty, p(390, 50), p(390, 500), 100);
    expect(snapPoint(plan, p(380, 30), 100, 50, origin, true)).toEqual(p(400, 35));
    const across = addWall(empty, p(390, 0), p(390, 500), 100);
    expect(snapPoint(across, p(380, 30), 100, 50, origin, true)).toEqual(p(390, 35));
    const diagonal = addWall(empty, p(0, 0), p(500, 500), 100);
    expect(snapPoint(diagonal, p(280, 180), 100, 50, p(0, 250), true)).toEqual(p(250, 250));
  });

  it("supports disabled snapping without discarding an explicit orthogonal constraint", () => {
    const plan = singleWall();
    expect(snapPoint(plan, p(1_535, 10), 0, 0)).toEqual(p(1_535, 10));
    expect(snapPoint(plan, p(0.0000001, 0), 0, 0)).toEqual(p(0.0000001, 0));
    expect(snapPoint(plan, p(373, 110), 0, 0, p(25, 35), true)).toEqual(p(373, 35));
    expect(snapPoint(plan, p(110, 373), 0, 0, p(25, 35), true)).toEqual(p(25, 373));
    expect(snapPoint(plan, p(373, 110), 0, 0, p(25, 35), false)).toEqual(p(373, 110));
  });

  it("can disable grid and proximity snapping independently", () => {
    const plan = singleWall();
    expect(snapPoint(plan, p(1_535, 10), 0, 50)).toEqual(p(1_535, 0));
    expect(snapPoint(plan, p(1_535, 260), 0, 50)).toEqual(p(1_535, 260));
    expect(snapPoint(plan, p(1_535, 10), 100, 0)).toEqual(p(1_500, 0));
  });

  it("rejects invalid grid and snap settings", () => {
    expect(() => snapPoint(createEmptyPlan(), p(0, 0), -1, 10)).toThrow(/negative/);
    expect(() => snapPoint(createEmptyPlan(), p(0, 0), 100, -1)).toThrow(/negative/);
  });
});

describe("length and area units", () => {
  it.each([
    ["0", "metric", 0], ["0 mm", "metric", 0], ["-0 m", "metric", 0],
    ["-1.25", "metric", -1_250], ["-420 cm", "metric", -4_200],
    ["+1 1/2 m", "metric", 1_500], ["0' 0\"", "imperial", 0],
    ["-1", "imperial", -304.8], ["-12' 6 1/2\"", "imperial", -3_822.7],
    [" -6 1/2 in ", "imperial", -165.1], ["-1/2 ft", "imperial", -152.4],
    ["+12\u2032 6\u2033", "imperial", 3_810],
  ] as [string, Plan["units"], number][])("parses signed position %s in %s", (input, units, expected) => {
    expect(parsePosition(input, units)).toBeCloseTo(expected, 7);
  });

  it.each(["", "-", "+", "--1 m", "+-1", "NaN", "Infinity", "-1/0 in", "-1000000 m"])(
    "rejects malformed or oversized position %s", input => {
      expect(() => parsePosition(input, "metric")).toThrow();
      expect(() => parsePosition(input, "imperial")).toThrow();
    },
  );

  it("keeps length input positive-only and position input within the same scalar bound", () => {
    for (const input of ["0", "-0", "-1"]) {
      expect(() => parseLength(input, "metric")).toThrow();
    }
    const limit = 2 * 100_000 * Math.SQRT2;
    expect(parsePosition(`-${limit} mm`, "metric")).toBe(-limit);
    expect(parsePosition(`${limit} mm`, "metric")).toBe(limit);
    expect(() => parsePosition(`-${limit + 1} mm`, "metric")).toThrow(/coordinate limit/);
    expect(() => parsePosition(" ".repeat(120) + "-1", "metric")).toThrow();
  });

  it.each([
    ["4.2", 4_200], ["420 cm", 4_200], ["4200 mm", 4_200], ["4.2 m", 4_200],
    [".5m", 500], [" 4.2 METERS ", 4_200], ["6 1/2\"", 165.1],
  ])("parses metric input %s", (input, expected) => {
    expect(parseLength(input, "metric")).toBeCloseTo(expected, 7);
  });

  it.each([
    ["12", 3_657.6], ["12' 6\"", 3_810], ["12ft 6in", 3_810], ["12 ft 6 1/2 in", 3_822.7],
    ["6 1/2\"", 165.1], ["1/2 in", 12.7], ["1 1/2 ft", 457.2], ["0' 6\"", 152.4],
    ["12\u2032 6\u2033", 3_810], ["4200 mm", 4_200],
  ])("parses imperial input %s", (input, expected) => {
    expect(parseLength(input, "imperial")).toBeCloseTo(expected, 7);
  });

  it.each(["", " ", "0", "-4", "NaN", "Infinity", "4 meters junk", "4.2.3", "4e3", "1,5",
    "12' garbage", "12ft 6", "12ft 6in extra", "1/0\"", "6 2/1\"", "4 m 2 cm", "1000000m"])(
    "rejects malformed or nonpositive input %s", input => {
      expect(() => parseLength(input, "metric")).toThrow(Error);
      expect(() => parseLength(input, "imperial")).toThrow(Error);
    },
  );

  it("formats metric and imperial lengths with parseable roundtrips", () => {
    expect(formatLength(4_200, "metric")).toBe("4.2 m");
    expect(formatLength(3_810, "imperial")).toBe("12' 6\"");
    expect(formatLength(165.1, "imperial")).toBe("0' 6.5\"");
    for (const mm of [1, 150, 900, 3_810, 4_200, 100_000, Math.hypot(4_000, 3_100)]) {
      expect(Math.abs(parseLength(formatLength(mm, "metric"), "metric") - mm)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(parseLength(formatLength(mm, "imperial"), "imperial") - mm)).toBeLessThan(0.002);
    }
    expect(formatLength(0, "metric")).toBe("0 m");
    expect(formatLength(0, "imperial")).toBe("0' 0\"");
    expect(formatArea(12_000_000, "metric")).toBe("12 m\u00b2");
    expect(formatArea(304.8 ** 2 * 100, "imperial")).toBe("100 ft\u00b2");
    expect(() => formatLength(NaN, "metric")).toThrow(/finite/);
    expect(() => formatArea(-1, "metric")).toThrow(/negative/);
  });
});

describe("safe persistence validation", () => {
  it("returns an independent, normalized value from JSON", () => {
    const plan = createDemoPlan();
    const validated = validatePlan(clone(plan));
    expect(validated).toEqual(plan);
    expect(validated).not.toBe(plan);
    validated.nodes[0]!.x = 123;
    validated.walls[0]!.thickness = 250;
    validated.openings[0]!.width = 999;
    validated.roomNames[detectRooms(plan)[0]!.id] = "Changed";
    expect(validated).not.toEqual(plan);
    expect(plan.nodes[0]!.x).toBe(0);
  });

  it.each([null, [], "plan", {}, { ...createEmptyPlan(), version: 2 },
    { ...createEmptyPlan(), units: "yards" }, { ...createEmptyPlan(), surprise: true },
    { ...createEmptyPlan(), name: "" }, { ...createEmptyPlan(), name: "x".repeat(121) },
    { ...createEmptyPlan(), walls: null }, { ...createEmptyPlan(), roomNames: [] },
  ])("rejects an invalid top-level schema (%#)", input => {
    expect(() => validatePlan(input)).toThrow(Error);
  });

  it("rejects nonfinite or oversized coordinates and entity limits", () => {
    for (const x of [NaN, Infinity, -Infinity, 100_001, -100_001]) {
      const plan = singleWall();
      plan.nodes[0]!.x = x;
      expect(() => validatePlan(plan)).toThrow(/finite|100 m/);
    }
    expect(() => validatePlan({ ...createEmptyPlan(), nodes: Array(2_001).fill({ id: "a", x: 0, y: 0 }) })).toThrow(/limit/);
    expect(() => validatePlan({ ...createEmptyPlan(), walls: Array(1_001).fill({}) })).toThrow(/limit/);
    expect(() => validatePlan({ ...createEmptyPlan(), openings: Array(1_001).fill({}) })).toThrow(/limit/);
    expect(() => validatePlan({ ...createEmptyPlan(), nodes: Array(1) })).toThrow(/missing list entries/);
  });

  it("rejects duplicate IDs and dangling references but accepts coincident geometry", () => {
    const duplicate = singleWall();
    duplicate.nodes[1]!.id = duplicate.nodes[0]!.id;
    expect(() => validatePlan(duplicate)).toThrow(/duplicate identifiers/);
    const missing = singleWall();
    missing.walls[0]!.b = "missing";
    expect(() => validatePlan(missing)).toThrow(/missing junction/);
    const zero = singleWall();
    zero.nodes[1]!.x = 0;
    expect(validatePlan(zero)).toEqual(zero);
    expect(getGeometryIssues(zero)).toContainEqual(expect.objectContaining({ code: "short-wall" }));
    const selfReference = singleWall();
    selfReference.walls[0]!.b = selfReference.walls[0]!.a;
    expect(() => validatePlan(selfReference)).toThrow(/two different junctions/);
    const coincident = rectangle();
    coincident.nodes.push({ ...coincident.nodes[0]!, id: "duplicate-position" });
    coincident.walls[0]!.a = "duplicate-position";
    expect(validatePlan(coincident)).toEqual(coincident);
    expect(getGeometryIssues(coincident)).toContainEqual(expect.objectContaining({ code: "coincident-nodes" }));
    expect(() => validatePlan({ ...createEmptyPlan(), nodes: [{ id: "orphan", x: 0, y: 0 }] })).toThrow(/unused junctions/);
  });

  it("accepts raw imports with derived crossing, overlapping, or unsplit junction warnings", () => {
    const raw = (points: Point[]): Plan => ({
      ...createEmptyPlan(),
      nodes: points.map((point, index) => ({ ...point, id: `n${index}` })),
      walls: [
        { id: "w0", a: "n0", b: "n1", thickness: 150, dimension: true },
        { id: "w1", a: "n2", b: "n3", thickness: 150, dimension: true },
      ],
    });
    for (const [points, code] of [
      [[p(0, 0), p(4_000, 0), p(2_000, -1_000), p(2_000, 1_000)], "wall-crossing"],
      [[p(0, 0), p(4_000, 0), p(2_000, 0), p(5_000, 0)], "wall-overlap"],
      [[p(0, 0), p(4_000, 0), p(2_000, 0), p(2_000, 1_000)], "wall-crossing"],
    ] as [Point[], string][]) {
      const plan = raw(points);
      expect(validatePlan(clone(plan))).toEqual(plan);
      expect(getGeometryIssues(plan)).toContainEqual(expect.objectContaining({ code, wallIds: ["w0", "w1"] }));
    }
    const duplicateWall = singleWall();
    duplicateWall.walls.push({ ...duplicateWall.walls[0]!, id: "duplicate-wall" });
    expect(validatePlan(duplicateWall)).toEqual(duplicateWall);
    expect(getGeometryIssues(duplicateWall)).toContainEqual(expect.objectContaining({ code: "wall-overlap" }));
  });

  it("strictly validates opening shape, references, and bounded finite scalars", () => {
    const base = singleWall();
    const plan = addOpening(base, firstWall(base).id, "door", 2_000, 900);
    for (const patch of [
      { wallId: "missing" }, { kind: "gate" }, { offset: NaN }, { offset: Number.MAX_VALUE },
      { offset: -Number.MAX_VALUE }, { width: 0 }, { width: Number.MAX_VALUE },
      { width: Infinity }, { flip: 1 }, { extra: true },
    ]) {
      expect(() => validatePlan({ ...plan, openings: [{ ...plan.openings[0], ...patch }] })).toThrow(Error);
    }
    const overlapping = validatePlan({
      ...plan, openings: [plan.openings[0], { ...plan.openings[0], id: "overlapping-opening", offset: 2_500 }],
    });
    expect(getGeometryIssues(overlapping)).toContainEqual(expect.objectContaining({ code: "opening-overlap" }));
    const limit = 2 * 100_000 * Math.SQRT2;
    for (const offset of [-limit, limit]) {
      expect(validatePlan({ ...plan, openings: [{ ...plan.openings[0], offset, width: limit }] }).openings[0])
        .toMatchObject({ offset, width: limit });
      expect(() => updateOpening(plan, plan.openings[0]!.id, { offset: offset + Math.sign(offset) }))
        .toThrow(/maximum length/);
    }
    expect(() => updateOpening(plan, plan.openings[0]!.id, { width: limit + 1 })).toThrow(/maximum length/);
    expect(() => validatePlan({ ...plan, walls: [{ ...plan.walls[0], dimension: "yes" }] })).toThrow(/true or false/);
    expect(() => validatePlan({ ...plan, walls: [{ ...plan.walls[0], thickness: 0 }] })).toThrow(/thickness/);
  });

  it("rejects unsafe metadata and retains valid room names across persistence", () => {
    const plan = rectangle();
    const roomId = detectRooms(plan)[0]!.id;
    expect(validatePlan({ ...plan, roomNames: { [roomId]: "Office" } }).roomNames[roomId]).toBe("Office");
    expect(() => validatePlan({ ...plan, roomNames: { [roomId]: 123 } })).toThrow(/Room name/);
    expect(() => validatePlan({ ...plan, roomNames: { [roomId]: "x".repeat(121) } })).toThrow(/Room name/);
    expect(() => validatePlan({ ...plan, roomNames: JSON.parse('{"__proto__":"Bad"}') })).toThrow(/identifier/);
    expect(() => validatePlan({ ...plan, roomNames: { notARoom: "Bad" } })).toThrow(/identifier/);
    expect(() => validatePlan({ ...plan, roomNames: { "room:": "Bad" } })).toThrow(/identifier/);
    expect(() => validatePlan({ ...plan, roomNames: { "room:a:a:b": "Bad" } })).toThrow(/identifier/);
  });
});
