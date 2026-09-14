import { distance, isWallDegenerate, wallPoints, type GeometryIssue, type Opening, type Plan, type Point } from "./model";

export const GEOMETRY_RED = "#c83f45";
export type GeometryHighlight =
  | { kind: "wall" | "opening"; id: string; a: Point; b: Point; width: number }
  | { kind: "node" | "angle"; id: string; point: Point };

export function openingPoints(plan: Plan, opening: Opening): [Point, Point] | null {
  const wall = plan.walls.find(wall => wall.id === opening.wallId)!;
  if (isWallDegenerate(plan, wall)) return null;
  const [a, b] = wallPoints(plan, wall);
  const length = distance(a, b);
  const at = (offset: number): Point => ({
    x: a.x + (b.x - a.x) * offset / length,
    y: a.y + (b.y - a.y) * offset / length,
  });
  return [at(opening.offset - opening.width / 2), at(opening.offset + opening.width / 2)];
}

export function geometryHighlights(plan: Plan, issues: GeometryIssue[]): GeometryHighlight[] {
  const wallIds = new Set(issues.flatMap(issue => issue.wallIds));
  const nodeIds = new Set(issues.flatMap(issue => issue.nodeIds));
  const openingIds = new Set(issues.flatMap(issue => issue.openingIds));
  const angleIds = new Set(issues.flatMap(issue => issue.angleIds));
  const highlights: GeometryHighlight[] = [];
  for (const wall of plan.walls) {
    if (!wallIds.has(wall.id)) continue;
    const [a, b] = wallPoints(plan, wall);
    highlights.push({ kind: "wall", id: wall.id, a, b, width: wall.thickness });
    if (isWallDegenerate(plan, wall)) { nodeIds.add(wall.a); nodeIds.add(wall.b); }
  }
  for (const opening of plan.openings) {
    if (!openingIds.has(opening.id)) continue;
    const points = openingPoints(plan, opening);
    const wall = plan.walls.find(wall => wall.id === opening.wallId)!;
    if (points) highlights.push({ kind: "opening", id: opening.id, a: points[0], b: points[1], width: wall.thickness + 60 });
    else nodeIds.add(wall.a);
  }
  for (const node of plan.nodes) {
    if (nodeIds.has(node.id)) highlights.push({ kind: "node", id: node.id, point: node });
  }
  for (const angle of plan.angleDimensions ?? []) {
    if (angleIds.has(angle.id)) highlights.push({
      kind: "angle", id: angle.id, point: plan.nodes.find(node => node.id === angle.vertex)!,
    });
  }
  return highlights;
}
