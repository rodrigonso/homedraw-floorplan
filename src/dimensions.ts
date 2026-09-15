import { distance, wallPoints, type Plan, type Point, type ThicknessDimension, type Wall } from "./model";

export function dimensionPosition(plan: Plan, wall: Wall) {
  const [a, b] = wallPoints(plan, wall);
  const length = distance(a, b);
  if (length < 1) throw new Error("Move the wall's junctions apart before positioning its dimension.");
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const axis = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  let offset = wall.dimensionOffset;
  if (offset === undefined) {
    const center = plan.nodes.reduce((sum, p) => ({
      x: sum.x + p.x / plan.nodes.length, y: sum.y + p.y / plan.nodes.length,
    }), { x: 0, y: 0 });
    const side = axis.x * (midpoint.x - center.x) + axis.y * (midpoint.y - center.y) < 0 ? -1 : 1;
    offset = side * (wall.thickness / 2 + 350);
  }
  // Store a signed wall-local offset, so manual placement never flips as the plan's center changes.
  const normal = { x: axis.x * (offset < 0 ? -1 : 1), y: axis.y * (offset < 0 ? -1 : 1) };
  const shift = (point: Point) => ({ x: point.x + axis.x * offset, y: point.y + axis.y * offset });
  return { a: shift(a), b: shift(b), label: shift(midpoint), normal, axis, offset };
}

export function draggedDimensionOffset(offset: number, axis: Point, start: Point, current: Point) {
  return offset + (current.x - start.x) * axis.x + (current.y - start.y) * axis.y;
}

export function thicknessDimensionPosition(plan: Plan, dimension: ThicknessDimension) {
  const wall = plan.walls.find(wall => wall.id === dimension.wallId);
  if (!wall) throw new Error("A thickness measurement refers to a missing wall.");
  const [start, end] = wallPoints(plan, wall), length = distance(start, end);
  if (length < 1) throw new Error("Move the wall's junctions apart before positioning its thickness measurement.");
  const axis = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
  const normal = { x: -axis.y, y: axis.x };
  const station = length + dimension.offset, half = wall.thickness / 2;
  const at = (along: number, across: number): Point => ({
    x: start.x + axis.x * along + normal.x * across,
    y: start.y + axis.y * along + normal.y * across,
  });
  const a = at(station, -half), b = at(station, half);
  const extensions: [Point, Point][] = [];
  const anchor = Math.max(0, Math.min(length, station)), direction = Math.sign(station - anchor);
  if (direction) for (const side of [-half, half]) {
    extensions.push([at(anchor + direction * Math.min(60, Math.abs(station - anchor) / 2), side), at(station + direction * 90, side)]);
  }
  const tickComponent = 45 / Math.SQRT2;
  const ticks: [Point, Point][] = [-half, half].map(side => [
    at(station - tickComponent, side - tickComponent), at(station + tickComponent, side + tickComponent),
  ]);
  return { a, b, label: at(station, half + 350), axis, offset: dimension.offset, extensions, ticks };
}
