import { constrainToAxis, distance, projectToWall, wallPoints, type Plan, type Point, type Wall } from "./model";

export type SnapGuide = {
  id: string;
  kind: "alignment" | "wall" | "extension" | "point" | "constraint";
  a: Point;
  b: Point;
  target?: Point;
};
export type SnapResult = { point: Point; guides: SnapGuide[] };

type Axis = "x" | "y";
type Reference = { id: string; point: Point };
type WallReference = { id: string; a: Point; b: Point; length: number; unit: Point };
type Scene = { points: Reference[]; alignments: Reference[]; walls: WallReference[] };
type Anchor = { id: string; base: Point; point: Point };
type Match =
  | { kind: "point"; anchor: Anchor; source: Reference }
  | { kind: "alignment"; anchor: Anchor; source: Reference; axis: Axis }
  | { kind: "wall" | "extension"; anchor: Anchor; wall: WallReference };
type Ranked = { gap: number; key: string };
type Candidate = Ranked & { delta: Point; matches: Match[] };
type Alignment = Ranked & { value: number; match: Extract<Match, { kind: "alignment" }> };

const MAX_COORDINATE = 100_000;
const MAX_OFFSET = 2 * MAX_COORDINATE * Math.SQRT2;
const EPS = 1e-6;
const axes = ["x", "y"] as const;
const zero: Point = { x: 0, y: 0 };
const copy = (point: Point): Point => ({ x: point.x, y: point.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const otherAxis = (axis: Axis): Axis => axis === "x" ? "y" : "x";
const quantize = (value: number, grid: number) => grid > 0 ? Math.round(value / grid) * grid : value;

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
}

function checkPoint(point: Point, label = "Position"): void {
  finite(point.x, `${label} X`);
  finite(point.y, `${label} Y`);
  if (Math.abs(point.x) > MAX_COORDINATE || Math.abs(point.y) > MAX_COORDINATE) {
    throw new Error(`${label} must be within 100 m of the drawing origin.`);
  }
}

function checkSettings(grid: number, threshold: number): void {
  finite(grid, "Grid spacing");
  finite(threshold, "Snap distance");
  if (grid < 0 || threshold < 0) throw new Error("Grid spacing and snap distance cannot be negative.");
}

function checkDelta(delta: Point): void {
  finite(delta.x, "Horizontal movement");
  finite(delta.y, "Vertical movement");
  if (Math.abs(delta.x) > 2 * MAX_COORDINATE || Math.abs(delta.y) > 2 * MAX_COORDINATE) {
    throw new Error("Movement exceeds the drawing coordinate limit.");
  }
}

function checkOffset(offset: number): void {
  finite(offset, "Opening offset");
  if (Math.abs(offset) > MAX_OFFSET) throw new Error("Opening offset exceeds the drawing coordinate limit.");
}

function better<T extends Ranked>(best: T | undefined, candidate: T): T {
  return !best || candidate.gap < best.gap || (candidate.gap === best.gap && candidate.key < best.key)
    ? candidate : best;
}

function sceneReferences(plan: Plan, excluded = new Set<string>()): Scene {
  const nodes = new Map(plan.nodes.map(node => {
    checkPoint(node, "Junction position");
    return [node.id, node] as const;
  }));
  const points: Reference[] = plan.nodes.filter(node => !excluded.has(node.id))
    .map(node => ({ id: `node:${node.id}`, point: node }));
  const alignments = [...points];
  const walls: WallReference[] = [];
  for (const wall of plan.walls) {
    const a = nodes.get(wall.a), b = nodes.get(wall.b);
    if (!a || !b) throw new Error("This wall refers to a missing junction.");
    if (excluded.has(wall.a) || excluded.has(wall.b)) continue;
    const length = distance(a, b);
    if (length === 0) continue;
    walls.push({ id: wall.id, a, b, length, unit: { x: (b.x - a.x) / length, y: (b.y - a.y) / length } });
    alignments.push({ id: `midpoint:${wall.id}`, point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
  }
  return { points, alignments, walls };
}

function wallTargets(wall: WallReference, point: Point, threshold: number, axis?: Axis): { segment?: Point; extension?: Point } {
  const { a, b, unit, length } = wall;
  if (axis) {
    const locked = otherAxis(axis);
    const span = b[locked] - a[locked];
    if (span !== 0) {
      const t = (point[locked] - a[locked]) / span;
      const target = { ...point, [axis]: a[axis] + (b[axis] - a[axis]) * t };
      if (Math.abs(target[axis] - point[axis]) > threshold + EPS) return {};
      return t >= 0 && t <= 1 ? { segment: target } : { extension: target };
    }
    if (a[locked] !== point[locked]) return {};
  }
  const offset = (point.x - a.x) * unit.x + (point.y - a.y) * unit.y;
  const perpendicular = Math.abs((point.x - a.x) * unit.y - (point.y - a.y) * unit.x);
  if (perpendicular > threshold + EPS) return {};
  return {
    segment: offset >= -threshold - EPS && offset <= length + threshold + EPS
      ? projectToWall(point, a, b).point : undefined,
    extension: offset < 0 || offset > length
      ? (axis ? copy(point) : { x: a.x + unit.x * offset, y: a.y + unit.y * offset })
      : undefined,
  };
}

function rangeStart(references: Reference[], axis: Axis, value: number): number {
  let lo = 0, hi = references.length;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (references[middle].point[axis] < value) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

function geometricSnap(scene: Scene, anchors: Anchor[], delta: Point, threshold: number, grid: number, axis?: Axis): Candidate | undefined {
  if (threshold === 0) return undefined;
  const candidateAt = (anchor: Anchor, point: Point, key: string, match: Match): Candidate | undefined => {
    const next = subtract(point, anchor.base);
    if (axis) next[otherAxis(axis)] = delta[otherAxis(axis)];
    const gap = distance(delta, next);
    return gap <= threshold ? { delta: next, gap, key, matches: [match] } : undefined;
  };

  let node: Candidate | undefined;
  const pointsByX = [...scene.points].sort((a, b) => a.point.x - b.point.x);
  for (const anchor of anchors) {
    for (let i = rangeStart(pointsByX, "x", anchor.point.x - threshold - EPS); i < pointsByX.length; i++) {
      const source = pointsByX[i];
      if (source.point.x > anchor.point.x + threshold + EPS) break;
      if (Math.abs(source.point.y - anchor.point.y) > threshold + EPS) continue;
      if (axis && source.point[otherAxis(axis)] !== anchor.point[otherAxis(axis)]) continue;
      const candidate = candidateAt(anchor, source.point, `point:${source.id}:${anchor.id}`,
        { kind: "point", source, anchor });
      if (candidate) node = better(node, candidate);
    }
  }
  if (node) return node;

  let segment: Candidate | undefined, extension: Candidate | undefined;
  for (const anchor of anchors) {
    for (const wall of scene.walls) {
      const targets = wallTargets(wall, anchor.point, threshold, axis);
      if (!targets.segment && !targets.extension) continue;
      for (const kind of ["wall", "extension"] as const) {
        const point = kind === "wall" ? targets.segment : targets.extension;
        if (!point) continue;
        const candidate = candidateAt(anchor, point, `${kind}:${wall.id}:${anchor.id}`, { kind, wall, anchor });
        if (!candidate) continue;
        if (kind === "wall") segment = better(segment, candidate);
        else extension = better(extension, candidate);
      }
    }
  }
  const attached = segment ?? extension;

  // Keep only the best match per axis, not every possible reference pair.
  let x: Alignment | undefined, y: Alignment | undefined;
  const references = {
    x: [...scene.alignments].sort((a, b) => a.point.x - b.point.x),
    y: [...scene.alignments].sort((a, b) => a.point.y - b.point.y),
  };
  for (const anchor of anchors) {
    for (const coordinate of axes) {
      if (axis && axis !== coordinate) continue;
      const sorted = references[coordinate], level = anchor.point[coordinate];
      for (let i = rangeStart(sorted, coordinate, level - threshold - EPS); i < sorted.length; i++) {
        const source = sorted[i];
        if (source.point[coordinate] > level + threshold + EPS) break;
        const value = source.point[coordinate] - anchor.base[coordinate];
        const gap = Math.abs(value - delta[coordinate]);
        if (gap > threshold || Math.abs(source.point[otherAxis(coordinate)] - anchor.point[otherAxis(coordinate)]) <= EPS) continue;
        const candidate: Alignment = {
          value, gap, key: `alignment:${coordinate}:${source.id}:${anchor.id}`,
          match: { kind: "alignment", axis: coordinate, source, anchor },
        };
        if (coordinate === "x") x = better(x, candidate);
        else y = better(y, candidate);
      }
    }
  }
  if (attached) {
    const match = attached.matches[0];
    if (match.kind !== "wall" && match.kind !== "extension") return attached;
    let combined: Candidate | undefined;
    // Refine along the chosen wall, never away from it, when another reference is compatible.
    for (const alignment of [x, y]) {
      if (!alignment) continue;
      const coordinate = alignment.match.axis;
      const change = alignment.value - attached.delta[coordinate];
      if (Math.abs(match.wall.unit[coordinate]) < EPS) continue;
      const travel = change / match.wall.unit[coordinate];
      const next = {
        x: attached.delta.x + match.wall.unit.x * travel,
        y: attached.delta.y + match.wall.unit.y * travel,
      };
      if (axis && Math.abs(next[otherAxis(axis)] - delta[otherAxis(axis)]) > EPS) continue;
      if (axis) next[otherAxis(axis)] = delta[otherAxis(axis)];
      const gap = distance(next, delta);
      if (gap > threshold) continue;
      const point = add(match.anchor.base, next);
      const station = (point.x - match.wall.a.x) * match.wall.unit.x + (point.y - match.wall.a.y) * match.wall.unit.y;
      if (match.kind === "wall" ? station < 0 || station > match.wall.length : station >= 0 && station <= match.wall.length) continue;
      combined = better(combined, { delta: next, gap, key: alignment.key, matches: [...attached.matches, alignment.match] });
    }
    if (combined) return combined;
    // A wall parallel to Shift constrains no additional coordinate; keep the free-axis grid.
    if (axis && match.wall.unit[otherAxis(axis)] === 0) {
      const next = quantizedPoint(delta, grid, axis);
      const point = add(match.anchor.base, next);
      const station = (point.x - match.wall.a.x) * match.wall.unit.x + (point.y - match.wall.a.y) * match.wall.unit.y;
      return {
        ...attached, delta: next, gap: distance(next, delta),
        matches: [{ ...match, kind: station >= 0 && station <= match.wall.length ? "wall" : "extension" }],
      };
    }
    return attached;
  }
  let chosen = [x, y].filter((item): item is Alignment => !!item);
  if (x && y && Math.hypot(x.gap, y.gap) > threshold) chosen = [better(x, y)];
  if (!chosen.length) return undefined;
  const next = copy(delta);
  for (const alignment of chosen) next[alignment.match.axis] = alignment.value;
  return {
    delta: next, gap: distance(delta, next), key: chosen.map(item => item.key).join("|"),
    matches: chosen.map(item => item.match),
  };
}

function wallGuide(wall: WallReference, target: Point, suffix: string): SnapGuide {
  return { id: `wall:${wall.id}:${suffix}`, kind: "wall", a: copy(wall.a), b: copy(wall.b), target: copy(target) };
}

function referenceGuide(source: Reference, target: Point, suffix: string, axis?: Axis): SnapGuide {
  const isPoint = distance(source.point, target) <= EPS;
  return {
    id: `${isPoint ? "point" : "alignment"}:${axis ?? "center"}:${source.id}:${suffix}`,
    kind: isPoint ? "point" : "alignment", a: copy(source.point), b: copy(target), target: copy(target),
  };
}

function matchGuides(candidate: Candidate): SnapGuide[] {
  return candidate.matches.flatMap(match => {
    const target = add(match.anchor.base, candidate.delta);
    if (match.kind === "point" || match.kind === "alignment") {
      return [referenceGuide(match.source, target, match.anchor.id, match.kind === "alignment" ? match.axis : undefined)];
    }
    const guide = wallGuide(match.wall, target, match.anchor.id);
    if (match.kind === "wall") return [guide];
    const { a, b, unit } = match.wall;
    const offset = (target.x - a.x) * unit.x + (target.y - a.y) * unit.y;
    return [guide, {
      id: `extension:${match.wall.id}:${match.anchor.id}`, kind: "extension",
      a: copy(offset < 0 ? a : b), b: copy(target), target: copy(target),
    }];
  });
}

function quantizedPoint(point: Point, grid: number, axis?: Axis): Point {
  return {
    x: axis === "y" ? point.x : quantize(point.x, grid),
    y: axis === "x" ? point.y : quantize(point.y, grid),
  };
}

function checkGuides(guides: SnapGuide[], bounded = true): void {
  const check = (point: Point) => {
    finite(point.x, "Snap guide X"); finite(point.y, "Snap guide Y");
    if (bounded) checkPoint(point, "Snap guide");
  };
  for (const guide of guides) {
    check(guide.a);
    check(guide.b);
    if (guide.target) check(guide.target);
  }
}

export function snapDraftPoint(
  plan: Plan, raw: Point, grid: number, threshold: number, origin?: Point, orthogonal = false,
): SnapResult {
  checkPoint(raw);
  checkSettings(grid, threshold);
  if (origin) checkPoint(origin, "Drawing origin");
  const target = orthogonal && origin ? constrainToAxis(raw, origin) : copy(raw);
  const axis = orthogonal && origin ? (target.y === origin.y ? "x" : "y") : undefined;
  let snapped: Candidate | undefined;
  if (threshold > 0) {
    const scene = sceneReferences(plan);
    if (origin) {
      const reference = { id: "origin", point: origin };
      scene.points.push(reference);
      scene.alignments.push(reference);
    }
    snapped = geometricSnap(scene, [{ id: "draft", base: zero, point: target }], target, threshold, grid, axis);
  }
  const point = snapped?.delta ?? quantizedPoint(target, grid, axis);
  checkPoint(point);
  const guides = snapped ? matchGuides(snapped) : [];
  if (threshold > 0 && axis && origin && distance(origin, point) > EPS) {
    guides.push({ id: `constraint:${axis}:draft`, kind: "constraint", a: copy(origin), b: copy(point) });
  }
  checkGuides(guides);
  return { point, guides };
}

export function snapTranslation(
  plan: Plan, nodeIds: readonly string[], delta: Point, grid: number, threshold: number, axis?: Axis,
): { delta: Point; guides: SnapGuide[] } {
  checkDelta(delta);
  checkSettings(grid, threshold);
  if (axis !== undefined && axis !== "x" && axis !== "y") throw new Error("Movement axis must be x or y.");
  const target = { x: axis === "y" ? 0 : delta.x, y: axis === "x" ? 0 : delta.y };
  const ids = new Set(nodeIds);
  const nodes = new Map(plan.nodes.map(node => [node.id, node]));
  const anchors = [...ids].map(id => {
    const base = nodes.get(id);
    if (!base) throw new Error(`The selected junction "${id}" no longer exists.`);
    checkPoint(base, "Junction position");
    const point = add(base, target);
    checkPoint(point, "Moved junction");
    return { id, base, point };
  });
  const snapped = threshold > 0 && anchors.length
    ? geometricSnap(sceneReferences(plan, ids), anchors, target, threshold, grid, axis) : undefined;
  const result = snapped?.delta ?? quantizedPoint(target, grid, axis);
  checkDelta(result);
  for (const anchor of anchors) checkPoint(add(anchor.base, result), "Moved junction");
  const guides = snapped ? matchGuides(snapped) : [];
  checkGuides(guides);
  return { delta: result, guides };
}

export function snapOpeningPosition(
  plan: Plan, wall: Wall, offset: number, grid: number, threshold: number, excludeOpeningIds: readonly string[] = [],
): { offset: number; point: Point; guides: SnapGuide[] } {
  checkOffset(offset);
  checkSettings(grid, threshold);
  const [a, b] = wallPoints(plan, wall);
  checkPoint(a, "Wall endpoint");
  checkPoint(b, "Wall endpoint");
  const length = distance(a, b);
  if (length < 1) throw new Error("Move the wall's endpoints apart before positioning an opening.");
  const unit = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const at = (value: number): Point => ({
    x: a.x + (b.x - a.x) * (value / length),
    y: a.y + (b.y - a.y) * (value / length),
  });
  const checkCenter = (point: Point) => {
    finite(point.x, "Opening center X"); finite(point.y, "Opening center Y");
  };
  checkCenter(at(offset));
  type OpeningCandidate = Ranked & { offset: number; source: Reference; axis?: Axis };
  let best: OpeningCandidate | undefined;
  const consider = (value: number, source: Reference, axis?: Axis) => {
    const gap = Math.abs(value - offset);
    if (gap <= threshold) best = better(best, { gap, key: `${source.id}:${axis ?? "center"}`, offset: value, source, axis });
  };
  const considerAlignment = (source: Reference) => {
    checkCenter(source.point);
    for (const axis of axes) {
      if (unit[axis] !== 0) consider((source.point[axis] - a[axis]) / unit[axis], source, axis);
    }
  };
  if (threshold > 0) {
    consider(length / 2, { id: `midpoint:${wall.id}`, point: at(length / 2) });
    if (!best) {
      consider(0, { id: `node:${wall.a}`, point: a });
      consider(length, { id: `node:${wall.b}`, point: b });
    }
    if (!best) {
      const excluded = new Set(excludeOpeningIds);
      const walls = new Map(plan.walls.map(item => [item.id, item]));
      for (const opening of plan.openings) {
        if (excluded.has(opening.id)) continue;
        const host = walls.get(opening.wallId);
        if (!host) continue;
        checkOffset(opening.offset);
        if (opening.wallId === wall.id) {
          const source = { id: `opening:${opening.id}`, point: at(opening.offset) };
          checkCenter(source.point);
          consider(opening.offset, source);
        } else {
          const [start, end] = wallPoints(plan, host);
          const hostLength = distance(start, end);
          if (hostLength < 1) continue;
          considerAlignment({
            id: `opening:${opening.id}`,
            point: {
              x: start.x + (end.x - start.x) / hostLength * opening.offset,
              y: start.y + (end.y - start.y) / hostLength * opening.offset,
            },
          });
        }
      }
      for (const node of plan.nodes) {
        if (node.id !== wall.a && node.id !== wall.b) considerAlignment({ id: `node:${node.id}`, point: node });
      }
    }
  }
  const result = best?.offset ?? quantize(offset, grid);
  checkOffset(result);
  const point = at(result);
  checkCenter(point);
  const guides: SnapGuide[] = best ? [
    wallGuide({ id: wall.id, a, b, length, unit }, point, "opening"),
    referenceGuide(best.source, point, "opening", best.axis),
  ] : [];
  checkGuides(guides, false);
  return { offset: result, point, guides };
}
