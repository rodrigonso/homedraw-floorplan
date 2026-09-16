import { describe, expect, it } from "vitest";
import { createEmptyPlan, distance, type Plan, type Point } from "./model";
import { snapDraftPoint, snapOpeningPosition, snapTranslation, type SnapGuide } from "./snapGuides";

const p = (x: number, y: number): Point => ({ x, y });
function scene(nodes: Record<string, Point>, walls: [string, string, string][] = []): Plan {
  return {
    ...createEmptyPlan(),
    nodes: Object.entries(nodes).map(([id, point]) => ({ id, ...point })),
    walls: walls.map(([id, a, b]) => ({ id, a, b, thickness: 100, dimension: true })),
  };
}
const singleWall = (a = p(0, 0), b = p(4000, 0)) => scene({ a, b }, [["wall", "a", "b"]]);
function opening(plan: Plan, id: string, offset: number, wallId = "wall"): void {
  plan.openings.push({ id, wallId, offset, width: 800, kind: "door", flip: false });
}
function expectPoint(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
}
function expectFinalGuides(guides: SnapGuide[], point: Point): void {
  for (const guide of guides) {
    if (guide.target) expectPoint(guide.target, point);
    if (guide.kind !== "wall") expectPoint(guide.b, point);
    if (guide.kind === "alignment") {
      expect(distance(guide.a, guide.b)).toBeGreaterThan(1e-6);
      expect(Math.min(Math.abs(guide.a.x - guide.b.x), Math.abs(guide.a.y - guide.b.y))).toBeLessThan(1e-7);
    }
  }
}

describe("draft magnetic snapping", () => {
  it.each([
    [p(130, 438), p(123, 438)],
    [p(438, 909), p(438, 900)],
  ])("aligns to off-grid node coordinates without quantizing the free coordinate (%j)", (raw, expected) => {
    const result = snapDraftPoint(scene({ reference: p(123, 900) }), raw, 100, 20);
    expect(result.point).toEqual(expected);
    expect(result.guides.map(guide => guide.kind)).toEqual(["alignment"]);
    expectFinalGuides(result.guides, result.point);
  });

  it("aligns both coordinates to independent references", () => {
    const plan = scene({ horizontal: p(900, 237), vertical: p(123, 900) });
    const result = snapDraftPoint(plan, p(130, 245), 100, 20);
    expect(result.point).toEqual(p(123, 237));
    expect(result.guides).toHaveLength(2);
    expectFinalGuides(result.guides, result.point);
  });

  it("uses wall midpoint coordinates beyond the actual segment", () => {
    const result = snapDraftPoint(singleWall(p(123, 1000), p(923, 1000)), p(530, 1800), 0, 10);
    expect(result.point).toEqual(p(523, 1800));
    expect(result.guides[0].id).toContain("midpoint:wall");
    expectFinalGuides(result.guides, result.point);
  });

  it.each([p(1510, 1490), p(-510, -490)])("snaps beyond either diagonal endpoint (%j)", raw => {
    const result = snapDraftPoint(singleWall(p(0, 0), p(1000, 1000)), raw, 100, 15);
    const expected = raw.x > 0 ? p(1500, 1500) : p(-500, -500);
    expectPoint(result.point, expected);
    expect(result.guides.map(guide => guide.kind)).toEqual(["wall", "extension"]);
    expectPoint(result.guides[1].a, raw.x > 0 ? p(1000, 1000) : p(0, 0));
    expectFinalGuides(result.guides, result.point);
    expect(distance(raw, result.point)).toBeLessThanOrEqual(15);
  });

  it.each([
    [p(1510, 1490), p(0, 1500)],
    [p(1490, 1510), p(1500, 0)],
  ])("intersects diagonal extensions with the exact Shift-locked axis (%j)", (raw, origin) => {
    const result = snapDraftPoint(singleWall(p(0, 0), p(1000, 1000)), raw, 100, 15, origin, true);
    expectPoint(result.point, p(1500, 1500));
    expect(result.guides.map(guide => guide.kind)).toEqual(["wall", "extension", "constraint"]);
    expectFinalGuides(result.guides, result.point);
    if (origin.x === 0) expect(result.point.y).toBe(origin.y);
    else expect(result.point.x).toBe(origin.x);
  });

  it("does not attract a locked point to a distant near-parallel intersection", () => {
    const origin = p(0, 1000), raw = p(90_000, 1100);
    const result = snapDraftPoint(singleWall(p(0, 0), p(1000, 10)), raw, 0, 20, origin, true);
    expect(result.point).toEqual(p(90_000, 1000));
    expect(result.guides.map(guide => guide.kind)).toEqual(["constraint"]);
  });

  it("preserves direct endpoint priority and refines compatible alignment along a wall", () => {
    const plan = singleWall();
    plan.nodes.push({ id: "reference", ...p(1530, 40) });
    const node = snapDraftPoint(plan, p(1535, 10), 100, 50);
    expect(node.point).toEqual(p(1530, 40));
    expect(node.guides.map(guide => guide.kind)).toEqual(["point"]);
    expectFinalGuides(node.guides, node.point);
    plan.nodes[2] = { id: "reference", ...p(1537, 800) };
    const wall = snapDraftPoint(plan, p(1535, 10), 100, 50);
    expect(wall.point).toEqual(p(1537, 0));
    expect(wall.guides.map(guide => guide.kind)).toEqual(["wall", "alignment"]);
    expect(wall.guides[0].a).toEqual(p(0, 0));
    expect(wall.guides[0].b).toEqual(p(4000, 0));
    expectFinalGuides(wall.guides, wall.point);
  });

  it("preserves existing direct and plain-grid results", () => {
    const plan = singleWall();
    for (const [raw, expected] of [[p(30, 10), p(0, 0)], [p(1535, 10), p(1535, 0)], [p(1535, 260), p(1500, 300)]]) {
      expect(snapDraftPoint(plan, raw, 100, 50).point).toEqual(expected);
    }
    expect(snapDraftPoint(plan, p(1535, 260), 100, 50).guides).toEqual([]);
  });

  it.each([false, true])("combines extension and off-grid alignment with swapped axes=%s", transpose => {
    const point = (x: number, y: number) => transpose ? p(y, x) : p(x, y);
    const plan = singleWall(point(0, 3000), point(4000, 3000));
    plan.nodes.push({ id: "reference", ...point(6237, 1473) });
    const result = snapDraftPoint(plan, point(6260, 2970), 50, 50);
    expectPoint(result.point, point(6237, 3000));
    expect(result.guides.map(guide => guide.kind)).toEqual(["wall", "extension", "alignment"]);
    expectFinalGuides(result.guides, result.point);
    const bounded = snapDraftPoint(plan, point(6260, 2970), 50, 35);
    expectPoint(bounded.point, point(6260, 3000));
    expect(bounded.guides.map(guide => guide.kind)).toEqual(["wall", "extension"]);
  });

  it("refines diagonal extensions only along the wall and within the total snap distance", () => {
    const plan = singleWall(p(0, 0), p(1000, 1000));
    plan.nodes.push({ id: "reference", ...p(1507, 3000) });
    const raw = p(1510, 1490);
    const combined = snapDraftPoint(plan, raw, 50, 20);
    expectPoint(combined.point, p(1507, 1507));
    expectFinalGuides(combined.guides, combined.point);
    expect(distance(raw, combined.point)).toBeLessThanOrEqual(20);
    expectPoint(snapDraftPoint(plan, raw, 50, 15).point, p(1500, 1500));
    const locked = snapDraftPoint(plan, raw, 50, 20, p(0, 1500), true);
    expectPoint(locked.point, p(1500, 1500));
    expectFinalGuides(locked.guides, locked.point);
  });

  it("keeps Shift grid snapping along parallel walls unless a free-axis reference matches", () => {
    const plan = singleWall();
    const result = snapDraftPoint(plan, p(1277, 140), 50, 20, p(500, 0), true);
    expectPoint(result.point, p(1300, 0));
    expectFinalGuides(result.guides, result.point);
    plan.nodes.push({ id: "reference", ...p(1277, 1000) });
    const aligned = snapDraftPoint(plan, p(1277, 140), 50, 20, p(500, 0), true);
    expectPoint(aligned.point, p(1277, 0));
    expect(aligned.guides.map(guide => guide.kind)).toContain("alignment");
    expectFinalGuides(aligned.guides, aligned.point);
  });

  it("adds only applicable origin alignment or explicit axis constraints", () => {
    const empty = createEmptyPlan(), origin = p(123, 900);
    const aligned = snapDraftPoint(empty, p(130, 438), 100, 20, origin);
    expect(aligned.point).toEqual(p(123, 438));
    expect(aligned.guides.map(guide => guide.kind)).toEqual(["alignment"]);
    const nearOrigin = snapDraftPoint(empty, p(130, 909), 100, 20, origin);
    expect(nearOrigin.point).toEqual(origin);
    expect(nearOrigin.guides.map(guide => guide.kind)).toEqual(["point"]);
    expect(snapDraftPoint(empty, p(373, 110), 100, 20, p(25, 35), true).point).toEqual(p(400, 35));
    expect(snapDraftPoint(empty, p(373, 110), 0, 20, undefined, true)).toEqual({ point: p(373, 110), guides: [] });
  });

  it("uses node alignment on the free axis without pretending an off-axis node is a direct hit", () => {
    const plan = scene({ reference: p(390, 50) });
    const result = snapDraftPoint(plan, p(380, 30), 100, 50, p(25, 35), true);
    expect(result.point).toEqual(p(390, 35));
    expect(result.guides.map(guide => guide.kind)).toEqual(["alignment", "constraint"]);
    expectFinalGuides(result.guides, result.point);
  });

  it("disables grid and geometry independently and preserves Alt-equivalent axis locks", () => {
    const plan = singleWall();
    expect(snapDraftPoint(plan, p(1535, 10), 0, 0)).toEqual({ point: p(1535, 10), guides: [] });
    expect(snapDraftPoint(plan, p(1e-7, 0), 0, 0)).toEqual({ point: p(1e-7, 0), guides: [] });
    expect(snapDraftPoint(plan, p(1535, 10), 100, 0)).toEqual({ point: p(1500, 0), guides: [] });
    expect(snapDraftPoint(plan, p(1535, 10), 0, 50).point).toEqual(p(1535, 0));
    expect(snapDraftPoint(plan, p(373, 110), 0, 0, p(25, 35), true)).toEqual({ point: p(373, 35), guides: [] });
    expect(snapDraftPoint(plan, p(110, 373), 0, 0, p(25, 35), true)).toEqual({ point: p(25, 373), guides: [] });
  });

  it.each([0.1, 1, 4])("respects world-scaled tolerance at zoom %s", zoom => {
    const plan = scene({ reference: p(1000, 900) });
    const near = snapDraftPoint(plan, p(1000 + 7 / zoom, 400), 0, 8 / zoom);
    expect(near.point.x).toBe(1000);
    expect(near.guides).toHaveLength(1);
    const far = p(1000 + 9 / zoom, 400);
    expect(snapDraftPoint(plan, far, 0, 8 / zoom)).toEqual({ point: far, guides: [] });
  });

  it("includes exact tolerance boundaries but never exceeds the total two-axis tolerance", () => {
    const plan = scene({ a: p(1000, 5000), b: p(5000, 1000) });
    expect(snapDraftPoint(plan, p(1010, 400), 0, 10).point).toEqual(p(1000, 400));
    const outside = p(1010 + 1e-7, 400);
    expect(snapDraftPoint(plan, outside, 0, 10)).toEqual({ point: outside, guides: [] });
    const result = snapDraftPoint(plan, p(1008, 1008), 0, 10);
    expect(result.point).toEqual(p(1000, 1008));
    expect(result.guides).toHaveLength(1);
    expect(distance(result.point, p(1008, 1008))).toBeLessThanOrEqual(10);
    const exact = snapDraftPoint(plan, p(1008, 1006), 0, 10);
    expect(exact.point).toEqual(p(1000, 1000));
    expect(exact.guides).toHaveLength(2);
    expectFinalGuides(exact.guides, exact.point);
  });

  it("has deterministic ties and stable guide IDs across previews and scene order", () => {
    const plan = scene({ b: p(1020, 5000), a: p(1000, 5000) });
    const first = snapDraftPoint(plan, p(1010, 400), 0, 10);
    expect(first.point.x).toBe(1000);
    plan.nodes.reverse();
    expect(snapDraftPoint(plan, p(1010, 400), 0, 10)).toEqual(first);
    expect(snapDraftPoint(plan, p(1008, 430), 0, 10).guides[0].id).toBe(first.guides[0].id);
  });

  it("ignores annotation label positions", () => {
    const plan = singleWall();
    plan.walls[0].dimensionOffset = 900;
    plan.thicknessDimensions = [{ id: "annotation", wallId: "wall", offset: 123 }];
    plan.roomNames = { "room:a:b": "A room label" };
    expect(snapDraftPoint(plan, p(2123, 900), 0, 10)).toEqual({ point: p(2123, 900), guides: [] });
  });

  it("handles collapsed and arbitrarily short walls without inventing extensions", () => {
    const collapsed = singleWall(p(100, 100), p(100, 100));
    expect(snapDraftPoint(collapsed, p(110, 110), 0, 20).point).toEqual(p(100, 100));
    expect(snapDraftPoint(collapsed, p(250, 160), 100, 10)).toEqual({ point: p(300, 200), guides: [] });
    const tiny = snapDraftPoint(singleWall(p(0, 0), p(0.5, 0)), p(0.25, 0.1), 0, 0.2);
    expectPoint(tiny.point, p(0.25, 0));
    expect(tiny.guides.map(guide => guide.kind)).toEqual(["wall", "point"]);
    const microscopic = snapDraftPoint(singleWall(p(0, 0), p(1e-200, 0)), p(5e-201, 1e-201), 0, 2e-201);
    expect(microscopic.point).toEqual(p(5e-201, 0));
  });
});

describe("rigid translation snapping", () => {
  it("combines a segment attachment on one endpoint with alignment on another", () => {
    const plan = scene({
      a: p(0, 0), b: p(4000, 0), c: p(0, 3000), d: p(4000, 3000), reference: p(6237, 1473),
    }, [["moving", "a", "b"], ["stationary", "c", "d"]]);
    const result = snapTranslation(plan, ["a", "b"], p(2240, 2970), 50, 50);
    expectPoint(result.delta, p(2237, 3000));
    expect(result.guides.map(guide => guide.kind)).toEqual(["wall", "alignment"]);
    expectFinalGuides([result.guides[0]], p(2237, 3000));
    expectFinalGuides([result.guides[1]], p(6237, 3000));
  });

  it("retains delta-grid snapping while sliding a Shift-locked group along a reference wall", () => {
    const plan = singleWall();
    plan.nodes.push({ id: "moving", ...p(125, 0) });
    const result = snapTranslation(plan, ["moving"], p(277, 80), 50, 20, "x");
    expect(result.delta).toEqual(p(300, 0));
    expectFinalGuides(result.guides, p(425, 0));
  });

  it("aligns different moved endpoints with one delta and final transformed guides", () => {
    const plan = scene({
      a: p(123, 217), b: p(523, 417), x: p(610, 4000), y: p(4000, 808),
    }, [["moving", "a", "b"]]);
    const before = structuredClone(plan);
    const result = snapTranslation(plan, ["a", "b", "a"], p(480, 382), 100, 20);
    expect(result.delta).toEqual(p(487, 391));
    const movedA = p(123 + result.delta.x, 217 + result.delta.y);
    const movedB = p(523 + result.delta.x, 417 + result.delta.y);
    expect(p(movedB.x - movedA.x, movedB.y - movedA.y)).toEqual(p(400, 200));
    expect(result.guides).toHaveLength(2);
    expectFinalGuides([result.guides[0]], movedA);
    expectFinalGuides([result.guides[1]], movedB);
    expect(plan).toEqual(before);
    expect(snapTranslation(plan, ["b", "a"], p(480, 382), 100, 20)).toEqual(result);
  });

  it("does not snap to moved nodes, their wall axes, or incident wall midpoints", () => {
    const moving = singleWall(p(123, 217), p(523, 417));
    expect(snapTranslation(moving, ["a", "b"], p(27, 34), 0, 50)).toEqual({ delta: p(27, 34), guides: [] });
    const incident = singleWall(p(0, 0), p(1000, 1000));
    opening(incident, "on-moving-host", Math.hypot(500, 500));
    expect(snapTranslation(incident, ["a"], p(510, 505), 0, 20)).toEqual({ delta: p(510, 505), guides: [] });
    const endpoint = snapTranslation(incident, ["a"], p(990, 250), 0, 20);
    expect(endpoint.delta).toEqual(p(1000, 250));
    expect(endpoint.guides.map(guide => guide.kind)).toEqual(["alignment"]);
  });

  it("accepts partial node-move reference plans that retain openings from omitted walls", () => {
    const plan = singleWall(p(0, 0), p(1000, 1000));
    opening(plan, "retained", Math.hypot(500, 500));
    const partial = { ...plan, nodes: plan.nodes.filter(node => node.id !== "a"), walls: [] };
    expect(snapDraftPoint(partial, p(510, 505), 0, 20)).toEqual({ point: p(510, 505), guides: [] });
    expect(snapTranslation(partial, ["b"], p(17, 19), 0, 20)).toEqual({ delta: p(17, 19), guides: [] });
  });

  it("preserves the free delta coordinate rather than causing grid drift", () => {
    const plan = scene({ moving: p(123, 217), reference: p(610, 4000) });
    const result = snapTranslation(plan, ["moving"], p(480, 382), 100, 20);
    expect(result.delta).toEqual(p(487, 382));
    expectFinalGuides(result.guides, p(610, 599));
    expect(snapTranslation(plan, ["moving"], p(100, 100), 100, 20)).toEqual({ delta: p(100, 100), guides: [] });
  });

  it.each([
    ["x", p(150, 900), p(127, 200), p(140, 0), p(150, 20)],
    ["y", p(900, 150), p(200, 127), p(0, 130), p(10, 150)],
  ] as const)("locks the %s movement axis exactly", (axis, reference, raw, expected, target) => {
    const plan = scene({ moving: p(10, 20), reference });
    const result = snapTranslation(plan, ["moving"], raw, 100, 20, axis);
    expect(result.delta).toEqual(expected);
    expectFinalGuides(result.guides, target);
    const disabled = snapTranslation(plan, ["moving"], raw, 0, 0, axis);
    expect(disabled).toEqual({ delta: axis === "x" ? p(raw.x, 0) : p(0, raw.y), guides: [] });
  });

  it("snaps a moved endpoint directly to a stationary node", () => {
    const plan = scene({ moving: p(523, 417), reference: p(1000, 500) });
    const result = snapTranslation(plan, ["moving"], p(470, 70), 100, 20);
    expect(result.delta).toEqual(p(477, 83));
    expect(result.guides.map(guide => guide.kind)).toEqual(["point"]);
    expectFinalGuides(result.guides, p(1000, 500));
  });

  it("snaps transformed anchors to stationary wall segments and extensions", () => {
    const plan = singleWall(p(0, 1000), p(4000, 1000));
    plan.nodes.push({ id: "moving", ...p(100, 100) });
    const wall = snapTranslation(plan, ["moving"], p(1435, 890), 100, 20);
    expect(wall.delta).toEqual(p(1435, 900));
    expect(wall.guides.map(guide => guide.kind)).toEqual(["wall"]);
    expectFinalGuides(wall.guides, p(1535, 1000));
    const diagonal = singleWall(p(0, 0), p(1000, 1000));
    diagonal.nodes.push({ id: "moving", ...p(400, 800) });
    const extension = snapTranslation(diagonal, ["moving"], p(1110, 690), 100, 20);
    expectPoint(extension.delta, p(1100, 700));
    expect(extension.guides.map(guide => guide.kind)).toEqual(["wall", "extension"]);
    expectFinalGuides(extension.guides, p(1500, 1500));
  });

  it("quantizes the delta, including empty selections, and disables all geometric guides", () => {
    const plan = scene({ moving: p(123, 217) });
    expect(snapTranslation(plan, ["moving"], p(151, 49), 100, 0)).toEqual({ delta: p(200, 0), guides: [] });
    expect(snapTranslation(plan, [], p(151, 49), 100, 20)).toEqual({ delta: p(200, 0), guides: [] });
    expect(snapTranslation(plan, [], p(151, 49), 0, 0)).toEqual({ delta: p(151, 49), guides: [] });
  });

  it("bounds combined group corrections and locked extension intersections", () => {
    const plan = scene({ moving: p(0, 0), x: p(1000, 5000), y: p(5000, 1000) });
    const bounded = snapTranslation(plan, ["moving"], p(1008, 1008), 0, 10);
    expect(bounded.delta).toEqual(p(1000, 1008));
    expect(bounded.guides).toHaveLength(1);
    const diagonal = singleWall(p(0, 0), p(1000, 1000));
    diagonal.nodes.push({ id: "moving", ...p(400, 1500) });
    const locked = snapTranslation(diagonal, ["moving"], p(1110, 450), 0, 15, "x");
    expect(locked.delta).toEqual(p(1100, 0));
    expectFinalGuides(locked.guides, p(1500, 1500));
  });

  it("handles large groups without building combinations of scene references", () => {
    const plan = createEmptyPlan(), ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(`moving:${i}`);
      plan.nodes.push(
        { id: `moving:${i}`, ...p(10_000 + i * 10, 10_000) },
        { id: `reference:${i}`, ...p(-90_000 + i * 10, -90_000) },
      );
      if (i % 2 === 1) {
        plan.walls.push({
          id: `wall:${i}`, a: `reference:${i - 1}`, b: `reference:${i}`, thickness: 100, dimension: true,
        });
      }
    }
    expect(snapTranslation(plan, ids, p(12, 17), 0, 10)).toEqual({ delta: p(12, 17), guides: [] });
  });
});

describe("host-attached opening snapping", () => {
  it.each([[995, 1000], [-8, 0], [2008, 2000]])("snaps center offset %s to host midpoint or endpoints", (raw, expected) => {
    const plan = singleWall(p(123, 237), p(2123, 237));
    const result = snapOpeningPosition(plan, plan.walls[0], raw, 100, 10);
    expect(result.offset).toBe(expected);
    expectPoint(result.point, p(123 + expected, 237));
    expect(result.guides.map(guide => guide.kind)).toEqual(["wall", "point"]);
    expectFinalGuides(result.guides, result.point);
  });

  it.each([
    [p(123, 237), p(2123, 237), p(777, 1400), p(777, 237)],
    [p(237, 123), p(237, 2123), p(1400, 777), p(237, 777)],
  ])("intersects horizontal and vertical host axes with external node alignments", (a, b, reference, expected) => {
    const plan = singleWall(a, b);
    plan.nodes.push({ id: "reference", ...reference });
    const result = snapOpeningPosition(plan, plan.walls[0], 650, 100, 10);
    expect(result.offset).toBeCloseTo(654, 8);
    expectPoint(result.point, expected);
    expect(result.guides.map(guide => guide.kind)).toEqual(["wall", "alignment"]);
    expectFinalGuides(result.guides, result.point);
  });

  it.each([
    [p(1000, 3000), 1490, 1500, p(1000, 1400)],
    [p(4000, 1920), 2145, 2150, p(1390, 1920)],
  ])("keeps a rotated opening center on its host when aligning to %j", (reference, raw, expected, point) => {
    const plan = singleWall(p(100, 200), p(3100, 4200));
    plan.nodes.push({ id: "reference", ...reference });
    const result = snapOpeningPosition(plan, plan.walls[0], raw, 100, 15);
    expect(result.offset).toBeCloseTo(expected, 8);
    expectPoint(result.point, point);
    expectFinalGuides(result.guides, result.point);
  });

  it("prioritizes a nearby host midpoint over an even closer external alignment", () => {
    const plan = singleWall(p(100, 200), p(3100, 4200));
    plan.nodes.push({ id: "reference", ...p(1594, 8000) });
    const result = snapOpeningPosition(plan, plan.walls[0], 2490, 0, 15);
    expect(result.offset).toBe(2500);
    expect(result.guides[1].id).toContain("midpoint:wall");
  });

  it("measures tolerance along the host, not on the shorter X/Y projection", () => {
    const plan = singleWall(p(0, 0), p(100, 10_000));
    plan.nodes.push({ id: "reference", ...p(31, 8000) });
    const result = snapOpeningPosition(plan, plan.walls[0], 3000, 0, 10);
    expect(result.offset).toBe(3000);
    expect(result.guides).toEqual([]);
  });

  it.each([0.1, 1, 4])("scales along-host tolerance with zoom %s", zoom => {
    const plan = singleWall(p(0, 0), p(2000, 0));
    const near = snapOpeningPosition(plan, plan.walls[0], 1000 + 7 / zoom, 0, 8 / zoom);
    expect(near.offset).toBe(1000);
    expect(near.guides).toHaveLength(2);
    const far = snapOpeningPosition(plan, plan.walls[0], 1000 + 9 / zoom, 0, 8 / zoom);
    expect(far.offset).toBe(1000 + 9 / zoom);
    expect(far.guides).toEqual([]);
  });

  it("snaps to other opening centers and excludes every moving opening ID", () => {
    const plan = singleWall(p(0, 0), p(2000, 0));
    opening(plan, "moving", 777);
    opening(plan, "also-moving", 779);
    const result = snapOpeningPosition(plan, plan.walls[0], 782, 0, 10);
    expect(result.offset).toBe(779);
    expect(result.guides[1].id).toContain("also-moving");
    expect(snapOpeningPosition(plan, plan.walls[0], 782, 0, 10, ["moving", "also-moving"]))
      .toEqual({ offset: 782, point: p(782, 0), guides: [] });
  });

  it("aligns opening centers on other walls in world coordinates", () => {
    const plan = scene({
      a: p(0, 0), b: p(2000, 0), c: p(500, 1000), d: p(1500, 2000),
    }, [["wall", "a", "b"], ["other", "c", "d"]]);
    opening(plan, "reference", Math.hypot(1000, 1000) / 4, "other");
    const result = snapOpeningPosition(plan, plan.walls[0], 755, 0, 10);
    expect(result.offset).toBe(750);
    expect(result.guides[1].id).toContain("opening:reference");
    expectFinalGuides(result.guides, p(750, 0));
    expect(snapOpeningPosition(plan, plan.walls[0], 755, 0, 10, ["reference"]).guides).toEqual([]);
  });

  it("ignores opening references whose hosts are absent from an intentionally partial plan", () => {
    const plan = singleWall(p(0, 0), p(2000, 0));
    opening(plan, "orphan", 777, "omitted");
    expect(snapOpeningPosition(plan, plan.walls[0], 782, 0, 10))
      .toEqual({ offset: 782, point: p(782, 0), guides: [] });
  });

  it("keeps signed offsets and overhang instead of clamping opening widths to fit", () => {
    const plan = singleWall(p(0, 0), p(2000, 0));
    opening(plan, "outside", -175);
    const result = snapOpeningPosition(plan, plan.walls[0], -169, 100, 10);
    expect(result.offset).toBe(-175);
    expect(result.point).toEqual(p(-175, 0));
    expectFinalGuides(result.guides, result.point);
    expect(snapOpeningPosition(plan, plan.walls[0], 2207, 0, 0))
      .toEqual({ offset: 2207, point: p(2207, 0), guides: [] });
  });

  it("does not let valid overhanging opening references block other placements", () => {
    const plan = singleWall(p(99_000, 0), p(100_000, 0));
    opening(plan, "overhang", 2000);
    const result = snapOpeningPosition(plan, plan.walls[0], 1995, 50, 10);
    expect(result.offset).toBe(2000);
    expectPoint(result.point, p(101_000, 0));
    expectFinalGuides(result.guides, result.point);
    expect(snapOpeningPosition(plan, plan.walls[0], 700, 50, 10).offset).toBe(700);
  });

  it("uses the requested scalar grid fallback, with no false grid guides", () => {
    const plan = singleWall(p(123, 237), p(2123, 237));
    expect(snapOpeningPosition(plan, plan.walls[0], 1027, 17, 0))
      .toEqual({ offset: 1020, point: p(1143, 237), guides: [] });
    expect(snapOpeningPosition(plan, plan.walls[0], 1283, 100, 10))
      .toEqual({ offset: 1300, point: p(1423, 237), guides: [] });
    expect(snapOpeningPosition(plan, plan.walls[0], 1027, 0, 0))
      .toEqual({ offset: 1027, point: p(1150, 237), guides: [] });
  });

  it("quantizes diagonal opening offsets without detaching their centers", () => {
    const plan = singleWall(p(100, 200), p(3100, 4200));
    const result = snapOpeningPosition(plan, plan.walls[0], 1283, 100, 0);
    expect(result.offset).toBe(1300);
    expectPoint(result.point, p(880, 1240));
    expect(result.guides).toEqual([]);
  });

  it.each([0, 0.5, 1e-200])("rejects undefined host directions for length %s even when snapping is disabled", length => {
    const plan = singleWall(p(0, 0), p(length, 0));
    expect(() => snapOpeningPosition(plan, plan.walls[0], 0, 0, 0)).toThrow(/Move the .* apart/);
  });
});

describe("snap validation and exact drawing boundaries", () => {
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite point, movement, offset, grid and threshold %s", value => {
    const plan = singleWall();
    expect(() => snapDraftPoint(plan, p(value, 0), 0, 0)).toThrow(/finite/);
    expect(() => snapDraftPoint(plan, p(0, 0), value, 0)).toThrow(/finite/);
    expect(() => snapDraftPoint(plan, p(0, 0), 0, value)).toThrow(/finite/);
    expect(() => snapTranslation(plan, ["a"], p(0, value), 0, 0, "x")).toThrow(/finite/);
    expect(() => snapTranslation(plan, [], p(0, 0), value, 0)).toThrow(/finite/);
    expect(() => snapTranslation(plan, [], p(0, 0), 0, value)).toThrow(/finite/);
    expect(() => snapOpeningPosition(plan, plan.walls[0], value, 0, 0)).toThrow(/finite/);
    expect(() => snapOpeningPosition(plan, plan.walls[0], 0, value, 0)).toThrow(/finite/);
    expect(() => snapOpeningPosition(plan, plan.walls[0], 0, 0, value)).toThrow(/finite/);
  });

  it("rejects negative settings and missing geometry IDs", () => {
    const plan = singleWall();
    for (const [grid, threshold] of [[-1, 0], [0, -1]]) {
      expect(() => snapDraftPoint(plan, p(0, 0), grid, threshold)).toThrow(/negative/);
      expect(() => snapTranslation(plan, [], p(0, 0), grid, threshold)).toThrow(/negative/);
      expect(() => snapOpeningPosition(plan, plan.walls[0], 0, grid, threshold)).toThrow(/negative/);
    }
    expect(() => snapTranslation(plan, ["missing"], p(0, 0), 0, 0)).toThrow(/junction.*no longer exists/);
    expect(() => snapOpeningPosition(plan, { ...plan.walls[0], a: "missing" }, 0, 0, 0)).toThrow(/missing junction/);
    expect(() => snapDraftPoint(plan, p(0, 0), 0, 0, p(100_001, 0))).toThrow(/100 m/);
  });

  it("accepts exact coordinate boundaries and rejects oversized input and grid/extension results", () => {
    const empty = createEmptyPlan();
    for (const sign of [-1, 1]) {
      const raw = p(sign * 100_000, sign * 100_000);
      expect(snapDraftPoint(empty, raw, 0, 0)).toEqual({ point: raw, guides: [] });
      expect(() => snapDraftPoint(empty, p(sign * (100_000 + 1e-7), 0), 0, 0)).toThrow(/100 m/);
    }
    expect(() => snapDraftPoint(empty, p(100_000, 0), 60_000, 0)).toThrow(/100 m/);
    expect(() => snapDraftPoint(empty, p(1000, 0), 1e-320, 0)).toThrow(/finite/);
    expect(() => snapDraftPoint(singleWall(p(0, 0), p(1000, 500)), p(99_999, 50_100), 0, 1000)).toThrow(/100 m/);
    const aligned = snapDraftPoint(scene({ reference: p(100_000, 5000) }), p(99_990, 0), 0, 10);
    expect(aligned.point).toEqual(p(100_000, 0));
  });

  it("allows full-scene translations but checks every transformed node and quantized result", () => {
    const plan = scene({ a: p(-100_000, 0), b: p(99_980, 0) });
    expect(snapTranslation(plan, ["a"], p(200_000, 0), 0, 0)).toEqual({ delta: p(200_000, 0), guides: [] });
    expect(() => snapTranslation(plan, ["b"], p(21, 0), 0, 0)).toThrow(/100 m/);
    expect(() => snapTranslation(plan, ["b"], p(19, 0), 30, 0)).toThrow(/100 m/);
    expect(() => snapTranslation(plan, [], p(200_001, 0), 0, 0)).toThrow(/coordinate limit/);
    expect(() => snapTranslation(plan, [], p(1000, 0), 1e-320, 0)).toThrow(/finite/);
    const group = scene({ a: p(99_980, 0), b: p(0, 1000), reference: p(30, 5000) });
    expect(() => snapTranslation(group, ["a", "b"], p(19, 0), 0, 20)).toThrow(/100 m/);
  });

  it("accepts exact opening endpoint/scalar limits without floating-point overshoot", () => {
    const plan = singleWall(p(-100_000, -100_000), p(100_000, 100_000));
    const length = 2 * 100_000 * Math.SQRT2;
    const result = snapOpeningPosition(plan, plan.walls[0], length, 0, 1);
    expect(result.offset).toBe(length);
    expect(result.point).toEqual(p(100_000, 100_000));
    expectFinalGuides(result.guides, result.point);
    expect(() => snapOpeningPosition(plan, plan.walls[0], length + 1e-7, 0, 0)).toThrow(/coordinate limit/);
    const overhang = singleWall(p(0, 0), p(100_000, 0));
    expect(snapOpeningPosition(overhang, overhang.walls[0], 100_000 + 1e-7, 0, 0).offset).toBe(100_000 + 1e-7);
    const quantized = singleWall(p(99_960, 0), p(100_000, 0));
    expect(snapOpeningPosition(quantized, quantized.walls[0], 39, 50, 0).point).toEqual(p(100010, 0));
  });

  it("includes opening tolerance boundaries exactly", () => {
    const plan = singleWall(p(0, 0), p(2000, 0));
    expect(snapOpeningPosition(plan, plan.walls[0], 1010, 0, 10).offset).toBe(1000);
    expect(snapOpeningPosition(plan, plan.walls[0], 1010 + 1e-7, 0, 10).guides).toEqual([]);
  });
});
