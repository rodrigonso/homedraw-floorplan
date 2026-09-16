import { evaluateMeasurement, type LengthUnit } from "./measurementExpression";

export type { LengthUnit } from "./measurementExpression";
export interface LengthUnits { metric: "m" | "cm"; imperial: "ft" | "in" }

export interface Point { x: number; y: number }
export interface Node extends Point { id: string }
export interface Wall {
  id: string;
  a: string;
  b: string;
  thickness: number;
  dimension: boolean;
  dimensionOffset?: number;
}
export interface Opening {
  id: string;
  wallId: string;
  kind: "door" | "window";
  offset: number;
  width: number;
  flip: boolean;
  hingeAtEnd?: boolean;
}
export interface AngleDimension {
  id: string;
  wallA: string;
  wallB: string;
  vertex: string;
  radius: number;
  clockwise: boolean;
}
export interface ThicknessDimension {
  id: string;
  wallId: string;
  // Signed millimeters from endpoint B along the A-to-B direction.
  offset: number;
}
export interface Room {
  id: string;
  nodeIds: string[];
  points: Point[];
  area: number;
  center: Point;
  name: string;
}
export interface Plan {
  version: 1;
  name: string;
  units: "metric" | "imperial";
  lengthUnits?: LengthUnits;
  nodes: Node[];
  walls: Wall[];
  openings: Opening[];
  angleDimensions?: AngleDimension[];
  thicknessDimensions?: ThicknessDimension[];
  roomNames: Record<string, string>;
}

export type GeometryIssueCode = "short-wall" | "coincident-nodes" | "wall-overlap" | "wall-crossing"
  | "opening-outside" | "opening-overlap" | "undefined-angle";
export interface GeometryIssue {
  code: GeometryIssueCode;
  message: string;
  wallIds: string[];
  nodeIds: string[];
  openingIds: string[];
  angleIds: string[];
}

const EPS = 1e-6;
const MIN_LENGTH = 1;
const MAX_COORDINATE = 100_000;
const MAX_SCENE_LENGTH = 2 * MAX_COORDINATE * Math.SQRT2;
const MAX_NODES = 2_000;
const MAX_WALLS = 1_000;
const MAX_OPENINGS = 1_000;
const MAX_ANGLE_DIMENSIONS = 1_000;
const MAX_THICKNESS_DIMENSIONS = 1_000;
const DEFAULT_THICKNESS_DIMENSION_OFFSET = 350;
const MAX_NAME = 120;
const id = () => crypto.randomUUID();
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const copyPoint = (point: Point): Point => ({ x: point.x, y: point.y });
const interpolate = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function finite(value: unknown, label: string): asserts value is number {
  ensure(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number.`);
}

function checkPoint(point: Point, label = "Position"): void {
  finite(point.x, `${label} X`);
  finite(point.y, `${label} Y`);
  ensure(
    Math.abs(point.x) <= MAX_COORDINATE && Math.abs(point.y) <= MAX_COORDINATE,
    `${label} must be within 100 m of the drawing origin.`,
  );
}

function checkThickness(thickness: number): void {
  finite(thickness, "Wall thickness");
  ensure(thickness >= 10 && thickness <= 1_000, "Wall thickness must be between 10 and 1000 mm.");
}

function checkLength(length: number): void {
  finite(length, "Wall length");
  ensure(length >= MIN_LENGTH, "Wall length must be at least 1 mm.");
}

function checkThicknessDimensionOffset(offset: unknown): asserts offset is number {
  finite(offset, "Thickness measurement offset");
  ensure(Math.abs(offset) <= MAX_COORDINATE, "Thickness measurement offset must be within 100 m of its wall end.");
}

export function createEmptyPlan(): Plan {
  return { version: 1, name: "Untitled plan", units: "metric", nodes: [], walls: [], openings: [], roomNames: {} };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function wallPoints(plan: Plan, wall: Wall): [Node, Node] {
  const a = plan.nodes.find(node => node.id === wall.a);
  const b = plan.nodes.find(node => node.id === wall.b);
  ensure(a && b, "This wall refers to a missing junction.");
  return [a, b];
}

export function isWallDegenerate(plan: Plan, wall: Wall): boolean {
  return distance(...wallPoints(plan, wall)) < MIN_LENGTH;
}

export function projectToWall(point: Point, a: Point, b: Point): {
  point: Point; offset: number; distance: number;
} {
  const length = distance(a, b);
  ensure(Number.isFinite(length), "Wall length must be finite.");
  finite(point.x, "Position X");
  finite(point.y, "Position Y");
  if (length === 0) return { point: copyPoint(a), offset: 0, distance: distance(point, a) };
  const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const offset = Math.max(0, Math.min(length, dot(subtract(point, a), direction)));
  const projected = interpolate(a, b, offset / length);
  return { point: projected, offset, distance: distance(point, projected) };
}

type Intersection = { kind: "none" | "overlap" } | { kind: "point"; point: Point };

function intersection(a: Point, b: Point, c: Point, d: Point): Intersection {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const rLength = distance(a, b);
  const sLength = distance(c, d);
  if (rLength <= EPS) {
    return projectToWall(a, c, d).distance <= EPS ? { kind: "point", point: copyPoint(a) } : { kind: "none" };
  }
  if (sLength <= EPS) {
    return projectToWall(c, a, b).distance <= EPS ? { kind: "point", point: copyPoint(c) } : { kind: "none" };
  }
  const denominator = cross(r, s);
  const ca = subtract(c, a);
  if (Math.abs(denominator) <= EPS * Math.max(rLength, sLength)) {
    if (Math.abs(cross(ca, r)) > EPS * rLength) return { kind: "none" };
    const t0 = dot(ca, r) / dot(r, r);
    const t1 = dot(subtract(d, a), r) / dot(r, r);
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    if ((hi - lo) * rLength < -EPS) return { kind: "none" };
    if ((hi - lo) * rLength > EPS) return { kind: "overlap" };
    return { kind: "point", point: interpolate(a, b, Math.max(0, Math.min(1, (lo + hi) / 2))) };
  }
  const t = cross(ca, s) / denominator;
  const u = cross(ca, r) / denominator;
  if (t < -EPS / rLength || t > 1 + EPS / rLength || u < -EPS / sLength || u > 1 + EPS / sLength) {
    return { kind: "none" };
  }
  return { kind: "point", point: interpolate(a, b, Math.max(0, Math.min(1, t))) };
}

export function getGeometryIssues(plan: Plan): GeometryIssue[] {
  const messages: Record<GeometryIssueCode, string> = {
    "short-wall": "Walls must be at least 1 mm long. Move an endpoint to restore their direction.",
    "coincident-nodes": "Separate junctions occupy the same position.",
    "wall-overlap": "Walls duplicate or overlap each other.",
    "wall-crossing": "Walls cross or meet without a shared junction.",
    "opening-outside": "Openings extend beyond their walls.",
    "opening-overlap": "Doors or windows on the same wall overlap.",
    "undefined-angle": "An angle cannot be measured while an attached wall is shorter than 1 mm.",
  };
  type IssueSets = { [K in "wallIds" | "nodeIds" | "openingIds" | "angleIds"]: Set<string> };
  const issues = new Map<GeometryIssueCode, IssueSets>();
  const issue = (code: GeometryIssueCode): IssueSets => {
    let result = issues.get(code);
    if (!result) {
      result = { wallIds: new Set(), nodeIds: new Set(), openingIds: new Set(), angleIds: new Set() };
      issues.set(code, result);
    }
    return result;
  };
  const addWall = (result: IssueSets, wall: Wall) => {
    result.wallIds.add(wall.id);
    result.nodeIds.add(wall.a);
    result.nodeIds.add(wall.b);
  };
  const byNode = new Map(plan.nodes.map(node => [node.id, node]));
  const walls = plan.walls.map(wall => {
    const a = byNode.get(wall.a)!;
    const b = byNode.get(wall.b)!;
    return { wall, a, b, length: distance(a, b) };
  });
  const byWall = new Map(walls.map(data => [data.wall.id, data]));
  for (let i = 0; i < plan.nodes.length; i++) {
    for (let j = i + 1; j < plan.nodes.length; j++) {
      const a = plan.nodes[i]!;
      const b = plan.nodes[j]!;
      if (distance(a, b) <= EPS) {
        const result = issue("coincident-nodes");
        result.nodeIds.add(a.id);
        result.nodeIds.add(b.id);
      }
    }
  }
  const coincident = issues.get("coincident-nodes");
  for (let i = 0; i < walls.length; i++) {
    const { wall, a, b, length } = walls[i]!;
    if (length < MIN_LENGTH) addWall(issue("short-wall"), wall);
    if (coincident && (coincident.nodeIds.has(wall.a) || coincident.nodeIds.has(wall.b))) {
      coincident.wallIds.add(wall.id);
    }
    for (let j = i + 1; j < walls.length; j++) {
      const other = walls[j]!;
      const duplicate = (wall.a === other.wall.a && wall.b === other.wall.b) ||
        (wall.a === other.wall.b && wall.b === other.wall.a);
      const hit = duplicate ? { kind: "overlap" as const } : intersection(a, b, other.a, other.b);
      let code: GeometryIssueCode | undefined;
      if (hit.kind === "overlap") code = "wall-overlap";
      if (hit.kind === "point") {
        const joined = [wall.a, wall.b].some(nodeId =>
          (nodeId === other.wall.a || nodeId === other.wall.b) &&
          distance(byNode.get(nodeId)!, hit.point) <= EPS);
        if (!joined) code = "wall-crossing";
      }
      if (code) {
        const result = issue(code);
        addWall(result, wall);
        addWall(result, other.wall);
      }
    }
  }
  const openingsByWall = new Map<string, Opening[]>();
  for (const opening of plan.openings) {
    const { wall, length } = byWall.get(opening.wallId)!;
    if (opening.offset - opening.width / 2 < -EPS || opening.offset + opening.width / 2 > length + EPS) {
      const result = issue("opening-outside");
      addWall(result, wall);
      result.openingIds.add(opening.id);
    }
    const attached = openingsByWall.get(wall.id) ?? [];
    for (const other of attached) {
      if (Math.min(opening.offset + opening.width / 2, other.offset + other.width / 2) >
        Math.max(opening.offset - opening.width / 2, other.offset - other.width / 2) + EPS) {
        const result = issue("opening-overlap");
        addWall(result, wall);
        result.openingIds.add(opening.id);
        result.openingIds.add(other.id);
      }
    }
    attached.push(opening);
    openingsByWall.set(wall.id, attached);
  }
  for (const dimension of plan.angleDimensions ?? []) {
    const first = byWall.get(dimension.wallA)!;
    const second = byWall.get(dimension.wallB)!;
    if (first.length < MIN_LENGTH || second.length < MIN_LENGTH) {
      const result = issue("undefined-angle");
      addWall(result, first.wall);
      addWall(result, second.wall);
      result.angleIds.add(dimension.id);
    }
  }
  return [...issues].map(([code, affected]) => ({
    code, message: messages[code],
    wallIds: [...affected.wallIds], nodeIds: [...affected.nodeIds],
    openingIds: [...affected.openingIds], angleIds: [...affected.angleIds],
  }));
}

export function constrainToAxis(point: Point, origin: Point): Point {
  finite(point.x, "Position X"); finite(point.y, "Position Y");
  finite(origin.x, "Origin X"); finite(origin.y, "Origin Y");
  return Math.abs(point.x - origin.x) >= Math.abs(point.y - origin.y)
    ? { x: point.x, y: origin.y } : { x: origin.x, y: point.y };
}

function findWall(plan: Plan, wallId: string): Wall {
  const wall = plan.walls.find(item => item.id === wallId);
  ensure(wall, "The selected wall no longer exists.");
  return wall;
}

function findSharedWallVertex(wallA: Wall, wallB: Wall): string | undefined {
  const shared = [wallA.a, wallA.b].filter(nodeId => nodeId === wallB.a || nodeId === wallB.b);
  return wallA.id !== wallB.id && shared.length === 1 ? shared[0] : undefined;
}

function sharedWallVertex(wallA: Wall, wallB: Wall): string {
  ensure(wallA.id !== wallB.id, "An angle dimension requires two different walls.");
  const vertex = findSharedWallVertex(wallA, wallB);
  ensure(vertex, "Angle dimension walls must share exactly one junction.");
  return vertex;
}

export function angleVertex(plan: Plan, wallA: string, wallB: string): Node {
  const vertex = sharedWallVertex(findWall(plan, wallA), findWall(plan, wallB));
  const node = plan.nodes.find(node => node.id === vertex);
  ensure(node, "This angle dimension refers to a missing junction.");
  return node;
}

function findOpening(plan: Plan, openingId: string): Opening {
  const opening = plan.openings.find(item => item.id === openingId);
  ensure(opening, "The selected opening no longer exists.");
  return opening;
}

function partitionWall(plan: Plan, wall: Wall, cuts: { node: Node; offset: number }[],
  angleDimensions = plan.angleDimensions, thicknessDimensions = plan.thicknessDimensions) {
  const walls: Wall[] = [];
  const openings: Opening[] = [];
  const attached = plan.openings.filter(opening => opening.wallId === wall.id);
  if (cuts.length === 2) return { walls: [wall], openings: attached, angleDimensions, thicknessDimensions };
  const thicknessUpdates = new Map<string, ThicknessDimension>();
  const length = distance(...wallPoints(plan, wall));
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    const segment = { ...wall, id: i === 0 ? wall.id : id(), a: from.node.id, b: to.node.id };
    walls.push(segment);
    // The original ID stays on the first segment; angles at the far end follow the last.
    if (segment.id !== wall.id && to.node.id === wall.b) {
      angleDimensions = angleDimensions?.map(dimension => dimension.vertex === wall.b
        ? {
          ...dimension,
          wallA: dimension.wallA === wall.id ? segment.id : dimension.wallA,
          wallB: dimension.wallB === wall.id ? segment.id : dimension.wallB,
        } : dimension);
    }
    for (const opening of attached) {
      if ((i === 0 || opening.offset >= from.offset) &&
        (i === cuts.length - 2 || opening.offset < to.offset)) {
        openings.push({ ...opening, wallId: segment.id, offset: opening.offset - from.offset });
      }
    }
    for (const dimension of thicknessDimensions ?? []) {
      if (dimension.wallId !== wall.id) continue;
      const station = length + dimension.offset;
      if ((i === 0 || station >= from.offset) && (i === cuts.length - 2 || station < to.offset)) {
        thicknessUpdates.set(dimension.id, { ...dimension, wallId: segment.id, offset: dimension.offset + (length - to.offset) });
      }
    }
  }
  return { walls, openings, angleDimensions,
    thicknessDimensions: thicknessDimensions?.map(dimension => thicknessUpdates.get(dimension.id) ?? dimension) };
}

export function splitWall(plan: Plan, wallId: string, offset: number): Plan {
  const wall = findWall(plan, wallId);
  const [a, b] = wallPoints(plan, wall);
  const length = distance(a, b);
  finite(offset, "Node position");
  ensure(length >= MIN_LENGTH, "Move the wall's junctions apart before adding a node.");
  ensure(offset > EPS && offset < length - EPS, "Place the new node between the wall's endpoints.");
  const node: Node = { id: id(), ...interpolate(a, b, offset / length) };
  const parts = partitionWall(plan, wall, [{ node: a, offset: 0 }, { node, offset }, { node: b, offset: length }]);
  const openings = new Map(parts.openings.map(opening => [opening.id, opening]));
  const roomNames = { ...plan.roomNames };
  for (const room of Object.keys(roomNames).length ? detectRooms(plan) : []) {
    if (!Object.hasOwn(roomNames, room.id)) continue;
    const includesWall = room.nodeIds.some((from, i) => {
      const to = room.nodeIds[(i + 1) % room.nodeIds.length];
      return from === wall.a && to === wall.b || from === wall.b && to === wall.a;
    });
    if (includesWall) {
      delete roomNames[room.id];
      roomNames[`room:${[...new Set([...room.nodeIds, node.id])].sort().join(":")}`] = room.name;
    }
  }
  return validatePlan({
    ...plan, nodes: [...plan.nodes, node], roomNames,
    walls: plan.walls.flatMap(item => item.id === wallId ? parts.walls : [item]),
    openings: plan.openings.map(opening => openings.get(opening.id) ?? opening),
    ...(Object.hasOwn(plan, "angleDimensions") ? { angleDimensions: parts.angleDimensions } : {}),
    ...(Object.hasOwn(plan, "thicknessDimensions") ? { thicknessDimensions: parts.thicknessDimensions } : {}),
  });
}

function insertWall(plan: Plan, start: Point, end: Point, thickness: number, reuseBoundary: boolean): Plan {
  checkPoint(start, "Wall start");
  checkPoint(end, "Wall end");
  checkThickness(thickness);
  const nodes = [...plan.nodes];
  const getNode = (point: Point): Node => {
    const existing = nodes.find(node => distance(node, point) <= EPS);
    if (existing) return existing;
    const node = { id: id(), ...copyPoint(point) };
    nodes.push(node);
    return node;
  };
  const aNode = getNode(start);
  let bNode = getNode(end);
  if (aNode.id === bNode.id) {
    bNode = { id: id(), ...copyPoint(end) };
    nodes.push(bNode);
  }
  const length = distance(aNode, bNode);
  const walls: Wall[] = [];
  const openingUpdates = new Map<string, Opening>();
  let angleDimensions = plan.angleDimensions;
  let thicknessDimensions = plan.thicknessDimensions;
  for (const wall of plan.walls) {
    const [c, d] = wallPoints(plan, wall);
    const wallLength = distance(c, d);
    const cuts = [{ node: c, offset: 0 }, { node: d, offset: wallLength }];
    for (const node of wallLength >= MIN_LENGTH ? [aNode, bNode] : []) {
      const projection = projectToWall(node, c, d);
      if (projection.distance <= EPS && projection.offset > EPS && projection.offset < wallLength - EPS &&
        cuts.every(cut => Math.abs(cut.offset - projection.offset) > EPS)) {
        // Splitting overlapping angle rays at the same point would give them two shared vertices.
        const overlapsAngleRay = plan.angleDimensions?.some(dimension => {
          const otherId = dimension.wallA === wall.id ? dimension.wallB
            : dimension.wallB === wall.id ? dimension.wallA : undefined;
          if (!otherId) return false;
          const [otherStart, otherEnd] = wallPoints(plan, findWall(plan, otherId));
          return projectToWall(node, otherStart, otherEnd).distance <= EPS;
        });
        if (overlapsAngleRay) continue;
        cuts.push({ node, offset: projection.offset });
      }
    }
    cuts.sort((left, right) => left.offset - right.offset);
    const parts = partitionWall(plan, wall, cuts, angleDimensions, thicknessDimensions);
    walls.push(...parts.walls);
    angleDimensions = parts.angleDimensions;
    thicknessDimensions = parts.thicknessDimensions;
    for (const opening of parts.openings) openingUpdates.set(opening.id, opening);
  }

  const interior = length > EPS ? nodes.map(node => ({ node, projection: projectToWall(node, aNode, bNode) }))
    .filter(item => item.projection.distance <= EPS &&
      item.projection.offset > EPS && item.projection.offset < length - EPS)
    .sort((left, right) => left.projection.offset - right.projection.offset)
    : [];
  const along = [aNode];
  let previousOffset = 0;
  for (const item of interior) {
    if (item.projection.offset - previousOffset > EPS) {
      along.push(item.node);
      previousOffset = item.projection.offset;
    }
  }
  along.push(bNode);
  for (let i = 0; i < along.length - 1; i++) {
    const from = along[i]!;
    const to = along[i + 1]!;
    const existing = walls.some(wall => (wall.a === from.id && wall.b === to.id) ||
      (wall.a === to.id && wall.b === from.id));
    if (!existing || !reuseBoundary) walls.push({ id: id(), a: from.id, b: to.id, thickness, dimension: true });
  }
  return validatePlan({
    ...plan, nodes, walls, openings: plan.openings.map(opening => openingUpdates.get(opening.id) ?? opening),
    ...(Object.hasOwn(plan, "angleDimensions") ? { angleDimensions } : {}),
    ...(Object.hasOwn(plan, "thicknessDimensions") ? { thicknessDimensions } : {}),
  });
}

export function addWall(plan: Plan, a: Point, b: Point, thickness: number): Plan {
  return insertWall(plan, a, b, thickness, false);
}

export function addRoom(plan: Plan, a: Point, b: Point, thickness: number): Plan {
  checkPoint(a);
  checkPoint(b);
  ensure(Math.abs(b.x - a.x) >= MIN_LENGTH && Math.abs(b.y - a.y) >= MIN_LENGTH,
    "A room must be at least 1 mm wide and 1 mm deep.");
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const corners = [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
  ];
  let next = plan;
  for (let i = 0; i < corners.length; i++) {
    next = insertWall(next, corners[i]!, corners[(i + 1) % corners.length]!, thickness, true);
  }
  ensure(next.walls.length !== plan.walls.length || next.nodes.length !== plan.nodes.length,
    "This room boundary already exists.");
  return next;
}

export function moveWall(plan: Plan, wallId: string, delta: Point): Plan {
  const wall = findWall(plan, wallId);
  finite(delta.x, "Horizontal movement");
  finite(delta.y, "Vertical movement");
  return validatePlan({
    ...plan,
    nodes: plan.nodes.map(node => node.id === wall.a || node.id === wall.b
      ? { ...node, x: node.x + delta.x, y: node.y + delta.y } : node),
  });
}

export function moveNode(plan: Plan, nodeId: string, position: Point): Plan {
  const node = plan.nodes.find(node => node.id === nodeId);
  ensure(node, "The selected junction no longer exists.");
  checkPoint(position, "Junction position");
  if (distance(node, position) <= EPS) return plan;
  return validatePlan({
    ...plan,
    nodes: plan.nodes.map(node => node.id === nodeId ? { ...node, ...copyPoint(position) } : node),
  });
}

function remapRoomNames(plan: Plan, next: Plan, replaceNode = (nodeId: string) => nodeId): Plan {
  if (!Object.keys(plan.roomNames).length) return next;
  const usedNodes = new Set(next.nodes.map(node => node.id));
  const survivingRooms = new Set(detectRooms(next).map(room => room.id));
  const roomNames = { ...plan.roomNames };
  for (const [previous, name] of Object.entries(plan.roomNames)) {
    const boundary = [...new Set(previous.slice(5).split(":").map(replaceNode).filter(id => usedNodes.has(id)))].sort();
    const key = `room:${boundary.join(":")}`;
    if (key !== previous && survivingRooms.has(key)) {
      delete roomNames[previous];
      if (!Object.hasOwn(roomNames, key)) roomNames[key] = name;
    }
  }
  return validatePlan({ ...next, roomNames });
}

export function mergeNodes(plan: Plan, nodeId: string, targetId: string): Plan {
  ensure(plan.nodes.some(node => node.id === nodeId), "The selected junction no longer exists.");
  ensure(plan.nodes.some(node => node.id === targetId), "The target junction no longer exists.");
  if (nodeId === targetId) return plan;
  const replaceNode = (id: string) => id === nodeId ? targetId : id;
  const walls = plan.walls.flatMap(wall => {
    const a = replaceNode(wall.a), b = replaceNode(wall.b);
    return a === b ? [] : [{ ...wall, a, b }];
  });
  const byWall = new Map(walls.map(wall => [wall.id, wall]));
  const usedNodes = new Set(walls.flatMap(wall => [wall.a, wall.b]));
  const angleDimensions = plan.angleDimensions?.flatMap(dimension => {
    const first = byWall.get(dimension.wallA), second = byWall.get(dimension.wallB);
    const vertex = replaceNode(dimension.vertex);
    if (!first || !second || findSharedWallVertex(first, second) !== vertex) return [];
    return [{ ...dimension, vertex }];
  });
  const next = validatePlan({
    ...plan, walls, nodes: plan.nodes.filter(node => usedNodes.has(node.id)),
    openings: plan.openings.filter(opening => byWall.has(opening.wallId)),
    ...(Object.hasOwn(plan, "angleDimensions") ? { angleDimensions } : {}),
    ...(Object.hasOwn(plan, "thicknessDimensions") ? {
      thicknessDimensions: plan.thicknessDimensions?.filter(dimension => byWall.has(dimension.wallId)),
    } : {}),
  });
  return remapRoomNames(plan, next, replaceNode);
}

export function resizeWall(plan: Plan, wallId: string, length: number): Plan {
  checkLength(length);
  const wall = findWall(plan, wallId);
  const [a, b] = wallPoints(plan, wall);
  const previousLength = distance(a, b);
  ensure(previousLength >= MIN_LENGTH,
    "Cannot resize a wall shorter than 1 mm. Move an endpoint to establish its direction.");
  const end = interpolate(a, b, length / previousLength);
  return validatePlan({
    ...plan, nodes: plan.nodes.map(node => node.id === b.id ? { ...node, ...end } : node),
  });
}

export function setWallThickness(plan: Plan, wallId: string, thickness: number): Plan {
  findWall(plan, wallId);
  checkThickness(thickness);
  return validatePlan({ ...plan, walls: plan.walls.map(wall => wall.id === wallId ? { ...wall, thickness } : wall) });
}

export function toggleDimension(plan: Plan, wallId: string): Plan {
  findWall(plan, wallId);
  return validatePlan({
    ...plan, walls: plan.walls.map(wall => wall.id === wallId ? { ...wall, dimension: !wall.dimension } : wall),
  });
}

export function setDimensionOffset(plan: Plan, wallId: string, offset: number): Plan {
  const wall = findWall(plan, wallId);
  finite(offset, "Dimension offset");
  ensure(Math.abs(offset) <= MAX_COORDINATE, "Dimension offset must be within 100 m of its wall.");
  if (wall.dimensionOffset === offset) return plan;
  return validatePlan({
    ...plan, walls: plan.walls.map(wall => wall.id === wallId ? { ...wall, dimensionOffset: offset } : wall),
  });
}

export function deleteWall(plan: Plan, wallId: string): Plan {
  findWall(plan, wallId);
  const walls = plan.walls.filter(wall => wall.id !== wallId);
  const usedNodes = new Set(walls.flatMap(wall => [wall.a, wall.b]));
  return validatePlan({
    ...plan, walls, nodes: plan.nodes.filter(node => usedNodes.has(node.id)),
    openings: plan.openings.filter(opening => opening.wallId !== wallId),
    ...(Object.hasOwn(plan, "angleDimensions") ? {
      angleDimensions: plan.angleDimensions?.filter(dimension => dimension.wallA !== wallId && dimension.wallB !== wallId),
    } : {}),
    ...(Object.hasOwn(plan, "thicknessDimensions") ? {
      thicknessDimensions: plan.thicknessDimensions?.filter(dimension => dimension.wallId !== wallId),
    } : {}),
  });
}

function nodeDeletionTopology(plan: Plan, nodeId: string) {
  ensure(plan.nodes.some(node => node.id === nodeId), "The selected junction no longer exists.");
  const attached = plan.walls.filter(wall => wall.a === nodeId || wall.b === nodeId);
  const ids = new Set(attached.map(wall => wall.id));
  let merged: Wall | undefined;
  if (attached.length === 2) {
    const [first, second] = attached;
    const other = second.a === nodeId ? second.b : second.a;
    const a = first.a === nodeId ? other : first.a;
    const b = first.b === nodeId ? other : first.b;
    if (a !== b) merged = { ...first, a, b, dimension: first.dimension || second.dimension };
  }
  const walls = plan.walls.flatMap(wall => !ids.has(wall.id) ? [wall]
    : merged && wall.id === merged.id ? [merged] : []);
  const byWall = new Map(walls.map(wall => [wall.id, wall]));
  const angleDimensions = plan.angleDimensions?.flatMap(dimension => {
    if (dimension.vertex === nodeId) return [];
    const wallA = ids.has(dimension.wallA) ? merged?.id : dimension.wallA;
    const wallB = ids.has(dimension.wallB) ? merged?.id : dimension.wallB;
    const first = wallA && byWall.get(wallA), second = wallB && byWall.get(wallB);
    if (!first || !second || wallA === wallB) return [];
    if (findSharedWallVertex(first, second) !== dimension.vertex) return [];
    return [{ ...dimension, wallA: first.id, wallB: second.id }];
  });
  return { attached, ids, merged, walls, angleDimensions };
}

export function getNodeDeletionInfo(plan: Plan, nodeId: string) {
  const { attached, ids, merged, angleDimensions } = nodeDeletionTopology(plan, nodeId);
  return {
    joinsWalls: !!merged,
    wallCount: attached.length,
    removedOpenings: merged ? 0 : plan.openings.filter(opening => ids.has(opening.wallId)).length,
    removedAngles: (plan.angleDimensions?.length ?? 0) - (angleDimensions?.length ?? 0),
    removedThickness: merged ? 0 : (plan.thicknessDimensions ?? []).filter(dimension => ids.has(dimension.wallId)).length,
    changesStyle: !!merged && (attached[0].thickness !== attached[1].thickness
      || attached[0].dimensionOffset !== attached[1].dimensionOffset),
  };
}

export function deleteNode(plan: Plan, nodeId: string): Plan {
  const { attached, ids, merged, walls, angleDimensions } = nodeDeletionTopology(plan, nodeId);
  const usedNodes = new Set(walls.flatMap(wall => [wall.a, wall.b]));
  const nodes = plan.nodes.filter(node => usedNodes.has(node.id));
  let openings = plan.openings.filter(opening => !ids.has(opening.wallId));
  let thicknessDimensions = plan.thicknessDimensions?.filter(dimension => !ids.has(dimension.wallId));
  if (merged) {
    const [a, b] = wallPoints(plan, merged);
    const length = distance(a, b);
    const junction = plan.nodes.find(node => node.id === nodeId)!;
    const joinedPosition = (source: Wall, position: number) => {
      const [start, end] = wallPoints(plan, source);
      const oldLength = distance(start, end);
      const firstSegment = source.a === merged.a || source.b === merged.a;
      const reversed = firstSegment ? source.b === merged.a : source.a === merged.b;
      let offset: number;
      if (oldLength > EPS && length > EPS) {
        // Project without clamping so existing overhangs remain editable.
        const center = interpolate(start, end, position / oldLength);
        offset = dot(subtract(center, a), subtract(b, a)) / length;
      } else {
        // Collapsed geometry has no projection axis; retain its oriented path position.
        offset = (firstSegment ? 0 : distance(a, junction))
          + (reversed ? oldLength - position : position);
      }
      return { offset, reversed };
    };
    openings = plan.openings.map(opening => {
      if (!ids.has(opening.wallId)) return opening;
      const source = attached.find(wall => wall.id === opening.wallId)!;
      const { offset, reversed } = joinedPosition(source, opening.offset);
      const next: Opening = { ...opening, wallId: merged.id, offset };
      if (reversed && opening.kind === "door") {
        next.flip = !opening.flip;
        if (opening.hingeAtEnd) delete next.hingeAtEnd;
        else next.hingeAtEnd = true;
      }
      return next;
    });
    thicknessDimensions = plan.thicknessDimensions?.map(dimension => {
      if (!ids.has(dimension.wallId)) return dimension;
      const source = attached.find(wall => wall.id === dimension.wallId)!;
      const station = distance(...wallPoints(plan, source)) + dimension.offset;
      return { ...dimension, wallId: merged.id, offset: joinedPosition(source, station).offset - length };
    });
  }
  const next = validatePlan({
    ...plan, nodes, walls, openings,
    ...(Object.hasOwn(plan, "angleDimensions") ? { angleDimensions } : {}),
    ...(Object.hasOwn(plan, "thicknessDimensions") ? { thicknessDimensions } : {}),
  });
  return remapRoomNames(plan, next);
}

export function addThicknessDimension(plan: Plan, wallId: string, offset = DEFAULT_THICKNESS_DIMENSION_OFFSET): Plan {
  const wall = findWall(plan, wallId);
  ensure(!isWallDegenerate(plan, wall), "Move the wall's junctions apart before adding a thickness measurement.");
  checkThicknessDimensionOffset(offset);
  return validatePlan({
    ...plan, thicknessDimensions: [...(plan.thicknessDimensions ?? []), { id: id(), wallId, offset }],
  });
}

export function updateThicknessDimension(plan: Plan, dimensionId: string, patch: { offset: number }): Plan {
  const dimension = plan.thicknessDimensions?.find(item => item.id === dimensionId);
  ensure(dimension, "The selected thickness measurement no longer exists.");
  exactKeys(record(patch, "Thickness measurement changes"), ["offset"], "Thickness measurement changes");
  checkThicknessDimensionOffset(patch.offset);
  if (dimension.offset === patch.offset) return plan;
  return validatePlan({
    ...plan, thicknessDimensions: plan.thicknessDimensions!.map(item => item.id === dimensionId ? { ...item, ...patch } : item),
  });
}

export function deleteThicknessDimension(plan: Plan, dimensionId: string): Plan {
  const dimensions = plan.thicknessDimensions;
  ensure(dimensions && dimensions.some(item => item.id === dimensionId), "The selected thickness measurement no longer exists.");
  return validatePlan({ ...plan, thicknessDimensions: dimensions.filter(item => item.id !== dimensionId) });
}

export function addAngleDimension(plan: Plan, dimension: Omit<AngleDimension, "id">): Plan {
  const fields = record(dimension, "Angle dimension");
  exactKeys(fields, ["wallA", "wallB", "vertex", "radius", "clockwise"], "Angle dimension");
  return validatePlan({
    ...plan, angleDimensions: [...(plan.angleDimensions ?? []), { id: id(), ...dimension }],
  });
}

export function updateAngleDimension(
  plan: Plan, dimensionId: string, patch: Partial<Pick<AngleDimension, "radius" | "clockwise">>,
): Plan {
  const dimension = plan.angleDimensions?.find(item => item.id === dimensionId);
  ensure(dimension, "The selected angle dimension no longer exists.");
  const fields = record(patch, "Angle dimension changes");
  ensure(Object.keys(fields).every(key => ["radius", "clockwise"].includes(key)),
    "Only the angle dimension radius and direction can be changed.");
  const updated = { ...dimension, ...patch };
  if (updated.radius === dimension.radius && updated.clockwise === dimension.clockwise) return plan;
  return validatePlan({
    ...plan, angleDimensions: plan.angleDimensions!.map(item => item.id === dimensionId ? updated : item),
  });
}

function checkAngle(degrees: number): void {
  finite(degrees, "Angle");
  ensure(degrees > 0 && degrees < 360, "Angle must be greater than 0 and less than 360 degrees.");
}

export function parseAngle(input: string): number {
  const degrees = evaluateMeasurement(input, "angle");
  checkAngle(degrees);
  return degrees;
}

export function resizeAngle(plan: Plan, dimensionId: string, degrees: number): Plan {
  checkAngle(degrees);
  const dimension = plan.angleDimensions?.find(item => item.id === dimensionId);
  ensure(dimension, "The selected angle dimension no longer exists.");
  const vertex = angleVertex(plan, dimension.wallA, dimension.wallB);
  const fixedEnd = wallPoints(plan, findWall(plan, dimension.wallA)).find(node => node.id !== vertex.id)!;
  const movingEnd = wallPoints(plan, findWall(plan, dimension.wallB)).find(node => node.id !== vertex.id)!;
  const length = distance(vertex, movingEnd);
  ensure(length >= MIN_LENGTH && distance(vertex, fixedEnd) >= MIN_LENGTH,
    "This angle is undefined because an attached wall is shorter than 1 mm. Move an endpoint first.");
  const direction = Math.atan2(fixedEnd.y - vertex.y, fixedEnd.x - vertex.x)
    + (dimension.clockwise ? 1 : -1) * degrees * Math.PI / 180;
  // Keep the first wall and vertex fixed; shared neighbors follow the second wall's endpoint.
  return moveNode(plan, movingEnd.id, {
    x: vertex.x + Math.cos(direction) * length,
    y: vertex.y + Math.sin(direction) * length,
  });
}

export function deleteAngleDimension(plan: Plan, dimensionId: string): Plan {
  const dimensions = plan.angleDimensions;
  ensure(dimensions && dimensions.some(dimension => dimension.id === dimensionId),
    "The selected angle dimension no longer exists.");
  return validatePlan({
    ...plan, angleDimensions: dimensions.filter(dimension => dimension.id !== dimensionId),
  });
}

export function addOpening(
  plan: Plan, wallId: string, kind: Opening["kind"], offset: number, width: number,
): Plan {
  findWall(plan, wallId);
  return validatePlan({
    ...plan, openings: [...plan.openings, { id: id(), wallId, kind, offset, width, flip: false }],
  });
}

export function updateOpening(
  plan: Plan, openingId: string, patch: Partial<Pick<Opening, "offset" | "width" | "flip">>,
): Plan {
  findOpening(plan, openingId);
  const fields = record(patch, "Opening changes");
  ensure(Object.keys(fields).every(key => ["offset", "width", "flip"].includes(key)),
    "Only the opening position, width, and swing can be changed.");
  return validatePlan({
    ...plan, openings: plan.openings.map(opening => opening.id === openingId ? { ...opening, ...patch } : opening),
  });
}

export function deleteOpening(plan: Plan, openingId: string): Plan {
  findOpening(plan, openingId);
  return validatePlan({ ...plan, openings: plan.openings.filter(opening => opening.id !== openingId) });
}

export function detectRooms(plan: Plan, issues: GeometryIssue[] = getGeometryIssues(plan)): Room[] {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]));
  const invalidWalls = new Set(issues
    .filter(issue => ["short-wall", "coincident-nodes", "wall-overlap", "wall-crossing"].includes(issue.code))
    .flatMap(issue => issue.wallIds));
  const invalidEdges = new Set<string>();
  const skippedWalls: Wall[] = [];
  const neighbors = new Map<string, string[]>();
  for (const wall of plan.walls) {
    if (distance(nodes.get(wall.a)!, nodes.get(wall.b)!) < MIN_LENGTH) {
      skippedWalls.push(wall);
      continue;
    }
    for (const [from, to] of [[wall.a, wall.b], [wall.b, wall.a]]) {
      const list = neighbors.get(from!) ?? [];
      if (!list.includes(to!)) list.push(to!);
      neighbors.set(from!, list);
      if (invalidWalls.has(wall.id)) invalidEdges.add(`${from}:${to}`);
    }
  }
  for (const [nodeId, list] of neighbors) {
    const node = nodes.get(nodeId)!;
    list.sort((left, right) => {
      const a = nodes.get(left)!;
      const b = nodes.get(right)!;
      return Math.atan2(a.y - node.y, a.x - node.x) - Math.atan2(b.y - node.y, b.x - node.x);
    });
  }
  const visited = new Set<string>();
  const rooms: Room[] = [];
  for (const [start, list] of neighbors) {
    for (const end of list) {
      if (visited.has(`${start}:${end}`)) continue;
      const boundary: string[] = [];
      let conflicted = false;
      let from = start;
      let to = end;
      while (!visited.has(`${from}:${to}`)) {
        visited.add(`${from}:${to}`);
        if (invalidEdges.has(`${from}:${to}`)) conflicted = true;
        boundary.push(from);
        const outgoing = neighbors.get(to)!;
        const reverse = outgoing.indexOf(from);
        // The clockwise successor of the reverse edge keeps a face on the left.
        const next = outgoing[(reverse + outgoing.length - 1) % outgoing.length]!;
        from = to;
        to = next;
      }
      if (conflicted || from !== start || to !== end || boundary.length < 3) continue;
      const boundaryNodes = new Set(boundary);
      // A skipped short partition must not turn its two faces into one apparently valid room.
      if (skippedWalls.some(wall => boundaryNodes.has(wall.a) && boundaryNodes.has(wall.b))) continue;
      const points = boundary.map(nodeId => copyPoint(nodes.get(nodeId)!));
      const base = points[0]!;
      let twiceArea = 0;
      let centerX = 0;
      let centerY = 0;
      for (let i = 0; i < points.length; i++) {
        const a = subtract(points[i]!, base);
        const b = subtract(points[(i + 1) % points.length]!, base);
        const weight = cross(a, b);
        twiceArea += weight;
        centerX += (a.x + b.x) * weight;
        centerY += (a.y + b.y) * weight;
      }
      // Exterior walks have negative area; open chains and bridges enclose none.
      if (twiceArea <= EPS) continue;
      const roomId = `room:${[...boundaryNodes].sort().join(":")}`;
      rooms.push({
        id: roomId, nodeIds: boundary, points, area: twiceArea / 2,
        center: { x: base.x + centerX / (3 * twiceArea), y: base.y + centerY / (3 * twiceArea) },
        name: Object.hasOwn(plan.roomNames, roomId) ? plan.roomNames[roomId]! : "Room",
      });
    }
  }
  return rooms.sort((a, b) => a.id.localeCompare(b.id));
}

export function renameRoom(plan: Plan, roomId: string, name: string): Plan {
  ensure(detectRooms(plan).some(room => room.id === roomId), "The selected room is no longer enclosed.");
  ensure(typeof name === "string", "Room name must be text.");
  const trimmed = name.trim();
  ensure(trimmed.length > 0 && trimmed.length <= MAX_NAME, "Room name must contain 1 to 120 characters.");
  return validatePlan({ ...plan, roomNames: { ...plan.roomNames, [roomId]: trimmed } });
}

export type MeasurementSettings = Plan["units"] | Pick<Plan, "units" | "lengthUnits">;

export function getLengthUnit(settings: MeasurementSettings): LengthUnit {
  const units = typeof settings === "string" ? settings : settings.units;
  checkUnits(units);
  const selected = typeof settings === "string" ? undefined : settings.lengthUnits?.[units];
  ensure(selected === undefined || (units === "metric" ? selected === "m" || selected === "cm" : selected === "ft" || selected === "in"),
    "Length units must match the measurement system.");
  return selected ?? (units === "metric" ? "m" : "ft");
}

export function setLengthUnit(plan: Plan, unit: string): Plan {
  ensure(plan.units === "metric" ? unit === "m" || unit === "cm" : unit === "ft" || unit === "in",
    "Choose meters or centimeters for metric, or feet or inches for imperial.");
  if (getLengthUnit(plan) === unit) return plan;
  const lengthUnits: LengthUnits = plan.lengthUnits ?? { metric: "m", imperial: "ft" };
  return validatePlan({
    ...plan, lengthUnits: unit === "m" || unit === "cm"
      ? { ...lengthUnits, metric: unit } : { ...lengthUnits, imperial: unit },
  });
}

export function formatLength(mm: number, units: MeasurementSettings): string {
  finite(mm, "Length");
  ensure(mm >= 0, "Length cannot be negative.");
  const unit = getLengthUnit(units);
  if (unit === "m") return `${Number((mm / 1_000).toFixed(3))} m`;
  if (unit === "cm") return `${Number((mm / 10).toFixed(1))} cm`;
  const scaledInches = Math.round(mm / 25.4 * 10_000);
  if (unit === "in") return `${scaledInches / 10_000}"`;
  const feet = Math.floor(scaledInches / 120_000);
  const inches = (scaledInches - feet * 120_000) / 10_000;
  return `${feet}' ${inches}"`;
}

export function formatLengthInput(mm: number, units: MeasurementSettings): string {
  finite(mm, "Length");
  const unit = getLengthUnit(units);
  if (unit === "m") return `${Number((mm / 1000).toFixed(4))} m`;
  if (unit === "cm") return `${Number((mm / 10).toFixed(2))} cm`;
  return `${mm < 0 ? "-" : ""}${formatLength(Math.abs(mm), units)}`;
}

function checkUnits(units: unknown): asserts units is Plan["units"] {
  ensure(units === "metric" || units === "imperial", "Units must be metric or imperial.");
}

function parseMeasurement(input: string, units: MeasurementSettings, position: boolean): number {
  const result = evaluateMeasurement(input, getLengthUnit(units));
  ensure(Number.isFinite(result) && (position || result > 0),
    position ? "Position must be a finite length or zero." : "Length must be greater than zero and finite.");
  ensure(Math.abs(result) <= MAX_SCENE_LENGTH, "This length exceeds the drawing's 100 m coordinate limit.");
  return result === 0 ? 0 : result;
}

export function parseLength(input: string, units: MeasurementSettings): number {
  return parseMeasurement(input, units, false);
}

export function parsePosition(input: string, units: MeasurementSettings): number {
  return parseMeasurement(input, units, true);
}

const areaFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
export function formatArea(mm2: number, units: Plan["units"]): string {
  finite(mm2, "Area");
  ensure(mm2 >= 0, "Area cannot be negative.");
  checkUnits(units);
  const value = mm2 / (units === "metric" ? 1_000_000 : 304.8 ** 2);
  return `${areaFormatter.format(value)} ${units === "metric" ? "m\u00b2" : "ft\u00b2"}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  ensure(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object.`);
  const prototype: unknown = Object.getPrototypeOf(value);
  ensure(prototype === Object.prototype || prototype === null, `${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value);
  ensure(actual.length === keys.length && actual.every(key => keys.includes(key)),
    `${label} has missing or unsupported fields.`);
}

function identifier(value: unknown, label: string): string {
  ensure(typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value), `${label} must be a valid identifier (1 to 80 characters).`);
  return value;
}

function textName(value: unknown, label: string): string {
  ensure(typeof value === "string" && value.trim().length > 0 && value.length <= MAX_NAME,
    `${label} must contain 1 to 120 characters.`);
  return value.trim();
}

function collection(value: unknown, max: number, label: string): unknown[] {
  ensure(Array.isArray(value), `${label} must be a list.`);
  ensure(value.length <= max, `${label} exceeds the limit of ${max} items.`);
  for (let i = 0; i < value.length; i++) {
    ensure(Object.hasOwn(value, i), `${label} cannot contain missing list entries.`);
  }
  return value;
}

export function validatePlan(value: unknown): Plan {
  const source = record(value, "Plan");
  exactKeys(source, ["version", "name", "units", "nodes", "walls", "openings", "roomNames",
    ...(Object.hasOwn(source, "lengthUnits") ? ["lengthUnits"] : []),
    ...(Object.hasOwn(source, "angleDimensions") ? ["angleDimensions"] : []),
    ...(Object.hasOwn(source, "thicknessDimensions") ? ["thicknessDimensions"] : [])], "Plan");
  ensure(source.version === 1, "Unsupported plan version. Expected version 1.");
  const name = textName(source.name, "Plan name");
  checkUnits(source.units);
  let lengthUnits: LengthUnits | undefined;
  if (Object.hasOwn(source, "lengthUnits")) {
    const preference = record(source.lengthUnits, "Length units");
    exactKeys(preference, ["metric", "imperial"], "Length units");
    ensure(preference.metric === "m" || preference.metric === "cm", "Metric length units must be m or cm.");
    ensure(preference.imperial === "ft" || preference.imperial === "in", "Imperial length units must be ft or in.");
    lengthUnits = { metric: preference.metric, imperial: preference.imperial };
  }
  const seenIds = new Set<string>();
  const uniqueId = (value: unknown, label: string): string => {
    const result = identifier(value, label);
    ensure(!seenIds.has(result), "The plan contains duplicate identifiers.");
    seenIds.add(result);
    return result;
  };
  const nodes = collection(source.nodes, MAX_NODES, "Junctions").map(value => {
    const node = record(value, "Junction");
    exactKeys(node, ["id", "x", "y"], "Junction");
    finite(node.x, "Junction X");
    finite(node.y, "Junction Y");
    const result: Node = { id: uniqueId(node.id, "Junction ID"), x: node.x, y: node.y };
    checkPoint(result, "Junction");
    return result;
  });
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const usedNodes = new Set<string>();
  const walls = collection(source.walls, MAX_WALLS, "Walls").map(value => {
    const wall = record(value, "Wall");
    exactKeys(wall, ["id", "a", "b", "thickness", "dimension",
      ...(Object.hasOwn(wall, "dimensionOffset") ? ["dimensionOffset"] : [])], "Wall");
    const wallId = uniqueId(wall.id, "Wall ID");
    const a = identifier(wall.a, "Wall start");
    const b = identifier(wall.b, "Wall end");
    ensure(a !== b, "A wall must connect two different junctions.");
    const start = byNode.get(a);
    const end = byNode.get(b);
    ensure(start && end, "A wall refers to a missing junction.");
    finite(wall.thickness, "Wall thickness");
    checkThickness(wall.thickness);
    ensure(typeof wall.dimension === "boolean", "Wall dimension visibility must be true or false.");
    usedNodes.add(a);
    usedNodes.add(b);
    const result: Wall = { id: wallId, a, b, thickness: wall.thickness, dimension: wall.dimension };
    if (Object.hasOwn(wall, "dimensionOffset")) {
      finite(wall.dimensionOffset, "Dimension offset");
      ensure(Math.abs(wall.dimensionOffset) <= MAX_COORDINATE, "Dimension offset must be within 100 m of its wall.");
      result.dimensionOffset = wall.dimensionOffset;
    }
    return result;
  });
  ensure(usedNodes.size === nodes.length, "The plan contains unused junctions.");
  const byWall = new Map(walls.map(wall => [wall.id, wall]));
  const openings: Opening[] = collection(source.openings, MAX_OPENINGS, "Openings").map(value => {
    const opening = record(value, "Opening");
    exactKeys(opening, ["id", "wallId", "kind", "offset", "width", "flip",
      ...(Object.hasOwn(opening, "hingeAtEnd") ? ["hingeAtEnd"] : [])], "Opening");
    const openingId = uniqueId(opening.id, "Opening ID");
    const wallId = identifier(opening.wallId, "Opening wall");
    const wall = byWall.get(wallId);
    ensure(wall, "An opening refers to a missing wall.");
    ensure(opening.kind === "door" || opening.kind === "window", "Opening type must be door or window.");
    finite(opening.offset, "Opening position");
    finite(opening.width, "Opening width");
    ensure(opening.width >= MIN_LENGTH, "Opening width must be at least 1 mm.");
    ensure(opening.width <= MAX_SCENE_LENGTH, "Opening width exceeds the drawing's maximum length.");
    ensure(Math.abs(opening.offset) <= MAX_SCENE_LENGTH, "Opening position exceeds the drawing's maximum length.");
    ensure(typeof opening.flip === "boolean", "Opening swing must be true or false.");
    const result: Opening = {
      id: openingId, wallId, kind: opening.kind, offset: opening.offset, width: opening.width, flip: opening.flip,
    };
    if (Object.hasOwn(opening, "hingeAtEnd")) {
      ensure(opening.kind === "door" && typeof opening.hingeAtEnd === "boolean",
        "Door hinge side must be true or false and can only be set on doors.");
      result.hingeAtEnd = opening.hingeAtEnd;
    }
    return result;
  });
  let angleDimensions: AngleDimension[] | undefined;
  if (Object.hasOwn(source, "angleDimensions")) {
    const sectors = new Set<string>();
    angleDimensions = collection(source.angleDimensions, MAX_ANGLE_DIMENSIONS, "Angle dimensions").map(value => {
      const dimension = record(value, "Angle dimension");
      exactKeys(dimension, ["id", "wallA", "wallB", "vertex", "radius", "clockwise"], "Angle dimension");
      const dimensionId = uniqueId(dimension.id, "Angle dimension ID");
      const wallA = identifier(dimension.wallA, "Angle dimension first wall");
      const wallB = identifier(dimension.wallB, "Angle dimension second wall");
      const vertex = identifier(dimension.vertex, "Angle dimension vertex");
      const first = byWall.get(wallA);
      const second = byWall.get(wallB);
      ensure(first && second, "An angle dimension refers to a missing wall.");
      ensure(sharedWallVertex(first, second) === vertex, "An angle dimension vertex must be the walls' shared junction.");
      finite(dimension.radius, "Angle dimension radius");
      ensure(dimension.radius >= 100 && dimension.radius <= MAX_COORDINATE,
        "Angle dimension radius must be between 100 and 100000 mm.");
      ensure(typeof dimension.clockwise === "boolean", "Angle dimension direction must be true or false.");
      const sector = wallA < wallB
        ? `${wallA}:${wallB}:${dimension.clockwise}`
        : `${wallB}:${wallA}:${!dimension.clockwise}`;
      ensure(!sectors.has(sector), "The plan contains duplicate angle dimensions for the same wall pair and sector.");
      sectors.add(sector);
      return { id: dimensionId, wallA, wallB, vertex, radius: dimension.radius, clockwise: dimension.clockwise };
    });
  }
  let thicknessDimensions: ThicknessDimension[] | undefined;
  if (Object.hasOwn(source, "thicknessDimensions")) {
    thicknessDimensions = collection(source.thicknessDimensions, MAX_THICKNESS_DIMENSIONS, "Thickness measurements").map(value => {
      const dimension = record(value, "Thickness measurement");
      exactKeys(dimension, ["id", "wallId", "offset"], "Thickness measurement");
      const dimensionId = uniqueId(dimension.id, "Thickness measurement ID");
      const wallId = identifier(dimension.wallId, "Thickness measurement wall");
      ensure(byWall.has(wallId), "A thickness measurement refers to a missing wall.");
      checkThicknessDimensionOffset(dimension.offset);
      return { id: dimensionId, wallId, offset: dimension.offset };
    });
  }
  const names = record(source.roomNames, "Room names");
  const entries = Object.entries(names);
  ensure(entries.length <= MAX_WALLS, "Too many saved room names.");
  let nameSize = 0;
  const roomNames = Object.fromEntries(entries.map(([key, value]) => {
    ensure(key.startsWith("room:") && key.length <= MAX_NODES * 81 + 5, "Invalid saved room identifier.");
    nameSize += key.length;
    ensure(nameSize <= 1_000_000, "Saved room identifiers are too large.");
    const boundary = key.slice(5).split(":");
    ensure(boundary.length >= 3 && boundary.length <= MAX_NODES &&
      boundary.every(nodeId => /^[A-Za-z0-9_-]{1,80}$/.test(nodeId)) &&
      new Set(boundary).size === boundary.length &&
      `room:${[...boundary].sort().join(":")}` === key,
    "Invalid saved room identifier.");
    return [key, textName(value, "Room name")];
  }));
  return {
    version: 1, name, units: source.units, nodes, walls, openings, roomNames,
    ...(lengthUnits !== undefined ? { lengthUnits } : {}),
    ...(angleDimensions !== undefined ? { angleDimensions } : {}),
    ...(thicknessDimensions !== undefined ? { thicknessDimensions } : {}),
  };
}

export function createDemoPlan(): Plan {
  let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4_200, y: 4_800 }, 150);
  plan = addRoom(plan, { x: 4_200, y: 0 }, { x: 6_800, y: 4_800 }, 150);
  const wallAt = (a: Point, b: Point): Wall => {
    const wall = plan.walls.find(wall => {
      const [start, end] = wallPoints(plan, wall);
      return (distance(start, a) <= EPS && distance(end, b) <= EPS) ||
        (distance(start, b) <= EPS && distance(end, a) <= EPS);
    });
    ensure(wall, "The example plan is missing a wall.");
    return wall;
  };
  const partition = wallAt({ x: 4_200, y: 0 }, { x: 4_200, y: 4_800 });
  plan = setWallThickness(plan, partition.id, 100);
  plan = toggleDimension(plan, partition.id);
  plan = addOpening(plan, partition.id, "door", 3_500, 850);
  plan = addOpening(plan, wallAt({ x: 0, y: 0 }, { x: 0, y: 4_800 }).id, "door", 1_100, 900);
  plan = addOpening(plan, wallAt({ x: 0, y: 0 }, { x: 4_200, y: 0 }).id, "window", 2_100, 1_800);
  plan = addOpening(plan, wallAt({ x: 4_200, y: 0 }, { x: 6_800, y: 0 }).id, "window", 1_300, 1_200);
  plan = addOpening(plan, wallAt({ x: 6_800, y: 0 }, { x: 6_800, y: 4_800 }).id, "window", 2_400, 1_600);
  for (const room of detectRooms(plan)) {
    plan = renameRoom(plan, room.id, room.center.x < 4_200 ? "Living room" : "Kitchen");
  }
  return { ...plan, name: "The Sunday House" };
}
