import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { detectRooms, type Plan, type Point, type Wall } from "./model";
import type { SelectionItem as PlanSelectionItem } from "./selection";

export type GroupMember = PlanSelectionItem | { kind: "note"; id: string };
export type ElementGroup = { id: string; members: GroupMember[] };

const MAX_GROUPS = 1_000;
const MAX_GROUP_MEMBERS = 10_000;
const MAX_ID_LENGTH = 256;
const MEMBER_KINDS = new Set<string>([
  "wall", "node", "door", "window", "dimension", "angle", "room", "thickness", "note",
]);
const isMemberKind = (value: unknown): value is GroupMember["kind"] => typeof value === "string" && MEMBER_KINDS.has(value);

const memberKey = (member: GroupMember) => `${member.kind}:${member.id}`;
const memberSet = (members: readonly GroupMember[]) => new Set(members.map(memberKey));
const contains = (outer: ReadonlySet<string>, inner: ReadonlySet<string>) =>
  [...inner].every(key => outer.has(key));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && contains(a, b);

function uniqueMembers(items: readonly GroupMember[]): GroupMember[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = memberKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => ({ ...item }));
}

export function planMembers(items: readonly GroupMember[]): PlanSelectionItem[] {
  return items.filter((item): item is PlanSelectionItem => item.kind !== "note");
}

export function noteMemberIds(items: readonly GroupMember[]): string[] {
  return items.filter(item => item.kind === "note").map(item => item.id);
}

function outermostGroups(groups: readonly ElementGroup[]): ElementGroup[] {
  const sets = groups.map(group => memberSet(group.members));
  return groups.filter((_, index) => !sets.some((candidate, other) =>
    other !== index && candidate.size > sets[index]!.size && contains(candidate, sets[index]!)));
}

export function expandGroups(
  groups: readonly ElementGroup[],
  items: readonly GroupMember[],
): GroupMember[] {
  const result = uniqueMembers(items);
  const selected = memberSet(result);
  for (const group of outermostGroups(groups)) {
    if (group.members.some(member => selected.has(memberKey(member)))) result.push(...group.members);
  }
  return uniqueMembers(result);
}

export function selectedGroups(
  groups: readonly ElementGroup[],
  items: readonly GroupMember[],
): ElementGroup[] {
  const selected = memberSet(items);
  const complete = groups.filter(group => contains(selected, memberSet(group.members)));
  return outermostGroups(complete);
}

function roomWalls(plan: Plan, roomId: string): GroupMember[] {
  const room = detectRooms(plan).find(candidate => candidate.id === roomId);
  if (!room) throw new Error(`The selected room "${roomId}" no longer exists.`);
  const result: GroupMember[] = [];
  for (let index = 0; index < room.nodeIds.length; index++) {
    const a = room.nodeIds[index]!;
    const b = room.nodeIds[(index + 1) % room.nodeIds.length]!;
    const wall = plan.walls.find(candidate =>
      candidate.a === a && candidate.b === b || candidate.a === b && candidate.b === a);
    if (!wall) throw new Error(`The selected room "${roomId}" has a missing boundary wall.`);
    result.push({ kind: "wall", id: wall.id });
  }
  return uniqueMembers(result);
}

function normalizeSelection(plan: Plan, notes: readonly ExcalidrawElement[], items: readonly GroupMember[]) {
  const bundles = items.map(item => item.kind === "room" ? roomWalls(plan, item.id)
    : item.kind === "note" ? [item, ...notes.filter(note => note.type === "text" && note.containerId === item.id)
      .map(note => ({ kind: "note" as const, id: note.id }))] : [{ ...item }]);
  return { bundles, members: uniqueMembers(bundles.flat()) };
}

function validNoteIds(notes: readonly ExcalidrawElement[]): Set<string> {
  return new Set(notes.filter(note => !note.isDeleted).map(note => note.id));
}

function memberExists(member: GroupMember, plan: Plan, notes: ReadonlySet<string>): boolean {
  let exists = false;
  switch (member.kind) {
    case "note": exists = notes.has(member.id); break;
    case "wall": exists = plan.walls.some(wall => wall.id === member.id); break;
    case "node": exists = plan.nodes.some(node => node.id === member.id); break;
    case "door":
    case "window":
      exists = plan.openings.some(opening => opening.id === member.id && opening.kind === member.kind);
      break;
    case "dimension": exists = plan.walls.some(wall => wall.id === member.id && wall.dimension); break;
    case "angle": exists = (plan.angleDimensions ?? []).some(angle => angle.id === member.id); break;
    case "thickness":
      exists = (plan.thicknessDimensions ?? []).some(dimension => dimension.id === member.id);
      break;
    case "room": exists = detectRooms(plan).some(room => room.id === member.id); break;
  }
  return exists;
}

function assertMemberExists(member: GroupMember, plan: Plan, notes: ReadonlySet<string>): void {
  if (!memberExists(member, plan, notes)) throw new Error(`Group member ${member.kind} "${member.id}" does not exist.`);
}

export function groupSelection(
  groups: readonly ElementGroup[],
  plan: Plan,
  notes: readonly ExcalidrawElement[],
  items: readonly GroupMember[],
): ElementGroup[] {
  validateGroups(groups, plan, notes);
  if (!items.length) throw new Error("Select at least two elements or groups to create a group.");
  const noteIds = validNoteIds(notes);
  for (const item of items) assertMemberExists(item, plan, noteIds);

  const { bundles, members } = normalizeSelection(plan, notes, items);
  const expanded = expandGroups(groups, members);
  const expandedSet = memberSet(expanded);
  if (groups.some(group => sameSet(memberSet(group.members), expandedSet))) {
    throw new Error("The selection is already a whole group.");
  }

  const outer = outermostGroups(groups);
  const logicalUnits = new Set<string>();
  bundles.forEach((bundle, bundleIndex) => {
    const touched = outer.filter(group => {
      const keys = memberSet(group.members);
      return bundle.some(member => keys.has(memberKey(member)));
    });
    touched.forEach(group => logicalUnits.add(`group:${group.id}`));
    const covered = new Set(touched.flatMap(group => group.members.map(memberKey)));
    if (bundle.some(member => !covered.has(memberKey(member)))) {
      logicalUnits.add(bundle.length > 1 ? `bundle:${bundleIndex}` : `member:${memberKey(bundle[0]!)}`);
    }
  });
  if (logicalUnits.size < 2) {
    throw new Error("Select at least two elements or groups to create a group.");
  }

  return validateGroups([...groups.map(group => ({ ...group, members: uniqueMembers(group.members) })), {
    id: `group-${crypto.randomUUID()}`,
    members: expanded,
  }], plan, notes);
}

export function ungroupSelection(
  groups: readonly ElementGroup[],
  items: readonly GroupMember[],
): ElementGroup[] {
  const selected = selectedGroups(groups, items);
  if (!selected.length) throw new Error("Select every member of a group before ungrouping it.");
  const removed = new Set(selected.map(group => group.id));
  return groups.filter(group => !removed.has(group.id))
    .map(group => ({ ...group, members: uniqueMembers(group.members) }));
}

const pointOnSegment = (point: Point, wall: Wall, plan: Plan): boolean => {
  const a = plan.nodes.find(node => node.id === wall.a);
  const b = plan.nodes.find(node => node.id === wall.b);
  if (!a || !b) return false;
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y) <= 1e-6;
  const cross = Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx);
  if (cross > 1e-6 * Math.sqrt(lengthSquared)) return false;
  const projection = (point.x - a.x) * dx + (point.y - a.y) * dy;
  return projection >= -1e-6 && projection <= lengthSquared + 1e-6;
};

function wallEndpointsOn(source: Wall, sourcePlan: Plan, target: Wall, targetPlan: Plan): boolean {
  const a = sourcePlan.nodes.find(node => node.id === source.a);
  const b = sourcePlan.nodes.find(node => node.id === source.b);
  return !!a && !!b && pointOnSegment(a, target, targetPlan) && pointOnSegment(b, target, targetPlan);
}

function joinedWallReplacement(removed: Wall, current: Wall, previousPlan: Plan): boolean {
  const previousSurvivor = previousPlan.walls.find(wall => wall.id === current.id);
  if (!previousSurvivor || previousSurvivor.id === removed.id) return false;
  const shared = [removed.a, removed.b].filter(id =>
    id === previousSurvivor.a || id === previousSurvivor.b);
  if (shared.length !== 1) return false;
  const removedOuter = removed.a === shared[0] ? removed.b : removed.a;
  const survivorOuter = previousSurvivor.a === shared[0] ? previousSurvivor.b : previousSurvivor.a;
  return current.a === removedOuter && current.b === survivorOuter
    || current.a === survivorOuter && current.b === removedOuter;
}

function wallReplacements(wallId: string, plan: Plan, previousPlan?: Plan): string[] {
  if (!previousPlan) return plan.walls.some(wall => wall.id === wallId) ? [wallId] : [];
  const previous = previousPlan.walls.find(wall => wall.id === wallId);
  if (!previous) return plan.walls.some(wall => wall.id === wallId) ? [wallId] : [];
  const previousIds = new Set(previousPlan.walls.map(wall => wall.id));
  const result: string[] = [];
  const survivor = plan.walls.find(wall => wall.id === wallId);
  if (survivor) result.push(survivor.id);
  for (const wall of plan.walls) {
    if (result.includes(wall.id)) continue;
    const splitChild = !!survivor && (survivor.a !== previous.a || survivor.b !== previous.b)
      && !previousIds.has(wall.id) && wallEndpointsOn(wall, plan, previous, previousPlan);
    const joinedSurvivor = !survivor && joinedWallReplacement(previous, wall, previousPlan);
    if (splitChild || joinedSurvivor) result.push(wall.id);
  }
  return result;
}

function reconcileOverlaps(groups: ElementGroup[]): ElementGroup[] {
  let result = groups;
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let first = 0; first < result.length; first++) {
      const a = memberSet(result[first]!.members);
      for (let second = first + 1; second < result.length; second++) {
        const b = memberSet(result[second]!.members);
        if (sameSet(a, b)) {
          result = result.filter((_, index) => index !== second);
          changed = true;
          break outer;
        }
        const intersects = [...a].some(key => b.has(key));
        if (intersects && !contains(a, b) && !contains(b, a)) {
          result = result.map((group, index) => index === first
            ? { ...group, members: uniqueMembers([...group.members, ...result[second]!.members]) }
            : group).filter((_, index) => index !== second);
          changed = true;
          break outer;
        }
      }
    }
  }
  return result;
}

export function reconcileGroups(
  groups: readonly ElementGroup[],
  plan: Plan,
  notes: readonly ExcalidrawElement[],
  previousPlan?: Plan,
): ElementGroup[] {
  const noteIds = validNoteIds(notes);
  const reconciled = groups.flatMap(group => {
    const members = uniqueMembers(group.members.flatMap(member => {
      if (member.kind === "wall") {
        return wallReplacements(member.id, plan, previousPlan).map(id => ({ kind: "wall" as const, id }));
      }
      return memberExists(member, plan, noteIds) ? [{ ...member }] : [];
    }));
    return members.length >= 2 ? [{ id: group.id, members }] : [];
  });
  return reconcileOverlaps(reconciled);
}

function assertGroupId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new Error(`${label} must be a valid identifier containing 1 to 80 letters, numbers, hyphens, or underscores.`);
  }
}

function assertMemberId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string no longer than ${MAX_ID_LENGTH} characters.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateGroups(
  value: unknown,
  plan: Plan,
  notes: readonly ExcalidrawElement[],
): ElementGroup[] {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) {
    throw new Error(`Project groups must be an array containing at most ${MAX_GROUPS} groups.`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error("Project groups cannot contain missing list entries.");
  }
  const noteIds = validNoteIds(notes);
  const groupIds = new Set<string>();
  let totalMembers = 0;
  const groups = value.map((candidate, groupIndex): ElementGroup => {
    if (!isPlainObject(candidate)
      || Object.keys(candidate).some(key => key !== "id" && key !== "members")
      || !Object.hasOwn(candidate, "id") || !Object.hasOwn(candidate, "members")) {
      throw new Error(`Group ${groupIndex + 1} must contain only an id and members.`);
    }
    const record = candidate;
    assertGroupId(record.id, `Group ${groupIndex + 1} ID`);
    if (groupIds.has(record.id)) throw new Error(`Group ID "${record.id}" is duplicated.`);
    groupIds.add(record.id);
    if (!Array.isArray(record.members) || record.members.length < 2) {
      throw new Error(`Group "${record.id}" must contain at least two members.`);
    }
    for (let memberIndex = 0; memberIndex < record.members.length; memberIndex++) {
      if (!Object.hasOwn(record.members, memberIndex)) {
        throw new Error(`Group "${record.id}" cannot contain missing member entries.`);
      }
    }
    totalMembers += record.members.length;
    if (totalMembers > MAX_GROUP_MEMBERS) {
      throw new Error(`Project groups may contain at most ${MAX_GROUP_MEMBERS} members in total.`);
    }
    const seen = new Set<string>();
    const members = record.members.map((candidateMember, memberIndex): GroupMember => {
      if (!isPlainObject(candidateMember)
        || Object.keys(candidateMember).some(key => key !== "kind" && key !== "id")
        || !Object.hasOwn(candidateMember, "kind") || !Object.hasOwn(candidateMember, "id")) {
        throw new Error(`Member ${memberIndex + 1} of group "${record.id}" must contain only a kind and id.`);
      }
      const member = candidateMember;
      if (!isMemberKind(member.kind)) {
        throw new Error(`Group "${record.id}" contains an invalid member kind.`);
      }
      assertMemberId(member.id, `Member ${memberIndex + 1} ID in group "${record.id}"`);
      const typed: GroupMember = { kind: member.kind, id: member.id };
      const key = memberKey(typed);
      if (seen.has(key)) throw new Error(`Group "${record.id}" contains duplicate member ${key}.`);
      seen.add(key);
      assertMemberExists(typed, plan, noteIds);
      return typed;
    });
    return { id: record.id, members };
  });

  const sets = groups.map(group => memberSet(group.members));
  for (let first = 0; first < groups.length; first++) {
    for (let second = first + 1; second < groups.length; second++) {
      const a = sets[first]!, b = sets[second]!;
      if (sameSet(a, b)) {
        throw new Error(`Groups "${groups[first]!.id}" and "${groups[second]!.id}" have duplicate member sets.`);
      }
      if ([...a].some(key => b.has(key)) && !contains(a, b) && !contains(b, a)) {
        throw new Error(`Groups "${groups[first]!.id}" and "${groups[second]!.id}" partially overlap.`);
      }
    }
  }
  return groups;
}
