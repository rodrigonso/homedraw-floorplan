import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  detectRooms, distance, formatArea, formatLength, getGeometryIssues, isWallDegenerate, projectToWall, wallPoints,
  type GeometryIssue, type Plan, type Point, type Room,
} from "./model";
import { wallGeometry } from "./wallGeometry";
import { dimensionPosition } from "./dimensions";
import { anglePosition, formatAngle, hasAngleGeometry } from "./angles";
import { createSceneCache, type PlanShape } from "./sceneCache";
import { GEOMETRY_RED, geometryHighlights, openingPoints } from "./geometryFeedback";

export const SCALE = 0.1;
export const PAPER = "#ffffff";
export type Selection = { kind: "wall" | "door" | "window" | "room" | "angle"; id: string } | null;

function seed(id: string) {
  return Array.from(id).reduce((value, char) => (value * 31 + char.charCodeAt(0)) | 0, 17) >>> 0;
}

function planToShapes(plan: Plan, showDimensions = true, dimensionPreview?: { id: string; offset: number },
  issues = getGeometryIssues(plan)) {
  const shapes: PlanShape[] = [];
  const base = (id: string) => ({
    id: `plan-${id}`, locked: true, customData: { homedraw: true },
    seed: seed(id), roughness: 0.65, strokeWidth: 1.3, strokeColor: "#444e4b",
  });
  const line = (id: string, points: Point[], color = "#444e4b", width = 1.3, fill = "transparent", roughness = 0.65, opacity = 100) => {
    const start = points[0];
    shapes.push({
      ...base(id), type: "line", x: start.x * SCALE, y: start.y * SCALE,
      points: points.map(p => [(p.x - start.x) * SCALE, (p.y - start.y) * SCALE]),
      strokeColor: color, strokeWidth: width, backgroundColor: fill, fillStyle: "solid", roughness, opacity,
    });
  };
  const label = (id: string, point: Point, text: string, fontSize: number, color: string) => {
    shapes.push({
      ...base(id), type: "text", x: point.x * SCALE, y: point.y * SCALE,
      text, fontSize, fontFamily: 5, strokeColor: color, textAlign: "center",
    });
  };
  const rooms = detectRooms(plan, issues);
  rooms.forEach((room, i) => {
    line(`room-${room.id}`, [...room.points, room.points[0]], "transparent", 0,
      ["#eef1e9", "#f5eee1", "#eaf0f1", "#f1eaf0"][i % 4]);
  });
  const walls = wallGeometry(plan, (id, points) =>
    line(`wall-fill-${id}`, [...points, points[0]], "transparent", 0, "#d2d8ce", 0));
  walls.outlines.forEach((points, i) =>
    line(`wall-outline-${i}`, points, "#45514c", 1.5, "transparent", 0.35));
  plan.openings.forEach(opening => {
    const wall = plan.walls.find(w => w.id === opening.wallId)!;
    if (isWallDegenerate(plan, wall)) return;
    const [a, b] = wallPoints(plan, wall);
    const length = distance(a, b);
    const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    const n = { x: -u.y, y: u.x };
    const at = (along: number, across: number): Point => ({
      x: a.x + u.x * along + n.x * across,
      y: a.y + u.y * along + n.y * across,
    });
    const start = opening.offset - opening.width / 2;
    const end = opening.offset + opening.width / 2;
    const half = wall.thickness / 2 + 8;
    const hole = [at(start, half), at(end, half), at(end, -half), at(start, -half)];
    line(`opening-${opening.id}`, [...hole, hole[0]], PAPER, 1, PAPER);
    if (opening.kind === "window") {
      [-wall.thickness / 2, 0, wall.thickness / 2].forEach((across, i) => {
        line(`window-${opening.id}-${i}`, [at(start, across), at(end, across)], "#719497", 1.5);
      });
      line(`jamb-${opening.id}-a`, [at(start, -half), at(start, half)], "#719497");
      line(`jamb-${opening.id}-b`, [at(end, -half), at(end, half)], "#719497");
    } else {
      const side = opening.flip ? -1 : 1;
      line(`door-${opening.id}`, [at(start, 0), at(start, side * opening.width)], "#66766b", 1.5);
      const arc = Array.from({ length: 19 }, (_, i) => {
        const angle = i / 18 * Math.PI / 2;
        return at(start + Math.cos(angle) * opening.width, side * Math.sin(angle) * opening.width);
      });
      line(`swing-${opening.id}`, arc, "#8c998e", 0.9);
    }
  });
  rooms.forEach(room => {
    label(`name-${room.id}`, { x: room.center.x, y: room.center.y - 170 }, room.name, 23, "#47594e");
    label(`area-${room.id}`, { x: room.center.x, y: room.center.y + 160 }, formatArea(room.area, plan.units), 14, "#7a867b");
  });
  if (showDimensions) plan.walls.filter(w => w.dimension).forEach(wall => {
    const [a, b] = wallPoints(plan, wall);
    if (isWallDegenerate(plan, wall)) {
      label(`warning-length-${wall.id}`, { x: a.x, y: a.y + 160 }, formatLength(distance(a, b), plan.units), 14, GEOMETRY_RED);
      return;
    }
    const dim = dimensionPosition(plan, dimensionPreview?.id === wall.id
      ? { ...wall, dimensionOffset: dimensionPreview.offset } : wall);
    line(`dim-${wall.id}`, [dim.a, dim.b], "#939c91", 0.7);
    [a, b].forEach((point, i) => {
      const end = i === 0 ? dim.a : dim.b;
      const gap = Math.min(wall.thickness / 2 + 100, Math.abs(dim.offset));
      line(`ext-${wall.id}-${i}`, [
        { x: point.x + dim.normal.x * gap, y: point.y + dim.normal.y * gap },
        { x: end.x + dim.normal.x * 80, y: end.y + dim.normal.y * 80 },
      ], "#b2b8ac", 0.6);
      line(`tick-${wall.id}-${i}`, [
        { x: end.x - 45, y: end.y + 65 }, { x: end.x + 45, y: end.y - 65 },
      ], "#7c8879", 1);
    });
    const text = formatLength(distance(a, b), plan.units);
    const width = Math.max(48, text.length * 8);
    shapes.push({
      ...base(`dim-bg-${wall.id}`), type: "rectangle",
      x: dim.label.x * SCALE - width / 2, y: dim.label.y * SCALE - 12,
      width, height: 24, backgroundColor: PAPER, strokeColor: "transparent", fillStyle: "solid",
    });
    label(`dim-label-${wall.id}`, { x: dim.label.x, y: dim.label.y - 95 }, text, 14, "#6b7969");
  });
  if (showDimensions) plan.angleDimensions?.forEach(dimension => {
    if (!hasAngleGeometry(plan, dimension)) {
      const vertex = plan.nodes.find(node => node.id === dimension.vertex)!;
      label(`warning-angle-label-${dimension.id}`, { x: vertex.x, y: vertex.y - 240 }, "Angle unavailable", 12, GEOMETRY_RED);
      return;
    }
    const angle = anglePosition(plan, dimension);
    line(`angle-arc-${dimension.id}`, angle.arc, "#8b879d", 0.9, "transparent", 0.25);
    angle.extensions.forEach((points, i) => line(`angle-ext-${dimension.id}-${i}`, points, "#b1aebb", 0.6));
    angle.ticks.forEach((points, i) => line(`angle-tick-${dimension.id}-${i}`, points, "#817a94", 1));
    const text = formatAngle(angle.degrees);
    const width = Math.max(40, text.length * 8);
    shapes.push({
      ...base(`angle-bg-${dimension.id}`), type: "rectangle",
      x: angle.label.x * SCALE - width / 2, y: angle.label.y * SCALE - 12,
      width, height: 24, backgroundColor: PAPER, strokeColor: "transparent", fillStyle: "solid",
    });
    label(`angle-label-${dimension.id}`, { x: angle.label.x, y: angle.label.y - 95 }, text, 14, "#766b8b");
  });
  for (const highlight of geometryHighlights(plan, issues)) {
    const id = `warning-${highlight.kind}-${highlight.id}`;
    if ("point" in highlight) {
      shapes.push({
        ...base(id), type: "ellipse", x: highlight.point.x * SCALE - 6, y: highlight.point.y * SCALE - 6,
        width: 12, height: 12, strokeColor: GEOMETRY_RED, backgroundColor: "#fbe7e8",
        fillStyle: "solid", strokeWidth: 1.5, roughness: 0,
      });
    } else if (distance(highlight.a, highlight.b) >= 1) {
      line(`${id}-halo`, [highlight.a, highlight.b], GEOMETRY_RED, Math.max(8, highlight.width * SCALE + 4), "transparent", 0, 22);
      line(id, [highlight.a, highlight.b], GEOMETRY_RED, 1.7, "transparent", 0);
    }
  }
  return shapes;
}

export function planToElements(plan: Plan, showDimensions = true, dimensionPreview?: { id: string; offset: number }) {
  return convertToExcalidrawElements(planToShapes(plan, showDimensions, dimensionPreview), { regenerateIds: false });
}

export function createPlanRenderer() {
  const cache = createSceneCache(shapes => convertToExcalidrawElements(shapes, { regenerateIds: false }));
  return {
    clear: cache.clear,
    render(plan: Plan, showDimensions = true, dimensionPreview?: { id: string; offset: number }, issues?: GeometryIssue[]) {
      return cache.render(planToShapes(plan, showDimensions, dimensionPreview, issues));
    },
  };
}

export const isPlanElement = (element: ExcalidrawElement) => element.customData?.homedraw === true;

export function containsPoint(room: Room, point: Point) {
  let inside = false;
  for (let i = 0, j = room.points.length - 1; i < room.points.length; j = i++) {
    const a = room.points[i], b = room.points[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function nearestWall(plan: Plan, point: Point, threshold: number) {
  return plan.walls.map(wall => {
    const [a, b] = wallPoints(plan, wall);
    return { wall, ...projectToWall(point, a, b) };
  }).filter(hit => hit.distance <= Math.max(threshold, hit.wall.thickness / 2))
    .sort((a, b) => a.distance - b.distance)[0];
}

export function hitTest(plan: Plan, point: Point, threshold: number, showDimensions: boolean): Selection {
  if (showDimensions) {
    const wall = plan.walls.find(w => w.dimension && !isWallDegenerate(plan, w)
      && distance(point, dimensionPosition(plan, w).label) < threshold * 2);
    if (wall) return { kind: "wall", id: wall.id };
  }
  const opening = [...plan.openings].reverse().find(opening => {
    const points = openingPoints(plan, opening);
    const wall = plan.walls.find(wall => wall.id === opening.wallId)!;
    return points && projectToWall(point, points[0], points[1]).distance <= Math.max(threshold, wall.thickness / 2);
  });
  if (opening) return { kind: opening.kind, id: opening.id };
  const hit = nearestWall(plan, point, threshold);
  if (hit) {
    const opening = plan.openings.find(o => o.wallId === hit.wall.id && Math.abs(o.offset - hit.offset) <= o.width / 2);
    return opening ? { kind: opening.kind, id: opening.id } : { kind: "wall", id: hit.wall.id };
  }
  const room = detectRooms(plan).find(r => containsPoint(r, point));
  return room ? { kind: "room", id: room.id } : null;
}
