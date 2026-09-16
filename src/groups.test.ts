import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it, vi } from "vitest";
import {
  expandGroups, groupSelection, reconcileGroups, selectedGroups, ungroupSelection, validateGroups,
  type ElementGroup, type GroupMember,
} from "./groups";
import { addRoom, addWall, createEmptyPlan, deleteNode, deleteWall, detectRooms, splitWall, validatePlan, type Plan } from "./model";
import { makeProject, parseProject } from "./storage";

vi.mock("@excalidraw/excalidraw", () => ({
  restoreElements: (elements: ExcalidrawElement[]) => elements,
}));

const plan = (): Plan => validatePlan({
  version: 1,
  name: "Groups",
  units: "metric",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 4000, y: 0 },
    { id: "c", x: 4000, y: 3000 },
  ],
  walls: [
    { id: "first", a: "a", b: "b", thickness: 150, dimension: true },
    { id: "second", a: "b", b: "c", thickness: 150, dimension: false },
  ],
  openings: [
    { id: "door", wallId: "first", kind: "door", offset: 1500, width: 800, flip: false },
  ],
  angleDimensions: [
    { id: "angle", wallA: "first", wallB: "second", vertex: "b", radius: 500, clockwise: true },
  ],
  thicknessDimensions: [{ id: "thickness", wallId: "first", offset: 350 }],
  roomNames: {},
});

const note = (id: string, groupIds: string[] = []): ExcalidrawElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  angle: 0,
  strokeColor: "#000",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds,
  frameId: null,
  index: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
} as ExcalidrawElement);

const member = (kind: GroupMember["kind"], id: string): GroupMember => ({ kind, id } as GroupMember);

describe("element groups", () => {
  it("creates nested groups and expands selection to the outermost group", () => {
    const notes = [note("note-a")];
    const inner = groupSelection([], plan(), notes, [member("wall", "first"), member("note", "note-a")]);
    expect(inner).toHaveLength(1);
    expect(inner[0].id).toMatch(/^group-/);

    const nested = groupSelection(inner, plan(), notes, [member("note", "note-a"), member("node", "c")]);
    expect(nested).toHaveLength(2);
    expect(nested[1].members).toEqual([
      member("note", "note-a"), member("node", "c"), member("wall", "first"),
    ]);
    expect(expandGroups(nested, [member("wall", "first")])).toEqual([
      member("wall", "first"), member("note", "note-a"), member("node", "c"),
    ]);
    expect(selectedGroups(nested, nested[1].members)).toEqual([nested[1]]);
    expect(() => groupSelection(inner, plan(), notes, inner[0].members)).toThrow(/already a whole group/i);
  });

  it("ungroups only a wholly selected outer group and retains its inner group", () => {
    const groups: ElementGroup[] = [
      { id: "inner", members: [member("wall", "first"), member("note", "note-a")] },
      { id: "outer", members: [
        member("wall", "first"), member("note", "note-a"), member("node", "c"),
      ] },
    ];
    expect(ungroupSelection(groups, groups[1].members)).toEqual([groups[0]]);
    expect(() => ungroupSelection(groups, [member("wall", "first")])).toThrow(/every member/i);
  });

  it("strictly rejects malformed, missing, duplicate and partially overlapping metadata", () => {
    const notes = [note("note-a")];
    expect(() => validateGroups({ id: "not-an-array" }, plan(), notes)).toThrow(/array/i);
    expect(() => validateGroups([{ id: "bad", members: [
      member("wall", "first"), { kind: "mystery", id: "x" },
    ] }], plan(), notes)).toThrow(/invalid member kind/i);
    expect(() => validateGroups([{ id: "bad", members: [
      member("wall", "missing"), member("note", "note-a"),
    ] }], plan(), notes)).toThrow(/does not exist/i);
    expect(() => validateGroups([
      { id: "one", members: [member("wall", "first"), member("node", "a")] },
      { id: "two", members: [member("wall", "first"), member("node", "b")] },
    ], plan(), notes)).toThrow(/partially overlap/i);
    expect(() => validateGroups([
      { id: "same", members: [member("wall", "first"), member("node", "a")] },
      { id: "same", members: [member("wall", "second"), member("node", "c")] },
    ], plan(), notes)).toThrow(/duplicated/i);
  });

  it("drops deleted references and dissolves groups with fewer than two members", () => {
    const original = plan();
    const groups: ElementGroup[] = [{
      id: "group", members: [member("wall", "first"), member("note", "note-a")],
    }];
    expect(reconcileGroups(groups, deleteWall(original, "first"), [note("note-a")])).toEqual([]);
    expect(reconcileGroups(groups, original, [])).toEqual([]);
  });

  it("lets split walls inherit membership and maps joined walls to the survivor", () => {
    const original = plan();
    const groups: ElementGroup[] = [{
      id: "group", members: [member("wall", "first"), member("note", "note-a")],
    }];
    const split = splitWall(original, "first", 1800);
    const afterSplit = reconcileGroups(groups, split, [note("note-a")], original);
    expect(afterSplit[0].members).toEqual([
      member("wall", "first"), member("wall", split.walls[1].id), member("note", "note-a"),
    ]);

    const joined = deleteNode(split, split.nodes.at(-1)!.id);
    expect(reconcileGroups(afterSplit, joined, [note("note-a")], split)).toEqual(groups);

    const angledJoin = deleteNode(original, "b");
    const secondWallGroup: ElementGroup[] = [{
      id: "angled", members: [member("wall", "second"), member("note", "note-a")],
    }];
    expect(reconcileGroups(secondWallGroup, angledJoin, [note("note-a")], original)).toEqual([{
      id: "angled", members: [member("wall", "first"), member("note", "note-a")],
    }]);
  });

  it("normalizes a room to its stable boundary walls without treating one room as multiple selected objects", () => {
    const roomPlan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const room = member("room", detectRooms(roomPlan)[0].id);
    expect(() => groupSelection([], roomPlan, [], [room])).toThrow(/at least two/i);
    const grouped = groupSelection([], roomPlan, [note("label")], [room, member("note", "label")]);
    expect(grouped[0].members).toHaveLength(5);
    expect(grouped[0].members).toEqual(expect.arrayContaining([
      ...roomPlan.walls.map(wall => member("wall", wall.id)), member("note", "label"),
    ]));
    expect(validateGroups(grouped, roomPlan, [note("label")])).toEqual(grouped);
  });

  it("does not adopt unrelated overlapping walls on insertion or deletion", () => {
    const original = plan();
    const groups: ElementGroup[] = [{ id: "kept", members: [member("wall", "first"), member("note", "label")] }];
    const overlap = addWall(original, { x: -1000, y: 0 }, { x: 5000, y: 0 }, 150);
    expect(reconcileGroups(groups, overlap, [note("label")], original)).toEqual(groups);
    expect(reconcileGroups(groups, deleteWall(overlap, "first"), [note("label")], overlap)).toEqual([]);
  });

  it("keeps a legacy annotation container and its bound text together", () => {
    const bound = { ...note("bound"), type: "text", containerId: "container", text: "Label" } as ExcalidrawElement;
    const notes = [note("container"), bound];
    expect(() => groupSelection([], plan(), notes, [member("note", "container")])).toThrow(/at least two/i);
    const grouped = groupSelection([], plan(), notes, [member("note", "container"), member("wall", "first")]);
    expect(grouped[0].members).toEqual([
      member("note", "container"), member("note", "bound"), member("wall", "first"),
    ]);
  });

  it("enforces persistence limits when creating another group", () => {
    const notes = Array.from({ length: 2000 }, (_, index) => note(`note-${index}`));
    const groups: ElementGroup[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `g-${index}`, members: [member("note", `note-${index * 2}`), member("note", `note-${index * 2 + 1}`)],
    }));
    expect(() => groupSelection(groups, plan(), notes, [groups[0].members[0], member("wall", "first")])).toThrow(/at most 1000 groups/i);
    expect(() => validateGroups([{ id: "large", members: Array.from({ length: 10001 }, () => member("wall", "first")) }],
      plan(), [])).toThrow(/10000 members/i);
  });
});

describe("group persistence", () => {
  it("omits empty metadata for version-1 compatibility and retains validated groups", () => {
    expect(Object.hasOwn(makeProject(plan(), []), "groups")).toBe(false);
    const groups: ElementGroup[] = [{
      id: "kept", members: [member("wall", "first"), member("note", "note-a")],
    }];
    const parsed = parseProject(JSON.stringify(makeProject(plan(), [note("note-a")], groups)));
    expect(parsed.groups).toEqual(groups);
    expect(parsed.sketches[0].groupIds).toEqual([]);
  });

  it("imports nested native note groups and clears Excalidraw group IDs", () => {
    const legacy = makeProject(plan(), [
      note("note-a", ["inner", "outer"]),
      note("note-b", ["inner", "outer"]),
      note("note-c", ["outer"]),
    ]);
    const parsed = parseProject(JSON.stringify(legacy));
    expect(parsed.groups).toEqual([
      { id: "group-inner", members: [member("note", "note-a"), member("note", "note-b")] },
      { id: "group-outer", members: [
        member("note", "note-a"), member("note", "note-b"), member("note", "note-c"),
      ] },
    ]);
    expect(parsed.sketches.every(item => item.groupIds.length === 0)).toBe(true);
  });

  it("rejects malformed persisted groups rather than silently dropping them", () => {
    const project = { ...makeProject(plan(), [note("note-a")]), groups: [{
      id: "bad", members: [member("wall", "first"), member("note", "missing")],
    }] };
    expect(() => parseProject(JSON.stringify(project))).toThrow(/does not exist/i);
  });

  it("deduplicates legacy group levels and remaps old identifiers without losing notes", () => {
    const id = "legacy:group with spaces";
    const legacy = makeProject(plan(), [note("a", [id, "outer"]), note("b", [id, "outer"])]);
    const parsed = parseProject(JSON.stringify(legacy));
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups![0].id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(parsed.groups![0].members).toEqual([member("note", "a"), member("note", "b")]);
    expect(parsed.sketches).toHaveLength(2);
    expect(parsed.sketches.every(note => note.groupIds.length === 0)).toBe(true);
  });

  it("does not duplicate explicitly supplied groups or retain deleted legacy members", () => {
    const groups: ElementGroup[] = [{ id: "preferred", members: [member("note", "a"), member("note", "b")] }];
    const project = makeProject(plan(), [note("a", ["old"]), note("b", ["old"])], groups);
    expect(parseProject(JSON.stringify(project)).groups).toEqual(groups);
    const deleted = { ...note("b", ["old"]), isDeleted: true };
    expect(parseProject(JSON.stringify(makeProject(plan(), [note("a", ["old"]), deleted]))).groups).toBeUndefined();
  });
});
