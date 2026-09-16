import { anglePosition, formatAngle, hasAngleGeometry } from "./angles";
import { dimensionPosition, thicknessDimensionPosition } from "./dimensions";
import {
  deleteNode, detectRooms, distance, formatLength, validatePlan, wallPoints,
  type AngleDimension, type Opening, type Plan, type Point, type Room, type ThicknessDimension, type Wall,
} from "./model";

export type SelectionItem = { kind: "wall" | "node" | "door" | "window" | "dimension" | "angle" | "room" | "thickness"; id: string };
export type SelectionBounds = { x: number; y: number; width: number; height: number };

const EPS = 1e-6;
const TAU = Math.PI * 2;
const positiveAngle = (angle: number) => ((angle % TAU) + TAU) % TAU;

function finitePoint(point: Point, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${label} must have finite X and Y coordinates.`);
  }
}

function resolveSelection(plan: Plan, items: readonly SelectionItem[], allowRoomPreview = false) {
  const walls = new Map(plan.walls.map(wall => [wall.id, wall]));
  const nodes = new Map(plan.nodes.map(node => [node.id, node]));
  const openings = new Map(plan.openings.map(opening => [opening.id, opening]));
  const angles = new Map((plan.angleDimensions ?? []).map(angle => [angle.id, angle]));
  const thickness = new Map((plan.thicknessDimensions ?? []).map(dimension => [dimension.id, dimension]));
  const wallIds = new Set<string>(), nodeIds = new Set<string>();
  const openingIds = new Set<string>(), angleIds = new Set<string>();
  const dimensionIds = new Set<string>(), thicknessIds = new Set<string>();
  const rooms: Room[] = [];
  let availableRooms: Room[] | undefined;
  for (const item of items) {
    let exists = false;
    switch (item.kind) {
      case "wall": exists = walls.has(item.id); wallIds.add(item.id); break;
      case "dimension": exists = walls.get(item.id)?.dimension === true; dimensionIds.add(item.id); break;
      case "node": exists = nodes.has(item.id); nodeIds.add(item.id); break;
      case "door":
      case "window":
        exists = openings.get(item.id)?.kind === item.kind;
        openingIds.add(item.id);
        break;
      case "angle": exists = angles.has(item.id); angleIds.add(item.id); break;
      case "thickness": exists = thickness.has(item.id); thicknessIds.add(item.id); break;
      case "room": {
        availableRooms ??= detectRooms(plan);
        const room = availableRooms.find(room => room.id === item.id);
        exists = !!room;
        if (room && !rooms.some(selected => selected.id === room.id)) {
          rooms.push(room);
          room.nodeIds.forEach(id => nodeIds.add(id));
          for (let i = 0; i < room.nodeIds.length; i++) {
            const a = room.nodeIds[i], b = room.nodeIds[(i + 1) % room.nodeIds.length];
            for (const wall of plan.walls) {
              if ((wall.a === a && wall.b === b) || (wall.a === b && wall.b === a)) wallIds.add(wall.id);
            }
          }
        } else if (!room && allowRoomPreview && item.id.startsWith("room:")) {
          // Geometry warnings can hide a moving room while its stable boundary IDs remain intact.
          const boundary = item.id.slice(5).split(":");
          if (boundary.length >= 3 && new Set(boundary).size === boundary.length
            && `room:${[...boundary].sort().join(":")}` === item.id
            && boundary.every(id => nodes.has(id))) {
            exists = true;
            const boundaryIds = new Set(boundary);
            boundary.forEach(id => nodeIds.add(id));
            for (const wall of plan.walls) {
              if (boundaryIds.has(wall.a) && boundaryIds.has(wall.b)) wallIds.add(wall.id);
            }
          }
        }
        break;
      }
    }
    if (!exists) throw new Error(`The selected ${item.kind} "${item.id}" no longer exists.`);
  }
  const coveredNodeIds = new Set<string>();
  for (const wallId of wallIds) {
    const wall = walls.get(wallId)!;
    coveredNodeIds.add(wall.a);
    coveredNodeIds.add(wall.b);
  }
  const movedNodeIds = new Set([...nodeIds, ...coveredNodeIds]);
  const affectedWallIds = new Set(plan.walls
    .filter(wall => movedNodeIds.has(wall.a) || movedNodeIds.has(wall.b)).map(wall => wall.id));
  return { wallIds, nodeIds, openingIds, dimensionIds, angleIds, thicknessIds, coveredNodeIds, movedNodeIds, affectedWallIds, rooms };
}

function bodyPoints(a: Point, b: Point, thickness: number): Point[] {
  const length = distance(a, b);
  if (length === 0) return [a, b];
  const nx = -(b.y - a.y) / length * thickness / 2;
  const ny = (b.x - a.x) / length * thickness / 2;
  return [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
  ];
}

export function getSelectionNodeIds(plan: Plan, items: readonly SelectionItem[]): string[] {
  return [...resolveSelection(plan, items).movedNodeIds];
}

function wallBody(plan: Plan, wall: Wall): Point[] {
  const points = wallPoints(plan, wall);
  return distance(...points) < 1 ? points : bodyPoints(...points, wall.thickness);
}

function dimensionBody(plan: Plan, wall: Wall): Point[] {
  const [a, b] = wallPoints(plan, wall), length = distance(a, b);
  const text = formatLength(length, plan);
  if (length < 1) {
    const halfWidth = text.length * 40;
    return [{ x: a.x - halfWidth, y: a.y + 160 }, { x: a.x + halfWidth, y: a.y + 360 }];
  }
  const dim = dimensionPosition(plan, wall);
  const halfWidth = Math.max(240, text.length * 40);
  return [
    dim.a, dim.b, ...dim.extensions.flat(), ...dim.ticks.flat(),
    { x: dim.label.x - halfWidth, y: dim.label.y - 120 },
    { x: dim.label.x + halfWidth, y: dim.label.y + 120 },
  ];
}

function arcExtrema(center: Point, radius: number, start: number, sweep: number): Point[] {
  const angles = [start, start + sweep];
  for (const cardinal of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const travel = positiveAngle(sweep < 0 ? start - cardinal : cardinal - start);
    if (travel <= Math.abs(sweep) + EPS / radius) angles.push(cardinal);
  }
  return angles.map(angle => ({
    x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius,
  }));
}

function openingBody(plan: Plan, opening: Opening): Point[] {
  const wall = plan.walls.find(wall => wall.id === opening.wallId);
  if (!wall) throw new Error("An opening refers to a missing wall.");
  const [a, b] = wallPoints(plan, wall);
  const length = distance(a, b);
  if (length < 1) return [a];
  const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const at = (offset: number): Point => ({ x: a.x + u.x * offset, y: a.y + u.y * offset });
  const start = at(opening.offset - opening.width / 2), end = at(opening.offset + opening.width / 2);
  const points = bodyPoints(start, end, wall.thickness);
  if (opening.kind === "door") {
    const direction = opening.hingeAtEnd ? -1 : 1, side = opening.flip ? -1 : 1;
    const hinge = opening.hingeAtEnd ? end : start;
    points.push(hinge, ...arcExtrema(hinge, opening.width,
      Math.atan2(u.y * direction, u.x * direction), direction * side * Math.PI / 2));
  }
  return points;
}

function angleBody(plan: Plan, dimension: AngleDimension): Point[] {
  if (!hasAngleGeometry(plan, dimension)) {
    const vertex = plan.nodes.find(node => node.id === dimension.vertex);
    if (!vertex) throw new Error("An angle dimension refers to a missing junction.");
    const halfWidth = "Angle unavailable".length * 40;
    return [
      { x: vertex.x - halfWidth, y: vertex.y - 240 },
      { x: vertex.x + halfWidth, y: vertex.y - 40 },
    ];
  }
  const angle = anglePosition(plan, dimension);
  // Match the rendered label background's estimated size, expressed in millimeters.
  const halfWidth = Math.max(200, formatAngle(angle.degrees).length * 40);
  return [
    ...angle.arc, ...angle.extensions.flat(), ...angle.ticks.flat(),
    { x: angle.label.x - halfWidth, y: angle.label.y - 120 },
    { x: angle.label.x + halfWidth, y: angle.label.y + 120 },
  ];
}

function boundsOf(points: readonly Point[]): SelectionBounds | null {
  if (!points.length) return null;
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) {
    finitePoint(point, "Selection geometry");
    x = Math.min(x, point.x); y = Math.min(y, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  const width = right - x, height = bottom - y;
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Selection bounds must be finite.");
  return { x, y, width, height };
}

function thicknessBody(plan: Plan, dimension: ThicknessDimension): Point[] {
  const wall = plan.walls.find(wall => wall.id === dimension.wallId)!;
  const [a, b] = wallPoints(plan, wall);
  if (distance(a, b) < 1) {
    const halfWidth = `Thickness ${formatLength(wall.thickness, plan)}`.length * 40;
    return [{ x: a.x - halfWidth, y: a.y + 450 }, { x: a.x + halfWidth, y: a.y + 650 }];
  }
  const dim = thicknessDimensionPosition(plan, dimension);
  const halfWidth = Math.max(280, formatLength(wall.thickness, plan).length * 40);
  return [dim.a, dim.b, ...dim.extensions.flat(), ...dim.ticks.flat(),
    { x: dim.label.x - halfWidth, y: dim.label.y - 120 },
    { x: dim.label.x + halfWidth, y: dim.label.y + 120 }];
}

export function selectionBounds(plan: Plan, items: readonly SelectionItem[], showDimensions = true): SelectionBounds | null {
  const selected = resolveSelection(plan, items, true);
  const points: Point[] = [];
  for (const wall of plan.walls) if (selected.wallIds.has(wall.id)) points.push(...wallBody(plan, wall));
  for (const node of plan.nodes) if (selected.movedNodeIds.has(node.id)) points.push(node);
  for (const room of selected.rooms) points.push(...room.points);
  for (const opening of plan.openings) {
    if (selected.openingIds.has(opening.id) || selected.affectedWallIds.has(opening.wallId)) {
      points.push(...openingBody(plan, opening));
    }
  }
  if (showDimensions) for (const wall of plan.walls) {
    if (selected.dimensionIds.has(wall.id)) points.push(...dimensionBody(plan, wall));
  }
  if (showDimensions) for (const angle of plan.angleDimensions ?? []) {
    if (selected.angleIds.has(angle.id) || selected.affectedWallIds.has(angle.wallA)
      || selected.affectedWallIds.has(angle.wallB)) points.push(...angleBody(plan, angle));
  }
  if (showDimensions) for (const dimension of plan.thicknessDimensions ?? []) {
    if (selected.thicknessIds.has(dimension.id) || selected.affectedWallIds.has(dimension.wallId)) points.push(...thicknessBody(plan, dimension));
  }
  return boundsOf(points);
}

export function getMarqueeSelection(
  plan: Plan, start: Point, end: Point, showDimensions: boolean,
): SelectionItem[] {
  finitePoint(start, "Selection start"); finitePoint(end, "Selection end");
  const box = boundsOf([start, end])!;
  if (box.width <= EPS || box.height <= EPS) return [];
  const contained = (points: readonly Point[]) => points.length > 0 && points.every(point =>
    point.x >= box.x - EPS && point.x <= box.x + box.width + EPS
    && point.y >= box.y - EPS && point.y <= box.y + box.height + EPS);
  const walls = plan.walls.filter(wall => contained(wallBody(plan, wall)));
  const wallIds = new Set(walls.map(wall => wall.id));
  const coveredNodes = new Set(walls.flatMap(wall => [wall.a, wall.b]));
  const items: SelectionItem[] = walls.map(wall => ({ kind: "wall", id: wall.id }));
  for (const node of plan.nodes) {
    if (!coveredNodes.has(node.id) && contained([node])) items.push({ kind: "node", id: node.id });
  }
  for (const opening of plan.openings) {
    if (wallIds.has(opening.wallId)) continue;
    const wall = plan.walls.find(wall => wall.id === opening.wallId);
    if (!wall) throw new Error("An opening refers to a missing wall.");
    if (distance(...wallPoints(plan, wall)) >= 1 && contained(openingBody(plan, opening))) {
      items.push({ kind: opening.kind, id: opening.id });
    }
  }
  if (showDimensions) for (const wall of plan.walls) {
    if (wall.dimension && !wallIds.has(wall.id) && contained(dimensionBody(plan, wall))) {
      items.push({ kind: "dimension", id: wall.id });
    }
  }
  if (showDimensions) for (const angle of plan.angleDimensions ?? []) {
    if (!wallIds.has(angle.wallA) && !wallIds.has(angle.wallB) && contained(angleBody(plan, angle))) {
      items.push({ kind: "angle", id: angle.id });
    }
  }
  if (showDimensions) for (const dimension of plan.thicknessDimensions ?? []) {
    if (!wallIds.has(dimension.wallId) && contained(thicknessBody(plan, dimension))) items.push({ kind: "thickness", id: dimension.id });
  }
  return items;
}

export function moveSelection(plan: Plan, items: readonly SelectionItem[], delta: Point): Plan {
  const selected = resolveSelection(plan, items);
  finitePoint(delta, "Selection movement");
  if (!items.length || (delta.x === 0 && delta.y === 0)) return plan;
  let changed = false;
  const nodes = plan.nodes.map(node => {
    if (!selected.movedNodeIds.has(node.id)) return node;
    const next = { ...node, x: node.x + delta.x, y: node.y + delta.y };
    changed ||= next.x !== node.x || next.y !== node.y;
    return next;
  });
  const walls = plan.walls.map(wall => {
    if (!selected.dimensionIds.has(wall.id) || selected.affectedWallIds.has(wall.id)) return wall;
    const { axis, offset } = dimensionPosition(plan, wall);
    const projection = delta.x * axis.x + delta.y * axis.y;
    const dimensionOffset = offset + projection;
    if (dimensionOffset === offset) return wall;
    changed ||= Math.abs(dimensionOffset - offset) > EPS;
    return { ...wall, dimensionOffset };
  });
  const openings = plan.openings.map(opening => {
    if (!selected.openingIds.has(opening.id) || selected.affectedWallIds.has(opening.wallId)) return opening;
    const wall = plan.walls.find(wall => wall.id === opening.wallId);
    if (!wall) throw new Error("An opening refers to a missing wall.");
    const [a, b] = wallPoints(plan, wall), length = distance(a, b);
    if (length < 1) throw new Error("Move the wall's junctions apart before moving its opening.");
    const offset = opening.offset + delta.x * ((b.x - a.x) / length) + delta.y * ((b.y - a.y) / length);
    changed ||= Math.abs(offset - opening.offset) > EPS;
    return { ...opening, offset };
  });
  const angleDimensions = plan.angleDimensions?.map(dimension => {
    if (!selected.angleIds.has(dimension.id) || selected.affectedWallIds.has(dimension.wallA)
      || selected.affectedWallIds.has(dimension.wallB)) return dimension;
    if (!hasAngleGeometry(plan, dimension)) throw new Error("Move the junctions apart before moving this angle.");
    const { axis } = anglePosition(plan, dimension);
    const projection = delta.x * axis.x + delta.y * axis.y;
    if (!Number.isFinite(projection)) throw new Error("Angle movement must be finite.");
    const radius = Math.max(100, dimension.radius + projection);
    changed ||= Math.abs(radius - dimension.radius) > EPS;
    return { ...dimension, radius };
  });
  const thicknessDimensions = plan.thicknessDimensions?.map(dimension => {
    if (!selected.thicknessIds.has(dimension.id) || selected.affectedWallIds.has(dimension.wallId)) return dimension;
    const { axis } = thicknessDimensionPosition(plan, dimension);
    const offset = dimension.offset + delta.x * axis.x + delta.y * axis.y;
    changed ||= Math.abs(offset - dimension.offset) > EPS;
    return { ...dimension, offset };
  });
  // Validate even sub-epsilon changes before returning a no-op, so limits stay strict.
  const next = validatePlan({
    ...plan, nodes, walls, openings,
    ...(Object.hasOwn(plan, "angleDimensions") ? { angleDimensions } : {}),
    ...(Object.hasOwn(plan, "thicknessDimensions") ? { thicknessDimensions } : {}),
  });
  return changed ? next : plan;
}

export function deleteSelection(plan: Plan, items: readonly SelectionItem[]): Plan {
  const selected = resolveSelection(plan, items);
  if (!items.length) return plan;
  let next = plan;
  if (selected.wallIds.size || selected.openingIds.size || selected.dimensionIds.size
    || selected.angleIds.size || selected.thicknessIds.size) {
    const walls = plan.walls.filter(wall => !selected.wallIds.has(wall.id))
      .map(wall => selected.dimensionIds.has(wall.id) ? { ...wall, dimension: false } : wall);
    const usedNodes = new Set(walls.flatMap(wall => [wall.a, wall.b]));
    next = validatePlan({
      ...plan, walls, nodes: plan.nodes.filter(node => !selected.coveredNodeIds.has(node.id) || usedNodes.has(node.id)),
      openings: plan.openings.filter(opening => !selected.wallIds.has(opening.wallId)
        && !selected.openingIds.has(opening.id)),
      ...(Object.hasOwn(plan, "angleDimensions") ? {
        angleDimensions: plan.angleDimensions?.filter(angle => !selected.wallIds.has(angle.wallA)
          && !selected.wallIds.has(angle.wallB) && !selected.angleIds.has(angle.id)),
      } : {}),
      ...(Object.hasOwn(plan, "thicknessDimensions") ? {
        thicknessDimensions: plan.thicknessDimensions?.filter(dimension => !selected.wallIds.has(dimension.wallId)
          && !selected.thicknessIds.has(dimension.id)),
      } : {}),
    });
  }
  // Use original node order: each join can change the next selected junction's degree.
  for (const node of plan.nodes) {
    if (selected.nodeIds.has(node.id) && !selected.coveredNodeIds.has(node.id)
      && next.nodes.some(current => current.id === node.id)) next = deleteNode(next, node.id);
  }
  return next;
}
