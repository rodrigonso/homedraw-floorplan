import { angleVertex, distance, isWallDegenerate, wallPoints, type AngleDimension, type Plan, type Point } from "./model";

const TAU = Math.PI * 2;
const positiveAngle = (angle: number) => ((angle % TAU) + TAU) % TAU;

export function hasAngleGeometry(plan: Plan, dimension: Pick<AngleDimension, "wallA" | "wallB">): boolean {
  return [dimension.wallA, dimension.wallB].every(id => {
    const wall = plan.walls.find(wall => wall.id === id);
    return !!wall && !isWallDegenerate(plan, wall);
  });
}

function angleRays(plan: Plan, wallA: string, wallB: string) {
  if (!hasAngleGeometry(plan, { wallA, wallB })) throw new Error("Move the junctions apart before measuring this angle.");
  const vertex = angleVertex(plan, wallA, wallB);
  const ray = (wallId: string) => {
    const wall = plan.walls.find(wall => wall.id === wallId)!;
    const end = wallPoints(plan, wall).find(node => node.id !== vertex.id)!;
    return Math.atan2(end.y - vertex.y, end.x - vertex.x);
  };
  const start = ray(wallA);
  return { vertex, start, clockwiseSweep: positiveAngle(ray(wallB) - start) };
}

export function angleDimensionAt(plan: Plan, wallA: string, wallB: string, point: Point): Omit<AngleDimension, "id"> {
  const { vertex, start, clockwiseSweep } = angleRays(plan, wallA, wallB);
  const direction = positiveAngle(Math.atan2(point.y - vertex.y, point.x - vertex.x) - start);
  return {
    wallA, wallB, vertex: vertex.id, radius: Math.max(100, distance(vertex, point)),
    clockwise: direction <= clockwiseSweep,
  };
}

export function anglePosition(plan: Plan, dimension: AngleDimension) {
  const { vertex, start, clockwiseSweep } = angleRays(plan, dimension.wallA, dimension.wallB);
  const sweep = dimension.clockwise ? clockwiseSweep : clockwiseSweep - TAU;
  const middle = start + sweep / 2;
  const axis = { x: Math.cos(middle), y: Math.sin(middle) };
  const at = (angle: number, radius = dimension.radius): Point => ({
    x: vertex.x + Math.cos(angle) * radius, y: vertex.y + Math.sin(angle) * radius,
  });
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 60)));
  const arc = Array.from({ length: steps + 1 }, (_, i) => at(start + sweep * i / steps));
  const extensions = [start, start + sweep].map(angle => [
    at(angle, Math.min(100, dimension.radius)), at(angle, dimension.radius + 80),
  ]);
  const ticks = [start, start + sweep].map(angle => [
    at(angle, dimension.radius - 45), at(angle, dimension.radius + 45),
  ]);
  return { vertex, arc, extensions, ticks, label: at(middle), axis, degrees: Math.abs(sweep) * 180 / Math.PI };
}

export const formatAngle = (degrees: number) => `${Number(degrees.toFixed(1))}\u00b0`;
export const formatAngleInput = (degrees: number) => `${Number(degrees.toFixed(4))}\u00b0`;
