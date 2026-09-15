import { describe, expect, it } from "vitest";
import {
  addAngleDimension, addOpening, addRoom, addWall, createDemoPlan, createEmptyPlan, deleteNode, detectRooms,
  getGeometryIssues, getNodeDeletionInfo, moveNode, renameRoom, setDimensionOffset, splitWall, validatePlan,
  type Opening, type Plan,
} from "./model";
import { openingPoints } from "./geometryFeedback";
import { anglePosition } from "./angles";
import { wallGeometry } from "./wallGeometry";

const chain = (reverseFirst = false, reverseSecond = false): Plan => validatePlan({
  ...createEmptyPlan(),
  nodes: [{ id: "a", x: 0, y: 0 }, { id: "n", x: 2000, y: 0 }, { id: "b", x: 4000, y: 0 }],
  walls: [
    { id: "first", a: reverseFirst ? "n" : "a", b: reverseFirst ? "a" : "n", thickness: 150, dimension: true },
    { id: "second", a: reverseSecond ? "b" : "n", b: reverseSecond ? "n" : "b", thickness: 150, dimension: true },
  ],
});

function openingCenter(plan: Plan, opening: Opening) {
  const [a, b] = openingPoints(plan, opening)!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

describe("deleting selected nodes", () => {
  it("reverses a wall split without losing rooms, openings, dimensions or endpoint angles", () => {
    let original = createDemoPlan();
    const wall = original.walls.find(wall => wall.a === original.nodes.find(node => node.x === 0 && node.y === 0)!.id)!;
    const neighbor = original.walls.find(item => item.id !== wall.id && (item.a === wall.a || item.b === wall.a))!;
    original = addAngleDimension(original, { wallA: wall.id, wallB: neighbor.id, vertex: wall.a, radius: 800, clockwise: true });
    original = setDimensionOffset(original, wall.id, -700);
    const split = splitWall(original, wall.id, 1000);
    const before = JSON.stringify(split);
    const info = getNodeDeletionInfo(split, split.nodes.at(-1)!.id);
    expect(info).toMatchObject({ joinsWalls: true, removedOpenings: 0, removedAngles: 0, changesStyle: false });
    expect(deleteNode(split, split.nodes.at(-1)!.id)).toEqual(original);
    expect(JSON.stringify(split)).toBe(before);
  });

  for (const reverseFirst of [false, true]) for (const reverseSecond of [false, true]) {
    it(`preserves openings with wall directions ${reverseFirst}/${reverseSecond}`, () => {
      let plan = chain(reverseFirst, reverseSecond);
      for (const wall of plan.walls) {
        plan = addOpening(plan, wall.id, "door", 800, 600);
        plan = addOpening(plan, wall.id, "window", -200, 300);
        plan = addOpening(plan, wall.id, "window", 2500, 400);
      }
      const next = deleteNode(plan, "n");
      expect(next.nodes.map(node => node.id)).toEqual(["a", "b"]);
      expect(next.walls).toHaveLength(1);
      expect(next.walls[0]).toMatchObject({ id: "first", a: reverseFirst ? "b" : "a", b: reverseFirst ? "a" : "b" });
      expect(next.openings.map(opening => opening.id)).toEqual(plan.openings.map(opening => opening.id));
      plan.openings.forEach((opening, i) => {
        expect(openingCenter(next, next.openings[i])).toEqual(openingCenter(plan, opening));
        expect(next.openings[i].width).toBe(opening.width);
        if (opening.kind === "door") {
          const reversed = opening.wallId === "second" && reverseFirst !== reverseSecond;
          expect(next.openings[i].flip).toBe(reversed);
          expect(!!next.openings[i].hingeAtEnd).toBe(reversed);
        }
      });
      expect(validatePlan(JSON.parse(JSON.stringify(next)))).toEqual(next);
    });
  }

  it("projects openings onto a straightened corner, preserves room names, and removes its angle", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Studio");
    const [first, second, third] = plan.walls;
    plan = addOpening(plan, first.id, "window", 1000, 600);
    plan = addAngleDimension(plan, { wallA: first.id, wallB: second.id, vertex: first.b, radius: 500, clockwise: true });
    plan = addAngleDimension(plan, { wallA: second.id, wallB: third.id, vertex: second.b, radius: 500, clockwise: true });
    const remainingAngle = plan.angleDimensions![1];
    expect(getNodeDeletionInfo(plan, first.b)).toMatchObject({ joinsWalls: true, removedOpenings: 0, removedAngles: 1 });
    const next = deleteNode(plan, first.b);
    expect(detectRooms(next)[0]).toMatchObject({ name: "Studio", area: 6_000_000 });
    expect(next.openings[0].offset).toBeCloseTo(800);
    expect(next.openings[0].width).toBe(600);
    expect(next.angleDimensions).toEqual([{ ...remainingAngle, wallA: first.id }]);
    expect(Number.isFinite(anglePosition(next, next.angleDimensions![0]).degrees)).toBe(true);
    expect(getGeometryIssues(next)).toEqual([]);
    expect(wallGeometry(next).outlines).toHaveLength(2);
  });

  it("removes a branching junction and only its attached walls and annotations", () => {
    let plan = createDemoPlan();
    const node = plan.nodes.find(node => node.x === 4200 && node.y === 0)!;
    const attached = plan.walls.filter(wall => wall.a === node.id || wall.b === node.id);
    plan = addAngleDimension(plan, { wallA: attached[0].id, wallB: attached[1].id, vertex: node.id, radius: 600, clockwise: true });
    const ids = new Set(attached.map(wall => wall.id));
    expect(getNodeDeletionInfo(plan, node.id)).toMatchObject({ joinsWalls: false, wallCount: 3, removedOpenings: 3, removedAngles: 1 });
    const next = deleteNode(plan, node.id);
    expect(next.walls).toEqual(plan.walls.filter(wall => !ids.has(wall.id)));
    expect(next.openings).toEqual(plan.openings.filter(opening => !ids.has(opening.wallId)));
    expect(next.angleDimensions).toEqual([]);
    expect(next.nodes.every(node => next.walls.some(wall => wall.a === node.id || wall.b === node.id))).toBe(true);
    expect(next.nodes.some(item => item.id === node.id)).toBe(false);
    expect(validatePlan(next)).toEqual(next);
  });

  it("deletes a free endpoint and prunes the other endpoint when no walls remain", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
    plan = addOpening(plan, plan.walls[0].id, "door", 2000, 900);
    expect(getNodeDeletionInfo(plan, plan.nodes[0].id)).toMatchObject({ joinsWalls: false, wallCount: 1, removedOpenings: 1 });
    expect(deleteNode(plan, plan.nodes[0].id)).toEqual(createEmptyPlan());
  });

  it("keeps an enclosed room's name when an interior dangling endpoint is removed", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = addWall(plan, { x: 2000, y: 0 }, { x: 2000, y: 1000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Workshop");
    const node = plan.nodes.find(node => node.x === 2000 && node.y === 1000)!;
    const next = deleteNode(plan, node.id);
    expect(detectRooms(next)[0]).toMatchObject({ name: "Workshop", area: 12_000_000 });
  });

  it("handles coincident endpoints, duplicate neighbors, and collapsed walls without invalid references", () => {
    let plan = chain();
    plan = addOpening(plan, "first", "door", 800, 600);
    const collapsed = moveNode(plan, "a", { x: 4000, y: 0 });
    const next = deleteNode(collapsed, "n");
    expect(next.walls).toHaveLength(1);
    expect(next.openings).toHaveLength(1);
    expect(getGeometryIssues(next)).toContainEqual(expect.objectContaining({ code: "short-wall" }));
    expect(wallGeometry(next).outlines).toEqual([]);
    const duplicate = validatePlan({ ...chain(), nodes: chain().nodes.filter(node => node.id !== "b"),
      walls: chain().walls.map(wall => ({ ...wall, a: "a", b: "n" })) });
    expect(getNodeDeletionInfo(duplicate, "n").joinsWalls).toBe(false);
    expect(deleteNode(duplicate, "n")).toEqual(createEmptyPlan());
    const short = moveNode(plan, "n", { x: 0, y: 0 });
    expect(deleteNode(short, "n").openings[0].offset).toBe(800);
  });

  it("drops angles made ambiguous by deleting a triangle corner instead of leaving broken references", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
    plan = addWall(plan, { x: 4000, y: 0 }, { x: 2000, y: 3000 }, 150);
    plan = addWall(plan, { x: 2000, y: 3000 }, { x: 0, y: 0 }, 150);
    const [first, second, third] = plan.walls;
    plan = addAngleDimension(plan, { wallA: first.id, wallB: third.id, vertex: first.a, radius: 500, clockwise: true });
    plan = addAngleDimension(plan, { wallA: second.id, wallB: third.id, vertex: second.b, radius: 500, clockwise: true });
    expect(getNodeDeletionInfo(plan, first.b).removedAngles).toBe(2);
    expect(deleteNode(plan, first.b).angleDimensions).toEqual([]);
  });

  it("reports style changes and retains first-wall settings while keeping visible dimensions", () => {
    const plan = validatePlan({ ...chain(), walls: [
      { ...chain().walls[0], thickness: 200, dimension: false, dimensionOffset: -700 },
      { ...chain().walls[1], thickness: 100, dimensionOffset: 900 },
    ] });
    expect(getNodeDeletionInfo(plan, "n").changesStyle).toBe(true);
    expect(deleteNode(plan, "n").walls[0]).toMatchObject({ thickness: 200, dimension: true, dimensionOffset: -700 });
  });

  it("validates optional door hinge data without loosening unrelated project validation", () => {
    const plan = addOpening(chain(), "first", "door", 1000, 600);
    const opening = plan.openings[0];
    expect(validatePlan({ ...plan, openings: [{ ...opening, hingeAtEnd: true }] }).openings[0].hingeAtEnd).toBe(true);
    expect(Object.hasOwn(validatePlan(plan).openings[0], "hingeAtEnd")).toBe(false);
    for (const hingeAtEnd of [1, "true", null, undefined]) {
      expect(() => validatePlan({ ...plan, openings: [{ ...opening, hingeAtEnd }] })).toThrow(/hinge/);
    }
    expect(() => validatePlan({ ...plan, openings: [{ ...opening, kind: "window", hingeAtEnd: true }] })).toThrow(/hinge/);
  });

  it("reports a missing node and leaves the input untouched", () => {
    const plan = chain();
    const before = JSON.stringify(plan);
    expect(() => deleteNode(plan, "missing")).toThrow(/junction no longer exists/);
    expect(() => getNodeDeletionInfo(plan, "missing")).toThrow(/junction no longer exists/);
    expect(JSON.stringify(plan)).toBe(before);
  });
});
