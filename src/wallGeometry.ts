import ClipperLib from "clipper-lib";
import { distance, isWallDegenerate, wallPoints, type Plan, type Point } from "./model";

type Ray = { wallId: string; direction: Point; halfWidth: number; length: number; angle: number };
const OUTLINE_SCALE = 1_000_000;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const offset = (node: Point, ray: Ray, side: number): Point => ({
  x: node.x - ray.direction.y * ray.halfWidth * side,
  y: node.y + ray.direction.x * ray.halfWidth * side,
});

function offsetPaths(paths: ClipperLib.Paths, delta: number): ClipperLib.Paths {
  const clipper = new ClipperLib.ClipperOffset(4);
  clipper.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const result: ClipperLib.Paths = [];
  clipper.Execute(result, delta);
  const cleaned = ClipperLib.Clipper.CleanPolygons(result, 2).filter(path => path.length >= 3);
  if (!cleaned.length) {
    throw new Error("Could not join the wall outlines.");
  }
  return cleaned;
}

export function wallGeometry(plan: Plan, onFill?: (id: string, points: Point[]) => void): { fills: Point[][]; outlines: Point[][] } {
  const fills: Point[][] = [];
  const fill = (id: string, points: Point[]) => { fills.push(points); onFill?.(id, points); };
  const junctions = new Map<string, { point: Point; rays: Ray[] }>();
  for (const wall of plan.walls) {
    // Collapsed walls are represented by warning markers, not undefined offset polygons.
    if (isWallDegenerate(plan, wall)) continue;
    const [a, b] = wallPoints(plan, wall);
    const length = distance(a, b);
    const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const forward = { wallId: wall.id, direction, halfWidth: wall.thickness / 2, length, angle: Math.atan2(direction.y, direction.x) };
    const reverse = { ...forward, direction: { x: -direction.x, y: -direction.y }, angle: Math.atan2(-direction.y, -direction.x) };
    fill(`wall:${wall.id}`, [offset(a, forward, 1), offset(b, forward, 1), offset(b, forward, -1), offset(a, forward, -1)]);
    for (const [node, ray] of [[a, forward], [b, reverse]] as const) {
        const junction = junctions.get(node.id) ?? { point: node, rays: [] };
      junction.rays.push(ray);
      junctions.set(node.id, junction);
    }
  }

  for (const [nodeId, { point, rays }] of junctions) {
    if (rays.length < 2) continue;
    rays.sort((a, b) => a.angle - b.angle);
    for (let i = 0; i < rays.length; i++) {
      const a = rays[i], b = rays[(i + 1) % rays.length];
      const left = offset(point, a, 1), right = offset(point, b, -1);
      const denominator = cross(a.direction, b.direction);
      if (Math.abs(denominator) < 1e-8) continue;
      const gap = { x: right.x - left.x, y: right.y - left.y };
      const along = cross(gap, b.direction) / denominator;
      const miter = { x: left.x + a.direction.x * along, y: left.y + a.direction.y * along };
      // Bevel acute/short joins rather than letting the offset intersection form a spike.
      const limit = Math.min(4 * Math.max(a.halfWidth, b.halfWidth), Math.min(a.length, b.length) / 2);
      fill(`join:${nodeId}:${a.wallId}:${b.wallId}`, distance(point, miter) <= limit
        ? [point, left, miter, right]
        : [point, left, right]);
    }
  }

  if (!fills.length) return { fills, outlines: [] };
  // Keep fills separate (so room holes stay transparent), but stroke only the union boundary.
  // Integer clipping avoids inconsistent intersections on nearly collinear miter edges.
  // Only render contours use the grid; model coordinates and fills stay exact.
  // Mixed-thickness joins can self-intersect: normalize each filled lobe before union.
  const paths = fills.flatMap(points => ClipperLib.Clipper.SimplifyPolygon(
    points.map(p => ({ X: Math.round(p.x * OUTLINE_SCALE), Y: Math.round(p.y * OUTLINE_SCALE) })),
    ClipperLib.PolyFillType.pftNonZero,
  )).map(path => {
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse();
    return path;
  });
  // Expand/union then contract by 0.000002 mm to close rounding cracks, not room holes.
  const outlines = offsetPaths(offsetPaths(paths, 2), -2).map(path => {
    const points = path.map(p => ({ x: p.X / OUTLINE_SCALE, y: p.Y / OUTLINE_SCALE }));
    const first = points.reduce((best, point, i) =>
      point.x < points[best].x || (point.x === points[best].x && point.y < points[best].y) ? i : best, 0);
    const ring = [...points.slice(first), ...points.slice(0, first)];
    return [...ring, ring[0]];
  }).sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y);
  return { fills, outlines };
}
