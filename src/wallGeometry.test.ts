import { describe, expect, it } from "vitest";
import {
  addOpening, addRoom, addWall, createDemoPlan, createEmptyPlan, deleteWall, getGeometryIssues, moveNode, moveWall, resizeWall,
  setWallThickness, type Plan, type Point,
} from "./model";
import { wallGeometry } from "./wallGeometry";

function signedArea(points: Point[]) {
  return points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length];
    return sum + a.x * b.y - b.x * a.y;
  }, 0) / 2;
}
function expectPoint(points: Point[], expected: Point) {
  expect(points.some(p => Math.hypot(p.x - expected.x, p.y - expected.y) < 0.0001)).toBe(true);
}
function elbow(horizontal = 200, vertical = 200) {
  let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, horizontal);
  return addWall(plan, { x: 0, y: 0 }, { x: 0, y: 2500 }, vertical);
}
function expectClosedFinite(plan: Plan) {
  const geometry = wallGeometry(plan);
  for (const ring of geometry.outlines) {
    expect(ring[0]).toEqual(ring.at(-1));
    expect(ring.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  }
  return geometry;
}

describe("continuous wall footprints", () => {
  it.each([
    [{ x: 0, y: 0 }, { x: -100, y: -100 }],
    [{ x: 0, y: 0 }, { x: 850, y: -300 }],
    [{ x: 4200, y: 4800 }, { x: 2850, y: 7150 }],
    [{ x: 6800, y: 4800 }, { x: 6500, y: 7300 }],
    [{ x: 4200, y: 0 }, { x: 4600, y: 250 }],
    [{ x: 0, y: 4800 }, { x: 1071.672630496323, y: 2101.6847292892635 }],
    [{ x: 4200, y: 0 }, { x: 1910.3643184527755, y: -2416.4195568300784 }],
    [{ x: 6800, y: 4800 }, { x: 4048.807298950851, y: 5185.694002266973 }],
    [{ x: 4200, y: 4800 }, { x: 6700, y: 4450 }],
  ])("preserves closed outlines when moving %j to %j", (start, target) => {
    const plan = createDemoPlan();
    const node = plan.nodes.find(node => node.x === start.x && node.y === start.y)!;
    const moved = moveNode(plan, node.id, target);
    const before = JSON.stringify(moved);
    const geometry = expectClosedFinite(moved);
    expect(geometry.outlines).toHaveLength(3);
    expect(geometry.outlines.filter(ring => signedArea(ring) < 0)).toHaveLength(2);
    expect(geometry.outlines.reduce((area, ring) => area + signedArea(ring), 0)).toBeGreaterThan(0);
    expect(JSON.stringify(moved)).toBe(before);
  });

  it("keeps seamless room boundaries throughout a deterministic snapped and free node sweep", () => {
    const plan = createDemoPlan();
    const before = JSON.stringify(plan);
    let seed = 12345, valid = 0, invalid = 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const node = plan.nodes[i % plan.nodes.length];
      const target = { x: node.x + (random() - 0.5) * 6000, y: node.y + (random() - 0.5) * 6000 };
      if (i % 2 === 0) {
        target.x = Math.round(target.x / 50) * 50;
        target.y = Math.round(target.y / 50) * 50;
      }
      const moved = moveNode(plan, node.id, target);
      if (getGeometryIssues(moved).length) {
        expectClosedFinite(moved);
        invalid++;
        continue;
      }
      const { outlines } = expectClosedFinite(moved);
      expect(outlines, `Node ${i % plan.nodes.length} at ${JSON.stringify(target)}`).toHaveLength(3);
      expect(outlines.filter(ring => signedArea(ring) < 0)).toHaveLength(2);
      expect(outlines.reduce((area, ring) => area + signedArea(ring), 0)).toBeGreaterThan(0);
      valid++;
    }
    expect(valid).toBeGreaterThan(300);
    expect(invalid).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).toBe(before);
  });

  it.each([-100_000, 99_999])("handles minimum-length walls at coordinate limit %s", coordinate => {
    let plan = addWall(createEmptyPlan(), { x: coordinate, y: coordinate }, { x: coordinate + 1, y: coordinate }, 10);
    plan = addWall(plan, { x: coordinate + 1, y: coordinate }, { x: coordinate + 1, y: coordinate + 1 }, 1000);
    const { outlines } = expectClosedFinite(plan);
    expect(outlines).toHaveLength(1);
    expect(signedArea(outlines[0])).toBeGreaterThan(0);
  });

  it("has no outlines for an empty plan", () => {
    expect(wallGeometry(createEmptyPlan())).toEqual({ fills: [], outlines: [] });
  });

  it("keeps wall and junction fill identities stable when a different junction changes", () => {
    const plan = createDemoPlan();
    const first = new Map<string, Point[]>(), next = new Map<string, Point[]>();
    const before = wallGeometry(plan, (id, points) => first.set(id, points));
    const node = plan.nodes.find(node => node.x === 4200 && node.y === 0)!;
    const moved = moveNode(plan, node.id, { x: 4450, y: 250 });
    const after = wallGeometry(moved, (id, points) => next.set(id, points));
    expect(first.size).toBe(before.fills.length);
    expect(next.size).toBe(after.fills.length);
    for (const wall of plan.walls.filter(wall => wall.a !== node.id && wall.b !== node.id)) {
      expect(next.get(`wall:${wall.id}`)).toEqual(first.get(`wall:${wall.id}`));
    }
    const changedWalls = plan.walls.filter(wall => wall.a === node.id || wall.b === node.id);
    for (const [id, points] of first) {
      if (id.startsWith("join:") && !changedWalls.some(wall => id.split(":").includes(wall.id))) expect(next.get(id)).toEqual(points);
    }
  });

  it("keeps square caps on a standalone wall", () => {
    const plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, 200);
    const { outlines } = expectClosedFinite(plan);
    expect(outlines).toHaveLength(1);
    expect(signedArea(outlines[0])).toBe(600_000);
    expectPoint(outlines[0], { x: 0, y: -100 });
    expectPoint(outlines[0], { x: 3000, y: 100 });
  });

  it("miters both edges of a right-angle corner without internal end caps", () => {
    const { outlines } = expectClosedFinite(elbow());
    expect(outlines).toHaveLength(1);
    const ring = outlines[0];
    expect(ring).toHaveLength(7);
    expectPoint(ring, { x: -100, y: -100 });
    expectPoint(ring, { x: 100, y: 100 });
    expect(signedArea(ring)).toBe(1_100_000);
    expect(ring).not.toContainEqual({ x: 0, y: 0 });
    expect(ring).not.toContainEqual({ x: 0, y: 100 });
  });

  it("joins different thicknesses at their actual offset intersections", () => {
    const { outlines } = expectClosedFinite(elbow(300, 100));
    expectPoint(outlines[0], { x: -50, y: -150 });
    expectPoint(outlines[0], { x: 50, y: 150 });
    expect(signedArea(outlines[0])).toBe(1_150_000);
  });

  it("leaves the interior room transparent with a single outer and inner contour", () => {
    const plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 200);
    const { outlines } = expectClosedFinite(plan);
    expect(outlines).toHaveLength(2);
    expect(outlines.map(r => r.length)).toEqual([5, 5]);
    expect(outlines.map(signedArea).sort((a, b) => a - b)).toEqual([-3800 * 2800, 4200 * 3200]);
    expect(outlines.reduce((sum, r) => sum + signedArea(r), 0)).toBe(2_800_000);
  });

  it("removes internal seams at a T-junction and collinear split", () => {
    let plan = addWall(createEmptyPlan(), { x: -2000, y: 0 }, { x: 2000, y: 0 }, 200);
    plan = addWall(plan, { x: 0, y: 0 }, { x: 0, y: 2000 }, 100);
    const { outlines } = expectClosedFinite(plan);
    expect(plan.walls).toHaveLength(3);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveLength(9);
    expectPoint(outlines[0], { x: 50, y: 100 });
    expectPoint(outlines[0], { x: -50, y: 100 });
    expect(signedArea(outlines[0])).toBe(990_000);
    expect(outlines[0]).not.toContainEqual({ x: 0, y: -100 });
  });

  it("joins four incident walls without outlining their shared center", () => {
    let plan = elbow();
    plan = addWall(plan, { x: 0, y: 0 }, { x: -3000, y: 0 }, 200);
    plan = addWall(plan, { x: 0, y: 0 }, { x: 0, y: -2500 }, 200);
    const { outlines } = expectClosedFinite(plan);
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveLength(13);
    expect(signedArea(outlines[0])).toBe(2_160_000);
  });

  it.each([45, 135, -45, -135])("miters a %s degree corner", degrees => {
    const angle = degrees * Math.PI / 180;
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, 200);
    plan = addWall(plan, { x: 0, y: 0 }, { x: 3000 * Math.cos(angle), y: 3000 * Math.sin(angle) }, 200);
    const { outlines } = expectClosedFinite(plan);
    const x = 100 * (1 + Math.cos(angle)) / Math.sin(angle);
    expectPoint(outlines[0], { x, y: 100 });
    expectPoint(outlines[0], { x: -x, y: -100 });
  });

  it("bevels nearly parallel joins rather than producing enormous spikes", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 0 }, 200);
    plan = addWall(plan, { x: 0, y: 0 }, { x: 3000, y: 10 }, 200);
    const { outlines } = expectClosedFinite(plan);
    expect(outlines.flat().every(p => p.x >= -101 && p.x <= 3101 && Math.abs(p.y) <= 111)).toBe(true);
  });

  it("handles short segments and straight thickness transitions", () => {
    let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 20, y: 0 }, 200);
    plan = addWall(plan, { x: 20, y: 0 }, { x: 20, y: 2000 }, 100);
    expectClosedFinite(plan);
    let straight = addWall(createEmptyPlan(), { x: -2000, y: 0 }, { x: 0, y: 0 }, 200);
    straight = addWall(straight, { x: 0, y: 0 }, { x: 2000, y: 0 }, 100);
    const { outlines } = expectClosedFinite(straight);
    expect(outlines).toHaveLength(1);
    expectPoint(outlines[0], { x: 0, y: -100 });
    expectPoint(outlines[0], { x: 0, y: -50 });
    expect(signedArea(outlines[0])).toBe(600_000);
  });

  it("is independent of wall direction and array ordering", () => {
    const plan = elbow(300, 100);
    const reversed = { ...plan, walls: plan.walls.map(w => ({ ...w, a: w.b, b: w.a })).reverse() };
    expect(wallGeometry(reversed).outlines).toEqual(wallGeometry(plan).outlines);
  });

  it("updates corners after resizing, dragging, thickness edits and deletion", () => {
    let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 200);
    plan = resizeWall(plan, plan.walls[0].id, 4500);
    expect(expectClosedFinite(plan).outlines).toHaveLength(2);
    plan = moveWall(plan, plan.walls[1].id, { x: 200, y: 100 });
    expect(expectClosedFinite(plan).outlines).toHaveLength(2);
    plan = setWallThickness(plan, plan.walls[2].id, 300);
    expect(expectClosedFinite(plan).outlines).toHaveLength(2);
    plan = deleteWall(plan, plan.walls[0].id);
    expect(expectClosedFinite(plan).outlines).toHaveLength(1);
  });

  it("does not mutate wall endpoints, openings or stored plan data", () => {
    let plan = elbow();
    plan = addOpening(plan, plan.walls[0].id, "door", 1500, 900);
    const before = JSON.stringify(plan);
    wallGeometry(plan);
    expect(JSON.stringify(plan)).toBe(before);
  });
});
