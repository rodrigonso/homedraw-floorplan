import { describe, expect, it } from "vitest";
import { anglePosition } from "./angles";
import { dimensionPosition } from "./dimensions";
import { openingPoints } from "./geometryFeedback";
import {
  addAngleDimension, addOpening, addRoom, addWall, createEmptyPlan, deleteAngleDimension, deleteNode,
  deleteOpening, deleteThicknessDimension, deleteWall, detectRooms,
  formatLength, getGeometryIssues, moveNode, renameRoom, splitWall, toggleDimension, validatePlan, type Plan,
} from "./model";
import { deleteSelection, getMarqueeSelection, getSelectionNodeIds, moveSelection, selectionBounds, type SelectionItem } from "./selection";

const item = (kind: SelectionItem["kind"], id: string): SelectionItem => ({ kind, id });
const wallItem = item("wall", "horizontal");
const nodeItem = item("node", "a");
const doorItem = item("door", "door");
const windowItem = item("window", "window");
const angleItem = item("angle", "angle");
const dimensionItem = item("dimension", "horizontal");

function corner(): Plan {
  return validatePlan({
    ...createEmptyPlan(),
    nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 0, y: 4000 }],
    walls: [
      { id: "horizontal", a: "a", b: "b", thickness: 200, dimension: true, dimensionOffset: -600 },
      { id: "vertical", a: "a", b: "c", thickness: 100, dimension: false },
    ],
    openings: [
      { id: "door", wallId: "horizontal", kind: "door", offset: 2000, width: 800, flip: false, hingeAtEnd: true },
      { id: "window", wallId: "vertical", kind: "window", offset: 2000, width: 600, flip: true },
    ],
    angleDimensions: [{ id: "angle", wallA: "horizontal", wallB: "vertical", vertex: "a", radius: 500, clockwise: true }],
  });
}

function bareCorner(): Plan {
  return validatePlan({ ...corner(), openings: [], angleDimensions: [] });
}

function box(plan: Plan, left: number, top: number, right: number, bottom: number, showDimensions = true) {
  return getMarqueeSelection(plan, { x: left, y: top }, { x: right, y: bottom }, showDimensions);
}

describe("marquee selection", () => {
  it("does not expand selection bounds for hidden angle measurements", () => {
    const plan = validatePlan({ ...bareCorner(), angleDimensions: [{ ...corner().angleDimensions![0], radius: 7000 }] });
    expect(selectionBounds(plan, [wallItem], false)).toEqual({ x: 0, y: -100, width: 4000, height: 200 });
    expect(selectionBounds(plan, [wallItem])!.height).toBeGreaterThan(7000);
    expect(selectionBounds(plan, [angleItem], false)).toBeNull();
  });

  it.each([
    [{ x: -100, y: -100 }, { x: 4000, y: 100 }],
    [{ x: 4000, y: -100 }, { x: -100, y: 100 }],
    [{ x: -100, y: 100 }, { x: 4000, y: -100 }],
    [{ x: 4000, y: 100 }, { x: -100, y: -100 }],
  ])("fully contains walls in either drag direction (%j to %j)", (start, end) => {
    expect(getMarqueeSelection(corner(), start, end, true)).toEqual([wallItem]);
  });

  it("includes edges precisely, but not a wall whose thickness exceeds the box", () => {
    expect(box(bareCorner(), 0, -100, 4000, 100)).toEqual([wallItem]);
    expect(box(bareCorner(), 0, -100 + 1e-7, 4000, 100)).toEqual([wallItem]);
    expect(box(bareCorner(), 0, -100 + 1e-4, 4000, 100)).toEqual([nodeItem, item("node", "b")]);
  });

  it("does not select crossing, intersecting, or overlapping-bounds diagonal walls", () => {
    const plan = validatePlan({
      ...createEmptyPlan(),
      nodes: [{ id: "a", x: -2000, y: -2000 }, { id: "b", x: 2000, y: 2000 }],
      walls: [{ id: "diagonal", a: "a", b: "b", thickness: 200, dimension: true }],
    });
    expect(box(plan, -500, -500, 500, 500)).toEqual([]);
    expect(box(plan, 1000, -2000, 2000, -1000)).toEqual([]);
    expect(box(plan, 500, 500, -500, -500)).toEqual([]);
    expect(box(plan, -2100, -2100, 2100, 2100)).toEqual([item("wall", "diagonal")]);
    expect(box(plan, -2000, -2000, 2000, 2000)).toEqual([nodeItem, item("node", "b")]);
  });

  it("selects only the center of a junction when its attached walls are not enclosed", () => {
    expect(box(corner(), -1, -1, 1, 1)).toEqual([nodeItem]);
  });

  it.each([[0, 0, 0, 0], [-100, 0, 100, 0], [0, -100, 0, 100], [5000, 5000, 6000, 6000]])(
    "ignores empty or zero-area boxes %s,%s,%s,%s", (left, top, right, bottom) => {
      expect(box(corner(), left, top, right, bottom)).toEqual([]);
    },
  );

  it("requires a window's full wall thickness, not just its center or segment", () => {
    expect(box(corner(), -50, 1700, 50, 2300)).toEqual([windowItem]);
    expect(box(corner(), -49, 1700, 50, 2300)).toEqual([]);
    expect(box(corner(), -50, 1701, 50, 2300)).toEqual([]);
  });

  it("retains the thickness of minimum-width openings on rotated hosts", () => {
    const plan = validatePlan({
      ...bareCorner(), nodes: bareCorner().nodes.map(node => node.id === "b" ? { ...node, x: 3000, y: 4000 } : node),
      openings: [{ id: "window", wallId: "horizontal", kind: "window", offset: 5000, width: 1, flip: false }],
    });
    const bounds = selectionBounds(plan, [windowItem])!;
    expect(bounds.width).toBeCloseTo(160.6);
    expect(bounds.height).toBeCloseTo(120.8);
    expect(box(plan, 2999, 3999, 3001, 4001)).not.toContainEqual(windowItem);
  });

  it.each([false, true])("includes the whole door swing with flip=%s and either hinge", flip => {
    for (const hingeAtEnd of [false, true]) {
      const plan = validatePlan({ ...corner(), openings: [
        { ...corner().openings[0], flip, hingeAtEnd },
      ] });
      const top = flip ? -800 : -100, bottom = flip ? 100 : 800;
      expect(box(plan, 1600, top, 2400, bottom)).toEqual([doorItem]);
      expect(box(plan, 1600, -100, 2400, 100)).toEqual([]);
      expect(box(plan, 1601, top, 2400, bottom)).toEqual([]);
    }
  });

  it("contains a rotated door's sector extrema, including between arc sample points", () => {
    const rotation = Math.PI / 7;
    const plan = validatePlan({ ...corner(), nodes: corner().nodes.map(node => ({
      ...node, x: node.x * Math.cos(rotation) - node.y * Math.sin(rotation),
      y: node.x * Math.sin(rotation) + node.y * Math.cos(rotation),
    })) });
    const bounds = selectionBounds(plan, [doorItem])!;
    expect(box(plan, bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height)).toContainEqual(doorItem);
    expect(box(plan, bounds.x, bounds.y, bounds.x + bounds.width - 0.001, bounds.y + bounds.height)).not.toContainEqual(doorItem);
    const opening = plan.openings[0], [start, end] = openingPoints(plan, opening)!;
    const hinge = opening.hingeAtEnd ? end : start;
    for (let i = 0; i <= 1000; i++) {
      const theta = rotation + Math.PI - i / 1000 * Math.PI / 2;
      const point = { x: hinge.x + opening.width * Math.cos(theta), y: hinge.y + opening.width * Math.sin(theta) };
      expect(point.x).toBeGreaterThanOrEqual(bounds.x - 1e-6);
      expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-6);
      expect(point.y).toBeGreaterThanOrEqual(bounds.y - 1e-6);
      expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-6);
    }
  });

  it("requires angular arcs, extensions, ticks and label bounds, and honors hidden dimensions", () => {
    const plan = corner();
    const bounds = selectionBounds(plan, [angleItem])!;
    const enclosed = box(plan, bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height);
    expect(enclosed).toContainEqual(angleItem);
    expect(box(plan, bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height, false)).not.toContainEqual(angleItem);
    expect(box(plan, 0, 0, 500, 500)).not.toContainEqual(angleItem);
    expect(box(plan, 0, 0, 579, 580)).not.toContainEqual(angleItem);
    const small = validatePlan({ ...plan, angleDimensions: [{ ...plan.angleDimensions![0], radius: 100 }] });
    const smallBounds = selectionBounds(small, [angleItem])!;
    expect(smallBounds.x).toBeLessThan(0);
    expect(box(small, 0, 0, 180, 180)).not.toContainEqual(angleItem);
  });

  it("handles reflex angular geometry instead of selecting its label alone", () => {
    const plan = validatePlan({ ...corner(), angleDimensions: [{ ...corner().angleDimensions![0], clockwise: false }] });
    expect(box(plan, -600, -600, 600, 600)).toContainEqual(angleItem);
    expect(box(plan, -600, -600, 0, 0)).not.toContainEqual(angleItem);
  });

  it("omits derived rooms and redundant children of selected walls", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = addOpening(plan, plan.walls[0].id, "door", 2000, 800);
    plan = addAngleDimension(plan, {
      wallA: plan.walls[0].id, wallB: plan.walls[1].id, vertex: plan.walls[0].b, radius: 500, clockwise: true,
    });
    expect(box(plan, -5000, -5000, 10000, 10000)).toEqual(plan.walls.map(wall => item("wall", wall.id)));
    expect(box(corner(), -100, -100, 4000, 1000)).toEqual([wallItem]);
  });

  it("safely bounds collapsed opening hosts and marquees unavailable angle warning labels", () => {
    const plan = moveNode(corner(), "b", { x: 0, y: 0 });
    expect(selectionBounds(plan, [doorItem])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(selectionBounds(plan, [angleItem])).toEqual({ x: -680, y: -240, width: 1360, height: 200 });
    expect(box(plan, -1, -1, 1, 1)).not.toContainEqual(doorItem);
    for (const short of [plan, moveNode(corner(), "b", { x: 0.5, y: 0 })]) {
      expect(box(short, -0.1, -0.1, 0.1, 0.1)).not.toContainEqual(angleItem);
      expect(box(short, -680, -240, 680, -40)).toEqual([angleItem]);
      expect(box(short, -680, -240, 680, -40, false)).toEqual([]);
      expect(selectionBounds(short, [angleItem], false)).toBeNull();
      for (const coordinates of [
        [-679.99, -240, 680, -40], [-680, -239.99, 680, -40],
        [-680, -240, 679.99, -40], [-680, -240, 680, -40.01],
      ]) {
        expect(box(short, coordinates[0], coordinates[1], coordinates[2], coordinates[3])).toEqual([]);
      }
      expect(deleteSelection(short, [angleItem])).toEqual({ ...short, angleDimensions: [] });
      expect(() => moveSelection(short, [angleItem], { x: 100, y: 0 })).toThrow(/junctions apart/);
    }
  });

  it("rejects nonfinite marquee coordinates", () => {
    expect(() => box(corner(), NaN, 0, 100, 100)).toThrow(/finite/);
    expect(() => box(corner(), 0, 0, Infinity, 100)).toThrow(/finite/);
    expect(() => box(corner(), -Number.MAX_VALUE, 0, Number.MAX_VALUE, 100)).toThrow(/finite/);
  });

  it("allows finite marquee coordinates beyond the model's mutation limits", () => {
    expect(box(corner(), -1000000, -1000000, 1000000, 1000000)).toEqual([
      wallItem, item("wall", "vertical"),
    ]);
    expect(box(corner(), 200000, 200000, 300000, 300000)).toEqual([]);
  });
});

describe("selection bounds", () => {
  it("shares the exact moving-node set with translation snapping, without counting attachments twice", () => {
    expect(new Set(getSelectionNodeIds(corner(), [wallItem, nodeItem, doorItem, angleItem]))).toEqual(new Set(["a", "b"]));
    expect(getSelectionNodeIds(corner(), [doorItem, angleItem])).toEqual([]);
    const room = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    expect(new Set(getSelectionNodeIds(room, [item("room", detectRooms(room)[0].id)]))).toEqual(new Set(room.nodes.map(node => node.id)));
    expect(() => getSelectionNodeIds(corner(), [item("node", "missing")])).toThrow(/no longer exists/);
  });

  it("returns null for empty selection and exact wall/node bounds without unrelated bodies", () => {
    expect(selectionBounds(corner(), [])).toBeNull();
    expect(selectionBounds(bareCorner(), [wallItem])).toEqual({ x: 0, y: -100, width: 4000, height: 200 });
    expect(selectionBounds(bareCorner(), [nodeItem])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(selectionBounds(bareCorner(), [wallItem, nodeItem, wallItem])).toEqual(selectionBounds(bareCorner(), [wallItem]));
  });

  it("encompasses attached annotations, including openings on a connected wall affected by a selected endpoint", () => {
    const bounds = selectionBounds(corner(), [wallItem])!;
    expect(bounds.x).toBe(-50);
    expect(bounds.y).toBe(-100);
    expect(bounds.x + bounds.width).toBe(4000);
    expect(bounds.y + bounds.height).toBe(2300);
    expect(selectionBounds(corner(), [wallItem, doorItem, angleItem])).toEqual(bounds);
  });

  it("expands room items to their boundary geometry", () => {
    const plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 200);
    const room = detectRooms(plan)[0];
    expect(selectionBounds(plan, [item("room", room.id)])).toEqual({
      x: -100, y: -100, width: 4200, height: 3200,
    });
  });

  it("recovers a room's stable boundary bounds when live movement creates crossing warnings", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 200);
    const room = detectRooms(plan)[0], selection = [item("room", room.id)];
    plan = addWall(plan, { x: 6000, y: -1000 }, { x: 6000, y: 4000 }, 100);
    const preview = moveSelection(plan, selection, { x: 5000, y: 0 });
    expect(getGeometryIssues(preview).some(issue => issue.code === "wall-crossing")).toBe(true);
    expect(detectRooms(preview).some(candidate => candidate.id === room.id)).toBe(false);
    expect(selectionBounds(preview, selection)).toEqual({ x: 4900, y: -100, width: 4200, height: 3200 });
    expect(() => deleteSelection(preview, selection)).toThrow(/no longer exists/);
  });

  it("keeps room bounds safe when a boundary segment collapses during a live preview", () => {
    const plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 200);
    const room = detectRooms(plan)[0];
    const preview = moveNode(plan, plan.nodes[1].id, plan.nodes[0]);
    expect(detectRooms(preview).some(candidate => candidate.id === room.id)).toBe(false);
    const bounds = selectionBounds(preview, [item("room", room.id)]);
    expect(bounds).not.toBeNull();
    expect(Object.values(bounds!).every(Number.isFinite)).toBe(true);
    expect(() => selectionBounds(preview, [item("room", "room:missing:other:stale")])).toThrow(/no longer exists/);
  });
});

describe("moving a selection", () => {
  it("moves shared endpoints once, preserves metadata, and leaves unselected far nodes alone", () => {
    const plan = corner(), snapshot = JSON.stringify(plan);
    const next = moveSelection(plan, [wallItem, nodeItem, wallItem, doorItem, angleItem], { x: 100, y: 200 });
    expect(next.nodes).toEqual([
      { id: "a", x: 100, y: 200 }, { id: "b", x: 4100, y: 200 }, { id: "c", x: 0, y: 4000 },
    ]);
    expect(next.walls).toEqual(plan.walls);
    expect(next.openings).toEqual(plan.openings);
    expect(next.angleDimensions).toEqual(plan.angleDimensions);
    expect(JSON.stringify(plan)).toBe(snapshot);
    const all = moveSelection(plan, [wallItem, item("wall", "vertical"), nodeItem], { x: 100, y: 200 });
    expect(all.nodes).toEqual(plan.nodes.map(node => ({ ...node, x: node.x + 100, y: node.y + 200 })));
  });

  it("lets an explicitly selected opening and angle follow affected, unselected hosts without double modification", () => {
    const plan = corner();
    const next = moveSelection(plan, [nodeItem, doorItem, windowItem, angleItem], { x: 150, y: -250 });
    expect(next.nodes[0]).toMatchObject({ x: 150, y: -250 });
    expect(next.openings).toEqual(plan.openings);
    expect(next.angleDimensions).toEqual(plan.angleDimensions);
    const endpoint = moveSelection(plan, [item("node", "b"), angleItem], { x: 0, y: 100 });
    expect(endpoint.angleDimensions).toEqual(plan.angleDimensions);
  });

  it("projects standalone openings along their host axes, retaining overhangs and all metadata", () => {
    const plan = corner();
    const next = moveSelection(plan, [doorItem, windowItem, doorItem], { x: -3500, y: 3000 });
    expect(next.nodes).toEqual(plan.nodes);
    expect(next.openings).toEqual([
      { ...plan.openings[0], offset: -1500 }, { ...plan.openings[1], offset: 5000 },
    ]);
    expect(getGeometryIssues(next).some(issue => issue.code === "opening-outside")).toBe(true);
    const reversed = validatePlan({ ...plan, walls: plan.walls.map(wall => ({ ...wall, a: wall.b, b: wall.a })) });
    expect(moveSelection(reversed, [doorItem], { x: 100, y: 50 }).openings[0].offset).toBe(1900);
  });

  it("projects rotated standalone openings without clamping to the host", () => {
    const plan = moveNode(corner(), "b", { x: 3000, y: 4000 });
    expect(moveSelection(plan, [doorItem], { x: 100, y: 200 }).openings[0].offset).toBe(2220);
  });

  it("adjusts standalone angle radii along the original bisector with a 100 mm minimum", () => {
    const plan = corner(), { axis } = anglePosition(plan, plan.angleDimensions![0]);
    const next = moveSelection(plan, [angleItem, angleItem], { x: axis.x * 100, y: axis.y * 100 });
    expect(next.angleDimensions![0]).toEqual({ ...plan.angleDimensions![0], radius: 600 });
    expect(next.nodes).toEqual(plan.nodes);
    expect(moveSelection(plan, [angleItem], { x: -1000, y: -1000 }).angleDimensions![0].radius).toBe(100);
  });

  it("moves room boundaries while preserving names, node IDs, and wall settings", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const room = detectRooms(plan)[0];
    plan = renameRoom(plan, room.id, "Studio");
    const next = moveSelection(plan, [item("room", room.id), item("wall", plan.walls[0].id)], { x: -100, y: 300 });
    expect(next.nodes).toEqual(plan.nodes.map(node => ({ ...node, x: node.x - 100, y: node.y + 300 })));
    expect(next.roomNames).toEqual(plan.roomNames);
    expect(next.walls).toEqual(plan.walls);
    expect(detectRooms(next)[0].name).toBe("Studio");
  });

  it("does not merge coincident nodes or reject spatial warnings", () => {
    const plan = corner();
    const next = moveSelection(plan, [item("node", "b")], { x: -4000, y: 4000 });
    expect(next.nodes).toHaveLength(3);
    expect(next.walls).toEqual(plan.walls);
    expect(getGeometryIssues(next).some(issue => issue.code === "coincident-nodes")).toBe(true);
  });

  it("preserves identity for empty, zero, perpendicular, and minimum-radius no-ops", () => {
    const plan = corner();
    expect(moveSelection(plan, [], { x: 10, y: 20 })).toBe(plan);
    expect(moveSelection(plan, [wallItem], { x: 0, y: 0 })).toBe(plan);
    expect(moveSelection(plan, [doorItem], { x: 0, y: 100 })).toBe(plan);
    const { axis } = anglePosition(plan, plan.angleDimensions![0]);
    expect(moveSelection(plan, [angleItem], { x: -axis.y * 1000, y: axis.x * 1000 })).toBe(plan);
    const minimum = validatePlan({ ...plan, angleDimensions: [{ ...plan.angleDimensions![0], radius: 100 }] });
    expect(moveSelection(minimum, [angleItem], { x: -1000, y: -1000 })).toBe(minimum);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite deltas (%s), even with empty selection", value => {
    expect(() => moveSelection(corner(), [wallItem], { x: value, y: 0 })).toThrow(/finite/);
    expect(() => moveSelection(corner(), [], { x: 0, y: value })).toThrow(/finite/);
  });

  it("enforces node, opening-offset and radius limits atomically, including sub-epsilon overflows", () => {
    const plan = corner(), snapshot = JSON.stringify(plan);
    expect(() => moveSelection(plan, [wallItem], { x: 100001, y: 0 })).toThrow(/100 m/);
    expect(() => moveSelection(plan, [doorItem], { x: 300000, y: 0 })).toThrow(/maximum length/);
    expect(() => moveSelection(plan, [angleItem], { x: 100000, y: 100000 })).toThrow(/radius/);
    expect(moveSelection(plan, [item("node", "b")], { x: 96000, y: 0 }).nodes[1].x).toBe(100000);
    const maximum = validatePlan({ ...plan, angleDimensions: [{ ...plan.angleDimensions![0], radius: 100000 }] });
    expect(() => moveSelection(maximum, [angleItem], { x: 1e-7, y: 1e-7 })).toThrow(/radius/);
    const lastOpeningPosition = 200000 * Math.SQRT2;
    const openingLimit = validatePlan({ ...plan, openings: [{ ...plan.openings[0], offset: lastOpeningPosition }] });
    expect(() => moveSelection(openingLimit, [doorItem], { x: 1e-7, y: 0 })).toThrow(/maximum length/);
    const nodeLimit = moveSelection(plan, [item("node", "b")], { x: 96000, y: 0 });
    expect(() => moveSelection(nodeLimit, [item("node", "b")], { x: 1e-7, y: 0 })).toThrow(/100 m/);
    expect(() => moveSelection(plan, [angleItem], { x: -Number.MAX_VALUE, y: -Number.MAX_VALUE })).toThrow(/finite/);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("rejects standalone movement with undefined directions, but allows affected hosts to recover", () => {
    const plan = moveNode(corner(), "b", { x: 0, y: 0 });
    expect(() => moveSelection(plan, [doorItem], { x: 1, y: 1 })).toThrow(/junctions apart/);
    expect(() => moveSelection(plan, [angleItem], { x: 1, y: 1 })).toThrow(/junctions apart/);
    const next = moveSelection(plan, [item("node", "b"), doorItem, angleItem], { x: 4000, y: 0 });
    expect(next).toEqual(corner());
    expect(moveSelection(plan, [doorItem, angleItem], { x: 0, y: 0 })).toBe(plan);
  });
});

describe("deleting a selection", () => {
  it.each([
    ["node", "a", deleteNode],
    ["wall", "horizontal", deleteWall],
    ["door", "door", deleteOpening],
    ["window", "window", deleteOpening],
    ["angle", "angle", deleteAngleDimension],
    ["thickness", "thickness", deleteThicknessDimension],
    ["dimension", "horizontal", toggleDimension],
  ] as const)("preserves specialized single-%s deletion on valid plans", (kind, id, remove) => {
    const plan = validatePlan({
      ...corner(), thicknessDimensions: [{ id: "thickness", wallId: "horizontal", offset: 350 }],
    });
    const snapshot = JSON.stringify(plan);
    expect(deleteSelection(plan, [item(kind, id)])).toEqual(remove(plan, id));
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("matches existing single-node deletion exactly and deduplicates selected nodes", () => {
    const plan = corner();
    expect(deleteSelection(plan, [nodeItem])).toEqual(deleteNode(plan, "a"));
    expect(deleteSelection(plan, [nodeItem, nodeItem])).toEqual(deleteNode(plan, "a"));
    expect(deleteSelection(plan, [])).toBe(plan);
  });

  it("deletes wall dependencies once without deleting unrelated walls through redundant endpoints", () => {
    const plan = corner(), snapshot = JSON.stringify(plan);
    const items = [wallItem, nodeItem, item("node", "b"), doorItem, angleItem, wallItem];
    const next = deleteSelection(plan, items);
    expect(next).toEqual(deleteWall(plan, "horizontal"));
    expect(next.walls.map(wall => wall.id)).toEqual(["vertical"]);
    expect(next.nodes.map(node => node.id)).toEqual(["a", "c"]);
    expect(deleteSelection(plan, [...items].reverse())).toEqual(next);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("removes explicit openings and angles while preserving unrelated geometry", () => {
    const plan = corner();
    const next = deleteSelection(plan, [doorItem, doorItem, angleItem]);
    expect(next).toEqual({ ...plan, openings: [plan.openings[1]], angleDimensions: [] });
  });

  it("deletes walls before uncovered nodes and skips annotations or nodes already removed by dependencies", () => {
    const plan = corner();
    expect(deleteSelection(plan, [item("node", "c"), angleItem, windowItem, wallItem, doorItem])).toEqual({
      ...createEmptyPlan(), angleDimensions: [],
    });
    expect(deleteSelection(plan, [item("node", "b"), item("node", "c"), doorItem, angleItem])).toEqual({
      ...createEmptyPlan(), angleDimensions: [],
    });
  });

  it("processes selected nodes in original plan order rather than item order", () => {
    const plan = validatePlan({
      ...createEmptyPlan(),
      nodes: [
        { id: "a", x: 0, y: 0 }, { id: "b", x: 1000, y: 1000 },
        { id: "c", x: 2000, y: 0 }, { id: "d", x: 3000, y: 1000 },
      ],
      walls: [
        { id: "first", a: "a", b: "b", thickness: 100, dimension: false },
        { id: "second", a: "b", b: "c", thickness: 150, dimension: true },
        { id: "third", a: "c", b: "d", thickness: 200, dimension: false },
      ],
      openings: [{ id: "door", wallId: "second", kind: "door", offset: 700, width: 600, flip: true, hingeAtEnd: true }],
    });
    const expected = deleteNode(deleteNode(plan, "b"), "c");
    expect(deleteSelection(plan, [item("node", "c"), item("node", "b")])).toEqual(expected);
    expect(deleteSelection(plan, [item("node", "b"), item("node", "c")])).toEqual(expected);
  });

  it("preserves room names and opening/hinge metadata when deleting a split junction", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Workshop");
    plan = addOpening(plan, plan.walls[0].id, "door", 2500, 800);
    plan = validatePlan({ ...plan, openings: [{ ...plan.openings[0], hingeAtEnd: true, flip: true }] });
    const split = splitWall(plan, plan.walls[0].id, 1000);
    const next = deleteSelection(split, [item("node", split.nodes.at(-1)!.id)]);
    expect(next).toEqual(plan);
    expect(detectRooms(next)[0].name).toBe("Workshop");
  });

  it("expands room deletion to boundary walls without removing unrelated walls at boundary nodes", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const room = detectRooms(plan)[0], boundaryIds = new Set(plan.walls.map(wall => wall.id));
    plan = addWall(plan, { x: 0, y: 0 }, { x: -2000, y: 0 }, 150);
    const extra = plan.walls.find(wall => !boundaryIds.has(wall.id))!;
    const next = deleteSelection(plan, [
      item("room", room.id), item("wall", plan.walls[0].id), item("node", extra.a), item("room", room.id),
    ]);
    expect(next.walls).toEqual([extra]);
    expect(next.nodes.map(node => node.id).sort()).toEqual([extra.a, extra.b].sort());
    expect(validatePlan(next)).toEqual(next);
  });

  it("preserves absent angleDimensions when deleting walls", () => {
    const plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 1000, y: 0 }, 100);
    expect(deleteSelection(plan, [item("wall", plan.walls[0].id)])).toEqual(createEmptyPlan());
  });
});

describe("selection reference validation", () => {
  const operations = [
    (plan: Plan, items: SelectionItem[]) => selectionBounds(plan, items),
    (plan: Plan, items: SelectionItem[]) => moveSelection(plan, items, { x: 100, y: 100 }),
    (plan: Plan, items: SelectionItem[]) => deleteSelection(plan, items),
    (plan: Plan, items: SelectionItem[]) => getSelectionNodeIds(plan, items),
  ];

  it.each(["wall", "node", "door", "window", "dimension", "angle", "room", "thickness"] as const)(
    "rejects a missing %s before touching any dependency", kind => {
      const plan = corner(), snapshot = JSON.stringify(plan);
      for (const operation of operations) {
        expect(() => operation(plan, [wallItem, item(kind, "missing")])).toThrow(/selected .*missing.*no longer exists/);
      }
      expect(JSON.stringify(plan)).toBe(snapshot);
    },
  );

  it("rejects mismatched opening roles and stale IDs even for zero movement", () => {
    for (const operation of operations) expect(() => operation(corner(), [item("window", "door")])).toThrow(/window/);
    expect(() => moveSelection(corner(), [item("node", "missing")], { x: 0, y: 0 })).toThrow(/no longer exists/);
  });

  it("rejects disabled length measurements without treating them as walls", () => {
    const plan = corner(), hidden = item("dimension", "vertical");
    for (const operation of operations) {
      expect(() => operation(plan, [dimensionItem, hidden])).toThrow(/selected dimension.*vertical.*no longer exists/);
    }
    expect(() => moveSelection(plan, [hidden], { x: 0, y: 0 })).toThrow(/no longer exists/);
    expect(() => selectionBounds(plan, [hidden], false)).toThrow(/no longer exists/);
    expect(() => moveSelection(plan, [item("dimension", "missing")], { x: 0, y: 0 })).toThrow(/no longer exists/);
  });
});

describe("independent length measurement selection", () => {
  it("bounds and marquees the full callout without selecting its host or attached geometry", () => {
    const plan = corner(), bounds = selectionBounds(plan, [dimensionItem])!;
    expect(bounds).toEqual({ x: -45, y: -720, width: 4090, height: 520 });
    expect(box(plan, -45, -720, 4045, -200)).toEqual([dimensionItem]);
    expect(box(plan, 4045, -200, -45, -720)).toEqual([dimensionItem]);
    expect(box(plan, -45, -720, 4045, -200, false)).toEqual([]);
    expect(selectionBounds(plan, [dimensionItem], false)).toBeNull();
    expect(getSelectionNodeIds(plan, [dimensionItem, dimensionItem])).toEqual([]);
    expect(getSelectionNodeIds(plan, [dimensionItem, doorItem, angleItem])).toEqual([]);
    expect(getSelectionNodeIds(plan, [dimensionItem, wallItem])).toEqual(["a", "b"]);
    expect(selectionBounds(plan, [dimensionItem, dimensionItem])).toEqual(bounds);
    for (const coordinates of [
      [-44.99, -720, 4045, -200], [-45, -719.99, 4045, -200],
      [-45, -720, 4044.99, -200], [-45, -720, 4045, -200.01],
      [1760, -720, 2240, -480],
    ]) {
      expect(box(plan, coordinates[0], coordinates[1], coordinates[2], coordinates[3])).toEqual([]);
    }
    expect(box(plan, -100, -800, 4100, 100)).toEqual([wallItem]);
    const removed = deleteSelection(plan, [dimensionItem]);
    expect(box(removed, -45, -720, 4045, -200)).toEqual([]);
  });

  it.each([-600, 0, 600])("bounds signed offset %s using rendered line, ticks, extensions and label", offset => {
    const plan = validatePlan({
      ...bareCorner(), walls: bareCorner().walls.map(wall => ({ ...wall, dimensionOffset: offset })),
    });
    const bounds = selectionBounds(plan, [dimensionItem])!;
    expect(bounds).toEqual({
      x: -45, y: offset < 0 ? offset - 120 : offset === 0 ? -120 : 200,
      width: 4090, height: offset === 0 ? 240 : 520,
    });
    const withWall = selectionBounds(plan, [wallItem, dimensionItem])!;
    expect(withWall.y).toBeLessThanOrEqual(bounds.y);
    expect(withWall.y + withWall.height).toBeGreaterThanOrEqual(bounds.y + bounds.height);
  });

  it("contains rotated callouts rather than only their axis-aligned labels", () => {
    const plan = moveNode(bareCorner(), "b", { x: 3000, y: 4000 });
    const bounds = selectionBounds(plan, [dimensionItem])!;
    expect(bounds).toEqual({ x: 160, y: -425, width: 3384, height: 4305 });
    expect(box(plan, bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height)).toContainEqual(dimensionItem);
    expect(box(plan, bounds.x + 0.01, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height))
      .not.toContainEqual(dimensionItem);
  });

  it.each([
    { units: "metric", lengthUnits: { metric: "m", imperial: "ft" } },
    { units: "metric", lengthUnits: { metric: "cm", imperial: "ft" } },
    { units: "imperial", lengthUnits: { metric: "m", imperial: "ft" } },
    { units: "imperial", lengthUnits: { metric: "m", imperial: "in" } },
  ] as const)("uses preferred length units for label bounds (%j)", settings => {
    const plan = validatePlan({
      ...bareCorner(), ...settings,
      nodes: bareCorner().nodes.map(node => node.id === "b" ? { ...node, x: 123.4 } : node),
    });
    const halfWidth = Math.max(240, formatLength(123.4, plan).length * 40);
    const bounds = selectionBounds(plan, [dimensionItem])!;
    expect(bounds.x).toBeCloseTo(61.7 - halfWidth);
    expect(bounds.width).toBe(halfWidth * 2);
    expect(box(plan, bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height)).toEqual([dimensionItem]);
    expect(box(plan, bounds.x, bounds.y, bounds.x + bounds.width - 0.01, bounds.y + bounds.height)).toEqual([]);
  });

  it("selects and deletes degenerate warning labels, but rejects movement without a normal", () => {
    for (const length of [0, 0.5]) {
      const plan = moveNode(corner(), "b", { x: length, y: 0 });
      const bounds = selectionBounds(plan, [dimensionItem])!;
      expect(bounds).toEqual({
        x: -formatLength(length, plan).length * 40, y: 160,
        width: formatLength(length, plan).length * 80, height: 200,
      });
      expect(box(plan, bounds.x, 160, bounds.x + bounds.width, 360)).toEqual([dimensionItem]);
      expect(box(plan, bounds.x, 160, bounds.x + bounds.width, 360, false)).toEqual([]);
      expect(() => moveSelection(plan, [dimensionItem], { x: 100, y: 0 })).toThrow(/junctions apart.*dimension/);
      const deleted = deleteSelection(plan, [dimensionItem]);
      expect(deleted).toEqual({ ...plan, walls: [{ ...plan.walls[0], dimension: false }, plan.walls[1]] });
      const repaired = moveSelection(plan, [item("node", "b"), dimensionItem], { x: 4000 - length, y: 0 });
      expect(repaired).toEqual(corner());
    }
  });

  it("moves only offsets along each host normal, deduplicating selected measurements", () => {
    const plan = validatePlan({ ...corner(), walls: corner().walls.map(wall => ({
      ...wall, dimension: true, dimensionOffset: -600,
    })) }), snapshot = JSON.stringify(plan);
    const next = moveSelection(plan, [dimensionItem, item("dimension", "vertical"), dimensionItem], { x: 100, y: 200 });
    expect(next).toEqual({ ...plan, walls: [
      { ...plan.walls[0], dimensionOffset: -400 }, { ...plan.walls[1], dimensionOffset: -700 },
    ] });
    expect(moveSelection(plan, [dimensionItem], { x: 50, y: 800 }).walls[0].dimensionOffset).toBe(200);
    const rotated = moveNode(plan, "b", { x: 3000, y: 4000 });
    expect(moveSelection(rotated, [dimensionItem], { x: 100, y: 200 }).walls[0].dimensionOffset).toBeCloseTo(-560);
    const reversed = validatePlan({ ...plan, walls: plan.walls.map(wall => ({ ...wall, a: wall.b, b: wall.a })) });
    expect(moveSelection(reversed, [dimensionItem], { x: 100, y: 200 }).walls[0].dimensionOffset).toBe(-800);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("retains implicit default placement and optional fields until an actual normal movement", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 200);
    plan = addOpening(plan, plan.walls[0].id, "door", 2000, 800);
    const dimension = item("dimension", plan.walls[0].id), wall = plan.walls[0];
    const offset = dimensionPosition(plan, wall).offset;
    for (const delta of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1e-7 }]) {
      expect(moveSelection(plan, [dimension], delta)).toBe(plan);
    }
    const tangent = moveSelection(plan, [dimension, item("door", plan.openings[0].id)], { x: 100, y: 0 });
    expect(tangent.walls[0]).not.toHaveProperty("dimensionOffset");
    const moved = moveSelection(plan, [dimension], { x: 100, y: -100 });
    expect(moved.walls[0]).toEqual({ ...wall, dimensionOffset: offset - 100 });
    expect(moved).not.toHaveProperty("angleDimensions");
    expect(moved).not.toHaveProperty("thicknessDimensions");
    expect(plan.walls[0]).not.toHaveProperty("dimensionOffset");
  });

  it("does not move a measurement twice when a host, connected wall, endpoint or room moves", () => {
    const plan = corner(), delta = { x: 150, y: -250 };
    for (const host of [wallItem, nodeItem, item("node", "b"), item("wall", "vertical")]) {
      expect(moveSelection(plan, [host, dimensionItem], delta)).toEqual(moveSelection(plan, [host], delta));
    }
    const room = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const roomItem = item("room", detectRooms(room)[0].id);
    expect(moveSelection(room, [roomItem, ...room.walls.map(wall => item("dimension", wall.id))], delta))
      .toEqual(moveSelection(room, [roomItem], delta));
  });

  it.each([-1, 1])("validates offset limits atomically, including sub-epsilon overflow with sign %s", sign => {
    const plan = validatePlan({ ...corner(), walls: corner().walls.map(wall => ({
      ...wall, dimensionOffset: sign * 100000,
    })) }), snapshot = JSON.stringify(plan);
    expect(() => moveSelection(plan, [dimensionItem], { x: 0, y: sign * 1e-7 })).toThrow(/Dimension offset.*100 m/);
    expect(() => moveSelection(plan, [doorItem, dimensionItem], { x: 100, y: sign })).toThrow(/Dimension offset/);
    expect(() => moveSelection(plan, [dimensionItem], { x: NaN, y: 0 })).toThrow(/finite/);
    expect(() => moveSelection(plan, [dimensionItem], { x: 0, y: Infinity })).toThrow(/finite/);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("deletes only the selected length label while preserving room and annotation dependencies", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    plan = renameRoom(plan, detectRooms(plan)[0].id, "Workshop");
    plan = addOpening(plan, plan.walls[0].id, "door", 2000, 800);
    plan = addAngleDimension(plan, {
      wallA: plan.walls[0].id, wallB: plan.walls[1].id, vertex: plan.walls[0].b, radius: 500, clockwise: true,
    });
    plan = validatePlan({
      ...plan, thicknessDimensions: [{ id: "thickness", wallId: plan.walls[0].id, offset: 350 }],
    });
    for (const offset of [undefined, -600, 0, 600]) {
      const original = validatePlan({ ...plan, walls: plan.walls.map((wall, index) =>
        index === 0 && offset !== undefined ? { ...wall, dimensionOffset: offset } : wall) });
      const snapshot = JSON.stringify(original), selected = item("dimension", original.walls[0].id);
      const next = deleteSelection(original, [selected, selected]);
      expect(next).toEqual({
        ...original, walls: original.walls.map((wall, index) => index === 0 ? { ...wall, dimension: false } : wall),
      });
      expect(detectRooms(next)).toEqual(detectRooms(original));
      if (offset === undefined) expect(next.walls[0]).not.toHaveProperty("dimensionOffset");
      const restored = validatePlan({ ...next, walls: next.walls.map(wall => ({ ...wall, dimension: true })) });
      expect(dimensionPosition(restored, restored.walls[0])).toEqual(dimensionPosition(original, original.walls[0]));
      expect(JSON.stringify(original)).toBe(snapshot);
    }
  });

  it("deletes multiple length, angle and thickness measurements independently in any item order", () => {
    const plan = validatePlan({
      ...corner(), walls: corner().walls.map(wall => ({ ...wall, dimension: true })),
      thicknessDimensions: [
        { id: "thickness", wallId: "horizontal", offset: 350 }, { id: "other-thickness", wallId: "vertical", offset: -500 },
      ],
    });
    const dimensions = [dimensionItem, item("dimension", "vertical"), dimensionItem];
    const withoutLengths = { ...plan, walls: plan.walls.map(wall => ({ ...wall, dimension: false })) };
    expect(deleteSelection(plan, dimensions)).toEqual(withoutLengths);
    const mixed = [...dimensions, angleItem, item("thickness", "thickness")];
    const expected = { ...withoutLengths, angleDimensions: [], thicknessDimensions: [plan.thicknessDimensions![1]] };
    expect(deleteSelection(plan, mixed)).toEqual(expected);
    expect(deleteSelection(plan, [...mixed].reverse())).toEqual(expected);
    expect(deleteSelection(corner(), [wallItem, dimensionItem])).toEqual(deleteSelection(corner(), [wallItem]));
    expect(deleteSelection(corner(), [dimensionItem, wallItem, nodeItem])).toEqual(deleteSelection(corner(), [wallItem]));
  });

  it("applies dimension removals before existing deterministic node-join topology", () => {
    const plan = validatePlan({ ...corner(), walls: corner().walls.map(wall => ({ ...wall, dimension: true })) });
    for (const dimensions of [[dimensionItem], [dimensionItem, item("dimension", "vertical")]]) {
      const expected = deleteNode(deleteSelection(plan, dimensions), "a");
      expect(deleteSelection(plan, [nodeItem, ...dimensions])).toEqual(expected);
      expect(deleteSelection(plan, [...dimensions].reverse().concat(nodeItem))).toEqual(expected);
      expect(expected.walls[0].dimension).toBe(dimensions.length === 1);
    }
  });

  it("never silently prunes unrelated orphan nodes when deleting annotations or walls", () => {
    const plan = { ...corner(), nodes: [...corner().nodes, { id: "orphan", x: 5000, y: 5000 }] };
    const snapshot = JSON.stringify(plan);
    // Orphans violate the schema: deletion must reject them rather than silently repair unrelated geometry.
    for (const selected of [dimensionItem, angleItem, doorItem, wallItem]) {
      expect(() => deleteSelection(plan, [selected])).toThrow(/unused junctions/);
    }
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});
