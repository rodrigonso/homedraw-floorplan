import { describe, expect, it } from "vitest";
import {
  addAngleDimension, addOpening, addRoom, addWall, angleVertex, createEmptyPlan,
  deleteAngleDimension, deleteWall, getGeometryIssues, moveNode, moveWall, resizeWall, setDimensionOffset,
  setWallThickness, toggleDimension, updateAngleDimension, validatePlan, wallPoints,
  type AngleDimension, type Plan, type Point, type Wall,
} from "./model";

const p = (x: number, y: number): Point => ({ x, y });
const corner = (): Plan => addWall(
  addWall(createEmptyPlan(), p(0, 0), p(4_000, 0), 150), p(0, 0), p(0, 3_000), 150,
);
const annotation = (plan: Plan): Omit<AngleDimension, "id"> => ({
  wallA: plan.walls[0]!.id,
  wallB: plan.walls[1]!.id,
  vertex: angleVertex(plan, plan.walls[0]!.id, plan.walls[1]!.id).id,
  radius: 600,
  clockwise: true,
});
const annotatedCorner = (): Plan => {
  const plan = corner();
  return addAngleDimension(plan, annotation(plan));
};
const firstAngle = (plan: Plan): AngleDimension => plan.angleDimensions![0]!;
const wallFrom = (plan: Plan, a: Point, b: Point): Wall => {
  const wall = plan.walls.find(wall => {
    const [start, end] = wallPoints(plan, wall);
    return (start.x === a.x && start.y === a.y && end.x === b.x && end.y === b.y) ||
      (start.x === b.x && start.y === b.y && end.x === a.x && end.y === a.y);
  });
  if (!wall) throw new Error("Test wall not found.");
  return wall;
};

describe("persisted angle dimension operations", () => {
  it("stores a right-angle annotation and round trips without changing its directed arc", () => {
    const original = corner();
    const before = JSON.stringify(original);
    const dimension = annotation(original);
    const plan = addAngleDimension(original, dimension);
    const added = firstAngle(plan);
    expect(added).toEqual({ id: expect.any(String), ...dimension });
    expect(added.id).not.toBe("");
    expect(plan).not.toBe(original);
    expect(angleVertex(plan, added.wallA, added.wallB)).toMatchObject(p(0, 0));
    expect(validatePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(JSON.stringify(original)).toBe(before);
    expect(Object.hasOwn(original, "angleDimensions")).toBe(false);
    const reflex = addAngleDimension(plan, { ...dimension, clockwise: false, radius: 900 });
    expect(reflex.angleDimensions).toHaveLength(2);
    expect(reflex.angleDimensions![1]).toMatchObject({ ...dimension, clockwise: false, radius: 900 });
    expect(reflex.angleDimensions![1]!.id).not.toBe(added.id);
  });

  it("finds the same junction independently of wall order and endpoint direction", () => {
    const plan = corner();
    const { wallA, wallB, vertex } = annotation(plan);
    const node = plan.nodes.find(node => node.id === vertex)!;
    expect(angleVertex(plan, wallA, wallB)).toBe(node);
    expect(angleVertex(plan, wallB, wallA)).toBe(node);
    const reversed = validatePlan({
      ...plan, walls: plan.walls.map(wall => ({ ...wall, a: wall.b, b: wall.a })),
    });
    expect(angleVertex(reversed, wallA, wallB)).toEqual(node);
    expect(() => angleVertex(plan, wallA, wallA)).toThrow(/different walls/);
    expect(() => angleVertex(plan, wallA, "missing")).toThrow(/wall no longer exists/);
    expect(() => angleVertex(plan, "missing", wallB)).toThrow(/wall no longer exists/);
    const separate = addWall(plan, p(10_000, 0), p(11_000, 0), 100);
    expect(() => angleVertex(separate, wallA, separate.walls[2]!.id)).toThrow(/share exactly one junction/);
  });

  it("updates and deletes immutably, keeping the same annotation identifier", () => {
    const plan = annotatedCorner();
    const before = JSON.stringify(plan);
    const original = firstAngle(plan);
    const updated = updateAngleDimension(plan, original.id, { radius: 1_200, clockwise: false });
    expect(firstAngle(updated)).toEqual({ ...original, radius: 1_200, clockwise: false });
    expect(updated).not.toBe(plan);
    expect(JSON.stringify(plan)).toBe(before);
    const removed = deleteAngleDimension(updated, original.id);
    expect(removed.angleDimensions).toEqual([]);
    expect(updated.angleDimensions).toHaveLength(1);
    expect(removed.walls).toEqual(plan.walls);
    expect(removed.nodes).toEqual(plan.nodes);
    expect(validatePlan(removed)).toEqual(removed);
  });

  it("returns the original plan for empty and unchanged updates", () => {
    const plan = annotatedCorner();
    const dimension = firstAngle(plan);
    expect(updateAngleDimension(plan, dimension.id, {})).toBe(plan);
    expect(updateAngleDimension(plan, dimension.id, { radius: dimension.radius })).toBe(plan);
    expect(updateAngleDimension(plan, dimension.id, { clockwise: dimension.clockwise })).toBe(plan);
    expect(updateAngleDimension(plan, dimension.id, {
      radius: dimension.radius, clockwise: dimension.clockwise,
    })).toBe(plan);
  });

  it("reports missing annotation IDs for updates and deletes, including legacy plans", () => {
    for (const plan of [corner(), annotatedCorner()]) {
      expect(() => updateAngleDimension(plan, "missing", {})).toThrow(/angle dimension no longer exists/);
      expect(() => deleteAngleDimension(plan, "missing")).toThrow(/angle dimension no longer exists/);
    }
  });

  it.each([
    { wallA: "changed" }, { wallB: "changed" }, { vertex: "changed" }, { id: "changed" },
    { extra: true }, { radius: undefined }, { clockwise: undefined }, { radius: NaN },
    { radius: 99 }, { radius: 100_001 }, { clockwise: "true" }, null, [], new Date(),
  ])("rejects a strict update patch %j without mutation", patch => {
    const plan = annotatedCorner();
    const before = JSON.stringify(plan);
    expect(() => updateAngleDimension(
      plan, firstAngle(plan).id, patch as Parameters<typeof updateAngleDimension>[2],
    )).toThrow();
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("rejects invalid additions rather than accepting supplied IDs or extra keys", () => {
    const plan = corner();
    const dimension = annotation(plan);
    for (const invalid of [
      { ...dimension, id: "supplied" }, { ...dimension, extra: true },
      { ...dimension, radius: 0 }, { ...dimension, wallA: "missing" }, null, [],
    ]) {
      expect(() => addAngleDimension(plan, invalid as Omit<AngleDimension, "id">)).toThrow();
    }
    expect(Object.hasOwn(plan, "angleDimensions")).toBe(false);
  });
});

describe("strict angle dimension validation", () => {
  it("preserves the exact old project shape and explicitly present empty collections", () => {
    for (const plan of [createEmptyPlan(), corner()]) {
      const before = JSON.stringify(plan);
      const validated = validatePlan(plan);
      expect(Object.hasOwn(validated, "angleDimensions")).toBe(false);
      expect(JSON.stringify(validated)).toBe(before);
      expect(validatePlan({ ...plan, angleDimensions: [] })).toEqual({ ...plan, angleDimensions: [] });
    }
    const plan = corner();
    expect(Object.hasOwn(deleteWall(plan, plan.walls[0]!.id), "angleDimensions")).toBe(false);
    expect(Object.hasOwn(addWall(plan, p(2_000, 0), p(2_000, 1_000), 100), "angleDimensions")).toBe(false);
    expect(() => validatePlan({ ...plan, angles: [] })).toThrow(/unsupported fields/);
  });

  it.each([undefined, null, {}, "angles", [null], [undefined], new Array(1)])(
    "rejects explicitly invalid angle collections %j", angleDimensions => {
      expect(() => validatePlan({ ...corner(), angleDimensions })).toThrow();
    },
  );

  it.each([
    ["missing first wall", { wallA: "missing" }, /missing wall/],
    ["missing second wall", { wallB: "missing" }, /missing wall/],
    ["missing vertex", { vertex: "missing" }, /shared junction/],
    ["non-string first wall", { wallA: 1 }, /identifier/],
    ["non-string second wall", { wallB: null }, /identifier/],
    ["non-string vertex", { vertex: false }, /identifier/],
    ["invalid identifier", { id: "not:an:id" }, /identifier/],
    ["numeric identifier", { id: 3 }, /identifier/],
    ["extra fields", { degrees: 90 }, /unsupported fields/],
    ["non-boolean direction", { clockwise: 1 }, /true or false/],
    ["missing direction", { clockwise: undefined }, /true or false/],
  ] as [string, Record<string, unknown>, RegExp][])("rejects %s", (_name, patch, error) => {
    const plan = annotatedCorner();
    expect(() => validatePlan({ ...plan, angleDimensions: [{ ...firstAngle(plan), ...patch }] })).toThrow(error);
  });

  it.each(["id", "wallA", "wallB", "vertex", "radius", "clockwise"])("rejects missing %s", key => {
    const plan = annotatedCorner();
    const dimension: Record<string, unknown> = { ...firstAngle(plan) };
    delete dimension[key];
    expect(() => validatePlan({ ...plan, angleDimensions: [dimension] })).toThrow(/missing or unsupported fields/);
  });

  it.each([NaN, Infinity, -Infinity, -100, 0, 99.999, 100_000.001, "600", null, undefined])(
    "rejects invalid radius %j", radius => {
      const plan = annotatedCorner();
      expect(() => validatePlan({ ...plan, angleDimensions: [{ ...firstAngle(plan), radius }] })).toThrow(/radius/i);
    },
  );

  it.each([100, 100.125, 100_000])("accepts radius %s in millimeters", radius => {
    const plan = corner();
    const next = addAngleDimension(plan, { ...annotation(plan), radius });
    expect(firstAngle(validatePlan(next)).radius).toBe(radius);
  });

  it("requires two distinct walls and the actual common node", () => {
    let plan = annotatedCorner();
    const dimension = firstAngle(plan);
    expect(() => validatePlan({
      ...plan, angleDimensions: [{ ...dimension, wallB: dimension.wallA }],
    })).toThrow(/different walls/);
    const wrongVertex = plan.walls[0]!.b;
    expect(() => validatePlan({
      ...plan, angleDimensions: [{ ...dimension, vertex: wrongVertex }],
    })).toThrow(/shared junction/);
    plan = addWall(plan, p(10_000, 0), p(11_000, 0), 100);
    expect(() => validatePlan({
      ...plan, angleDimensions: [{ ...dimension, wallB: plan.walls[2]!.id }],
    })).toThrow(/share exactly one junction/);
  });

  it("shares the identifier namespace with nodes, walls, openings, and other angles", () => {
    let plan = annotatedCorner();
    plan = addOpening(plan, plan.walls[0]!.id, "window", 1_000, 500);
    const dimension = firstAngle(plan);
    for (const duplicateId of [plan.nodes[0]!.id, plan.walls[0]!.id, plan.openings[0]!.id]) {
      expect(() => validatePlan({
        ...plan, angleDimensions: [{ ...dimension, id: duplicateId }],
      })).toThrow(/duplicate identifiers/);
    }
    expect(() => validatePlan({
      ...plan, angleDimensions: [dimension, { ...dimension, clockwise: false }],
    })).toThrow(/duplicate identifiers/);
  });

  it("rejects duplicate sectors, including a reversed pair with inverted direction", () => {
    const plan = annotatedCorner();
    const dimension = annotation(plan);
    expect(() => addAngleDimension(plan, { ...dimension, radius: 1_200 })).toThrow(/duplicate angle dimensions/);
    expect(() => addAngleDimension(plan, {
      ...dimension, wallA: dimension.wallB, wallB: dimension.wallA, clockwise: false,
    })).toThrow(/duplicate angle dimensions/);
    const complementary = addAngleDimension(plan, {
      ...dimension, wallA: dimension.wallB, wallB: dimension.wallA,
    });
    expect(complementary.angleDimensions).toHaveLength(2);
    expect(() => updateAngleDimension(complementary, firstAngle(plan).id, { clockwise: false }))
      .toThrow(/duplicate angle dimensions/);
    expect(firstAngle(complementary)).toEqual(firstAngle(plan));
  });

  it("treats reversed-pair duplicates symmetrically regardless of insertion order", () => {
    const plan = corner();
    const dimension = annotation(plan);
    const reversed = addAngleDimension(plan, {
      ...dimension, wallA: dimension.wallB, wallB: dimension.wallA, clockwise: false,
    });
    expect(() => addAngleDimension(reversed, dimension)).toThrow(/duplicate angle dimensions/);
    expect(addAngleDimension(reversed, { ...dimension, clockwise: false }).angleDimensions).toHaveLength(2);
  });

  it("allows 1000 annotations and rejects more even when all sectors are unique", () => {
    const plan = createEmptyPlan();
    plan.nodes.push({ id: "center", x: 0, y: 0 });
    for (let index = 0; index < 33; index++) {
      const angle = index * 2 * Math.PI / 33;
      plan.nodes.push({ id: `node${index}`, x: 10_000 * Math.cos(angle), y: 10_000 * Math.sin(angle) });
      plan.walls.push({ id: `wall${index}`, a: "center", b: `node${index}`, thickness: 100, dimension: true });
    }
    const dimensions: AngleDimension[] = [];
    for (let first = 0; first < 33; first++) {
      for (let second = first + 1; second < 33; second++) {
        for (const clockwise of [true, false]) {
          dimensions.push({
            id: `angle${dimensions.length}`, wallA: `wall${first}`, wallB: `wall${second}`,
            vertex: "center", radius: 600, clockwise,
          });
        }
      }
    }
    expect(validatePlan({ ...plan, angleDimensions: dimensions.slice(0, 1_000) }).angleDimensions).toHaveLength(1_000);
    expect(() => validatePlan({ ...plan, angleDimensions: dimensions.slice(0, 1_001) })).toThrow(/limit of 1000/);
  });
});

describe("angle dimension wall attachment", () => {
  it("persists and edits annotations on collapsed rays without losing their structural attachment", () => {
    const original = annotatedCorner();
    const dimension = firstAngle(original);
    const wall = original.walls[0]!;
    const vertex = original.nodes.find(node => node.id === dimension.vertex)!;
    const collapsed = moveNode(original, wall.b, vertex);
    const before = JSON.stringify(collapsed);
    expect(collapsed.angleDimensions).toEqual(original.angleDimensions);
    expect(validatePlan(JSON.parse(before))).toEqual(collapsed);
    expect(getGeometryIssues(collapsed)).toContainEqual(expect.objectContaining({
      code: "undefined-angle", angleIds: [dimension.id],
      wallIds: expect.arrayContaining([dimension.wallA, dimension.wallB]),
    }));
    const updated = updateAngleDimension(collapsed, dimension.id, { radius: 1_200 });
    expect(firstAngle(updated)).toEqual({ ...dimension, radius: 1_200 });
    expect(getGeometryIssues(updated)).toContainEqual(expect.objectContaining({ code: "undefined-angle" }));
    const extra = addWall(updated, p(10_000, 0), p(11_000, 0), 100);
    expect(extra.angleDimensions).toEqual(updated.angleDimensions);
    const removed = deleteAngleDimension(extra, dimension.id);
    expect(getGeometryIssues(removed).some(issue => issue.code === "undefined-angle")).toBe(false);
    expect(getGeometryIssues(removed).some(issue => issue.code === "short-wall")).toBe(true);
    expect(JSON.stringify(collapsed)).toBe(before);
    expect(getGeometryIssues(moveNode(updated, wall.b, p(4_000, 0)))).toEqual([]);
  });

  it("retains wall IDs, shared vertex, radius, and direction when the shared node moves", () => {
    const plan = annotatedCorner();
    const before = JSON.stringify(plan);
    const dimension = firstAngle(plan);
    const moved = moveNode(plan, dimension.vertex, p(250, 300));
    expect(moved.angleDimensions).toEqual(plan.angleDimensions);
    expect(angleVertex(moved, dimension.wallA, dimension.wallB)).toMatchObject(p(250, 300));
    for (const wall of moved.walls) {
      expect(wallPoints(moved, wall)).toContainEqual({ id: dimension.vertex, x: 250, y: 300 });
    }
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("retains annotations through other immutable wall edits", () => {
    const plan = annotatedCorner();
    const wallId = plan.walls[0]!.id;
    for (const next of [
      moveWall(plan, wallId, p(200, 100)), resizeWall(plan, wallId, 5_000),
      setWallThickness(plan, wallId, 200), toggleDimension(plan, wallId), setDimensionOffset(plan, wallId, -800),
    ]) {
      expect(next.angleDimensions).toEqual(plan.angleDimensions);
    }
  });

  it.each(["wallA", "wallB"] as const)("cascades angles when %s is deleted and retains unrelated angles", reference => {
    let plan = annotatedCorner();
    const original = firstAngle(plan);
    plan = addOpening(plan, original[reference], "window", 1_000, 500);
    plan = addWall(plan, p(10_000, 0), p(13_000, 0), 100);
    plan = addWall(plan, p(10_000, 0), p(10_000, 3_000), 100);
    const wallA = plan.walls[2]!.id;
    const wallB = plan.walls[3]!.id;
    plan = addAngleDimension(plan, {
      wallA, wallB, vertex: angleVertex(plan, wallA, wallB).id, radius: 800, clockwise: false,
    });
    const before = JSON.stringify(plan);
    const next = deleteWall(plan, original[reference]);
    expect(next.angleDimensions).toEqual([plan.angleDimensions![1]]);
    expect(next.openings).toEqual([]);
    expect(JSON.stringify(plan)).toBe(before);
    expect(validatePlan(next)).toEqual(next);
  });

  it("keeps annotations at both ends on their adjacent segment, along with openings", () => {
    let plan = addWall(createEmptyPlan(), p(0, 0), p(6_000, 0), 150);
    const originalWall = plan.walls[0]!;
    plan = addWall(plan, p(0, 0), p(0, 3_000), 100);
    plan = addWall(plan, p(6_000, 0), p(6_000, 3_000), 100);
    plan = addAngleDimension(plan, {
      wallA: originalWall.id, wallB: plan.walls[1]!.id, vertex: originalWall.a, radius: 500, clockwise: true,
    });
    plan = addAngleDimension(plan, {
      wallA: plan.walls[2]!.id, wallB: originalWall.id, vertex: originalWall.b, radius: 700, clockwise: false,
    });
    plan = addOpening(plan, originalWall.id, "window", 750, 500);
    plan = addOpening(plan, originalWall.id, "door", 5_000, 800);
    const before = JSON.stringify(plan);
    const next = addWall(plan, p(2_000, 0), p(2_000, 2_000), 100);
    const first = wallFrom(next, p(0, 0), p(2_000, 0));
    const last = wallFrom(next, p(2_000, 0), p(6_000, 0));
    expect(first.id).toBe(originalWall.id);
    expect(last.id).not.toBe(originalWall.id);
    expect(next.angleDimensions![0]).toEqual(plan.angleDimensions![0]);
    expect(next.angleDimensions![1]).toEqual({ ...plan.angleDimensions![1], wallB: last.id });
    expect(next.openings[0]).toMatchObject({ wallId: first.id, offset: 750 });
    expect(next.openings[1]).toMatchObject({ wallId: last.id, offset: 3_000 });
    expect(JSON.stringify(plan)).toBe(before);
    const splitAgain = addWall(next, p(4_000, 0), p(4_000, 2_000), 100);
    const final = wallFrom(splitAgain, p(4_000, 0), p(6_000, 0));
    expect(splitAgain.angleDimensions![1]).toEqual({ ...plan.angleDimensions![1], wallB: final.id });
    expect(splitAgain.openings[1]).toMatchObject({ wallId: final.id, offset: 1_000 });
    expect(deleteWall(splitAgain, originalWall.id).angleDimensions).toEqual([splitAgain.angleDimensions![1]]);
  });

  it("reattaches both wall references when one new wall splits both rays at their far ends", () => {
    let plan = addWall(createEmptyPlan(), p(4_000, 0), p(0, 0), 150);
    plan = addWall(plan, p(0, 4_000), p(0, 0), 150);
    plan = addAngleDimension(plan, annotation(plan));
    const before = JSON.stringify(plan);
    const original = firstAngle(plan);
    const next = addWall(plan, p(2_000, 0), p(0, 2_000), 100);
    const first = wallFrom(next, p(2_000, 0), p(0, 0));
    const second = wallFrom(next, p(0, 2_000), p(0, 0));
    expect(first.id).not.toBe(original.wallA);
    expect(second.id).not.toBe(original.wallB);
    expect(firstAngle(next)).toEqual({ ...original, wallA: first.id, wallB: second.id });
    expect(angleVertex(next, first.id, second.id).id).toBe(original.vertex);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("reattaches a far-end angle even when splitting through an opening on an already invalid wall", () => {
    let plan = addWall(createEmptyPlan(), p(0, 0), p(4_000, 0), 150);
    const originalWall = plan.walls[0]!;
    plan = addWall(plan, p(4_000, 0), p(4_000, 3_000), 100);
    plan = addAngleDimension(plan, annotation(plan));
    plan = addOpening(plan, originalWall.id, "door", 2_000, 1_000);
    plan = addOpening(plan, originalWall.id, "window", 5_000, 500);
    const originalAngle = firstAngle(plan);
    const next = addWall(plan, p(2_000, 0), p(2_000, 2_000), 100);
    const last = wallFrom(next, p(2_000, 0), p(4_000, 0));
    expect(firstAngle(next)).toEqual({ ...originalAngle, wallA: last.id });
    expect(next.openings).toHaveLength(2);
    expect(next.openings.map(opening => opening.id)).toEqual(plan.openings.map(opening => opening.id));
    expect(next.openings.map(opening => opening.offset)).toEqual([0, 3_000]);
    expect(getGeometryIssues(next).find(issue => issue.code === "opening-outside")!.openingIds).toHaveLength(2);
    expect(validatePlan(next)).toEqual(next);
  });

  it("keeps overlapping annotated rays editable without creating a second shared vertex", () => {
    const original = annotatedCorner();
    const dimension = firstAngle(original);
    const overlapping = moveNode(original, original.walls[1]!.b, p(3_000, 0));
    expect(getGeometryIssues(overlapping)).toContainEqual(expect.objectContaining({ code: "wall-overlap" }));
    const next = addWall(overlapping, p(2_000, 0), p(2_000, 2_000), 100);
    expect(next.angleDimensions).toEqual(overlapping.angleDimensions);
    expect(angleVertex(next, dimension.wallA, dimension.wallB).id).toBe(dimension.vertex);
    expect(next.walls).toHaveLength(3);
    expect(validatePlan(next)).toEqual(next);
    expect(getGeometryIssues(next).map(issue => issue.code)).toEqual(expect.arrayContaining(["wall-overlap", "wall-crossing"]));
  });

  it("follows the end segment when a reused room boundary splits a wall twice", () => {
    let plan = addRoom(createEmptyPlan(), p(0, 0), p(4_000, 4_000), 150);
    const right = wallFrom(plan, p(4_000, 0), p(4_000, 4_000));
    const bottom = wallFrom(plan, p(4_000, 4_000), p(0, 4_000));
    plan = addAngleDimension(plan, {
      wallA: right.id, wallB: bottom.id, vertex: angleVertex(plan, right.id, bottom.id).id,
      radius: 850, clockwise: false,
    });
    plan = addOpening(plan, right.id, "window", 3_500, 500);
    const original = firstAngle(plan);
    const next = addRoom(plan, p(4_000, 1_000), p(6_000, 3_000), 100);
    const end = wallFrom(next, p(4_000, 3_000), p(4_000, 4_000));
    expect(firstAngle(next)).toEqual({ ...original, wallA: end.id });
    expect(next.openings[0]).toMatchObject({ wallId: end.id, offset: 500 });
    expect(validatePlan(next)).toEqual(next);
  });
});
