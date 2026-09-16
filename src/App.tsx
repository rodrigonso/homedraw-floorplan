import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import DrawingCanvas, { CaptureUpdateAction, exportDrawing, getSceneVersion, getCommonBounds, isEditableTarget, newElementWith, textInteractionClip, type CanvasApi, type CanvasElement, type CanvasState } from "./DrawingCanvas";
import NotesControls from "./NotesControls";
import { DeleteButton, GroupActions } from "./SelectionActions";
import {
  ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, DoorOpen, DraftingCompass, Grid2X2,
  Hand, House, Magnet, Maximize, Menu, Minus, MousePointer2, PanelLeftClose, Pencil,
  Plus, Redo2, Ruler, Save, Scan, Settings2, Square, Type, Undo2, X,
} from "lucide-react";
import {
  addAngleDimension, addOpening, addRoom, addThicknessDimension, addWall, angleVertex, createDemoPlan, createEmptyPlan,
  constrainToAxis, detectRooms, distance, formatArea, formatLength, formatLengthInput, getGeometryIssues, getLengthUnit, isWallDegenerate, mergeNodes, moveNode, moveWall, parseAngle, parseLength, resizeAngle, resizeWall, setDimensionOffset, setLengthUnit, setWallThickness, splitWall, toggleDimension, updateAngleDimension, updateThicknessDimension, wallPoints,
  type Opening, type Plan, type Point,
} from "./model";
import { createPlanRenderer, hitTest, isPlanElement, nearestWall, planToElements, SCALE, type Selection } from "./scene";
import { downloadFile, errorMessage, loadInitialProject, makeProject, parseProject, STORAGE_KEY, SUPPORTED_NOTE_TYPES } from "./storage";
import Properties, { LengthField } from "./Properties";
import InlineDimensionEditor from "./InlineDimensionEditor";
import { dimensionPosition, draggedDimensionOffset, thicknessDimensionPosition } from "./dimensions";
import { angleDimensionAt, anglePosition, formatAngleInput, hasAngleGeometry } from "./angles";
import { createFrameScheduler } from "./frameScheduler";
import { geometryHighlights, openingPoints } from "./geometryFeedback";
import EditorPopover from "./EditorPopover";
import { deleteSelection, getMarqueeSelection, getSelectionNodeIds, moveSelection, selectionBounds, type SelectionBounds } from "./selection";
import { expandGroups, groupSelection, ungroupSelection, selectedGroups, reconcileGroups, validateGroups, planMembers, noteMemberIds,
  type GroupMember as SelectionItem, type ElementGroup } from "./groups";
import { snapDraftPoint, snapOpeningPosition, snapTranslation, type SnapGuide } from "./snapGuides";

type Tool = "select" | "wall" | "room" | "door" | "window" | "dimension" | "angle" | "text" | "notes" | "hand";
const canvasTool = (tool: Tool) => tool === "text" ? "text" : tool === "notes" ? "freedraw" : "selection";
const tools = [
  { id: "select", label: "Select", key: "V", icon: MousePointer2 },
  { id: "wall", label: "Wall", key: "W", icon: Minus },
  { id: "room", label: "Room", key: "R", icon: Square },
  { id: "door", label: "Door", key: "D", icon: DoorOpen },
  { id: "window", label: "Window", key: "N", icon: PanelLeftClose },
  { id: "dimension", label: "Dimension", key: "M", icon: Ruler },
  { id: "angle", label: "Angle", key: "A", icon: DraftingCompass },
] satisfies { id: Tool; label: string; key: string; icon: typeof Minus }[];
const hints: Record<Tool, string> = {
  select: "Drag empty canvas to select. Shift-click toggles items; hold Shift while moving to lock an axis.",
  wall: "Click a start point, then an endpoint. Hold Shift for horizontal or vertical walls. Esc to finish.",
  room: "Click two opposite corners to draw a measured room.",
  door: "Click a wall to place a door. Select it to change its width or swing.",
  window: "Click a wall to place a window. Select it to adjust its position.",
  dimension: "Click a wall to add or remove a dimension. Drag its label or line to reposition it.",
  angle: "Click the first wall, then a connected wall, then click to place the angle measurement. Esc cancels.",
  text: "Click anywhere and type. Click away to finish; use Select to move text or double-click to edit it.",
  notes: "Add renovation notes, drawing marks, and arrows. Notes do not change measured geometry.",
  hand: "Drag to pan. Hold Shift to lock an axis. Use the mouse wheel to zoom.",
};
type SingleGeometryDrag = {
  kind: "wall" | "node" | "angle"; id: string; start: Point; current: Point; preview: Plan; error: string | null;
  mergeTarget?: string; hasMoved?: boolean;
};
type GroupDrag = {
  kind: "group"; items: SelectionItem[]; start: Point; current: Point; base: Plan; preview: Plan; error: string | null; delta: Point;
  baseNotes: readonly CanvasElement[]; previewNotes: readonly CanvasElement[];
};
type SelectionPress = { item: SelectionItem; initial: SelectionItem[]; items: SelectionItem[]; toggle?: SelectionItem[]; started: boolean };
type Snapshot = { plan: Plan; notes: readonly CanvasElement[]; groups: readonly ElementGroup[] };
const noteContent = (notes: readonly CanvasElement[]) => JSON.stringify(notes.map(({ version, versionNonce, updated, index, ...note }) => note));
type GeometryDrag = (SingleGeometryDrag | GroupDrag) & { press?: SelectionPress; guides?: SnapGuide[] };
type DimensionDrag = {
  kind: "dimension"; id: string; start: Point; axis: Point; initialOffset: number; offset: number; press?: SelectionPress;
  measurement?: "thickness";
  guides?: SnapGuide[];
};
type ItemDrag = GeometryDrag | DimensionDrag;
type PointerSample = { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean };
type MarqueeDrag = {
  kind: "marquee"; start: Point; current: Point; initial: SelectionItem[]; additive: boolean; click: Selection;
};
type Drag =
  | { kind: "pan"; client: Point; scrollX: number; scrollY: number }
  | DimensionDrag
  | MarqueeDrag
  | GeometryDrag;
const HISTORY_LIMIT = 100;
const ANGLE_PREVIEW_ID = "preview:angle";
const isGeometryDrag = (movement: Drag | null): movement is GeometryDrag =>
  movement?.kind === "wall" || movement?.kind === "node" || movement?.kind === "angle" || movement?.kind === "group";
const selectionKey = (item: SelectionItem) => `${item.kind}:${item.id}`;
const noteSelectionSignature = (ids: readonly string[]) => JSON.stringify([...ids].sort());
const addSelections = (initial: SelectionItem[], added: SelectionItem[]) =>
  [...new Map([...initial, ...added].map(item => [selectionKey(item), item])).values()];
const toggleSelection = (items: SelectionItem[], item: SelectionItem) =>
  items.some(selected => selectionKey(selected) === selectionKey(item))
    ? items.filter(selected => selectionKey(selected) !== selectionKey(item)) : [...items, item];
const toggleSelections = (items: SelectionItem[], toggled: SelectionItem[]) =>
  toggled.every(item => items.some(selected => selectionKey(selected) === selectionKey(item)))
    ? items.filter(item => !toggled.some(toggled => selectionKey(item) === selectionKey(toggled))) : addSelections(items, toggled);
const noteBounds = (elements: readonly CanvasElement[]): SelectionBounds | null => {
  if (!elements.length) return null;
  const [left, top, right, bottom] = getCommonBounds(elements);
  return { x: left / SCALE, y: top / SCALE, width: (right - left) / SCALE, height: (bottom - top) / SCALE };
};
function editorBounds(plan: Plan, notes: readonly CanvasElement[], items: readonly SelectionItem[], dimensions: boolean): SelectionBounds | null {
  const ids = new Set(noteMemberIds(items));
  const bounds = [selectionBounds(plan, planMembers(items), dimensions), noteBounds(notes.filter(note => ids.has(note.id)))]
    .filter((bounds): bounds is SelectionBounds => !!bounds);
  if (!bounds.length) return null;
  const x = Math.min(...bounds.map(bounds => bounds.x)), y = Math.min(...bounds.map(bounds => bounds.y));
  return { x, y, width: Math.max(...bounds.map(bounds => bounds.x + bounds.width)) - x,
    height: Math.max(...bounds.map(bounds => bounds.y + bounds.height)) - y };
}
function movedNotes(notes: readonly CanvasElement[], items: readonly SelectionItem[], delta: Point) {
  if (!delta.x && !delta.y) return notes;
  const ids = new Set(noteMemberIds(items));
  return ids.size ? notes.map(note => ids.has(note.id)
    ? newElementWith(note, { x: note.x + delta.x * SCALE, y: note.y + delta.y * SCALE }) : note) : notes;
}
function membersAt(plan: Plan, groups: readonly ElementGroup[], item: SelectionItem): SelectionItem[] {
  const direct = expandGroups(groups, [item]);
  if (direct.length > 1) return direct;
  let wallIds: string[] = [];
  if (item.kind === "node") wallIds = plan.walls.filter(wall => wall.a === item.id || wall.b === item.id).map(wall => wall.id);
  else if (item.kind === "dimension") wallIds = [item.id];
  else if (item.kind === "door" || item.kind === "window") wallIds = plan.openings.filter(opening => opening.id === item.id).map(opening => opening.wallId);
  else if (item.kind === "thickness") wallIds = (plan.thicknessDimensions ?? []).filter(dimension => dimension.id === item.id).map(dimension => dimension.wallId);
  else if (item.kind === "angle") wallIds = (plan.angleDimensions ?? []).filter(angle => angle.id === item.id).flatMap(angle => [angle.wallA, angle.wallB]);
  else if (item.kind === "room") {
    const nodes = new Set(getSelectionNodeIds(plan, [item]));
    wallIds = plan.walls.filter(wall => nodes.has(wall.a) && nodes.has(wall.b)).map(wall => wall.id);
  }
  const matching = [...groups].sort((a, b) => b.members.length - a.members.length).find(group => {
    const contains = (id: string) => group.members.some(member => member.kind === "wall" && member.id === id);
    return wallIds.length > 0 && (item.kind === "room" ? wallIds.every(contains) : wallIds.some(contains));
  });
  return matching?.members ?? [item];
}
const nativeNoteSelection = (groups: readonly ElementGroup[], items: readonly SelectionItem[]) => {
  const ids = noteMemberIds(items);
  return ids.length === items.length && !selectedGroups(groups, items).length ? ids : [];
};
const sameGuides = (a: readonly SnapGuide[] = [], b: readonly SnapGuide[] = []) =>
  a.length === b.length && a.every((guide, i) => {
    const other = b[i];
    return guide.id === other.id && guide.kind === other.kind
      && guide.a.x === other.a.x && guide.a.y === other.a.y && guide.b.x === other.b.x && guide.b.y === other.b.y
      && guide.target?.x === other.target?.x && guide.target?.y === other.target?.y;
  });

function marqueeItems(plan: Plan, notes: readonly CanvasElement[], groups: readonly ElementGroup[], movement: MarqueeDrag, zoom: number, showDimensions: boolean) {
  if (distance(movement.start, movement.current) * SCALE * zoom <= 3) {
    const clicked = movement.click ? membersAt(plan, groups, movement.click) : [];
    return movement.additive ? toggleSelections(movement.initial, clicked) : clicked;
  }
  const contains = (bounds: SelectionBounds | null) => !!bounds
    && bounds.x >= Math.min(movement.start.x, movement.current.x) && bounds.y >= Math.min(movement.start.y, movement.current.y)
    && bounds.x + bounds.width <= Math.max(movement.start.x, movement.current.x)
    && bounds.y + bounds.height <= Math.max(movement.start.y, movement.current.y);
  let items: SelectionItem[] = [...getMarqueeSelection(plan, movement.start, movement.current, showDimensions),
    ...notes.filter(note => contains(noteBounds([note]))).map(note => ({ kind: "note" as const, id: note.id }))];
  items = items.filter(item => membersAt(plan, groups, item).length === 1);
  for (const group of selectedGroups(groups, groups.flatMap(group => group.members))) {
    const keys = new Set(group.members.map(selectionKey));
    items = items.filter(item => !keys.has(selectionKey(item)));
    if (contains(editorBounds(plan, notes, group.members, showDimensions))) items = addSelections(items, group.members);
  }
  return movement.additive ? addSelections(movement.initial, items) : items;
}

export default function App() {
  const [initial] = useState(() => {
    const loaded = loadInitialProject();
    return { ...loaded, snapshot: {
      plan: loaded.project.plan, notes: structuredClone(loaded.project.sketches), groups: loaded.project.groups ?? [],
    } satisfies Snapshot };
  });
  const [plan, setPlan] = useState(initial.project.plan);
  const planRef = useRef(plan);
  const [notes, setNotes] = useState<readonly CanvasElement[]>(initial.project.sketches);
  const notesRef = useRef(notes);
  const notesVersionRef = useRef(getSceneVersion(notes));
  const [groups, setGroups] = useState<readonly ElementGroup[]>(initial.snapshot.groups);
  const groupsRef = useRef(groups);
  const committed = useRef<Snapshot>(initial.snapshot);
  const pendingNotes = useRef(false);
  const syncingProject = useRef(false);
  const nativeSelectionBase = useRef<SelectionItem[]>([]);
  const nativeIndividual = useRef(false);
  const enteredMember = useRef<string | null>(null);
  const nativeSelectionKey = useRef(noteSelectionSignature([]));
  // Core state updates are asynchronous; intermediate selection echoes are not new user selections.
  const expectedNativeSelection = useRef<string | null>(null);
  const [api, setApi] = useState<CanvasApi | null>(null);
  const apiRef = useRef(api);
  const [tool, setTool] = useState<Tool>("select");
  const toolRef = useRef(tool);
  const editingTextRef = useRef(false);
  const [selectedItems, setSelectedItemsState] = useState<SelectionItem[]>([]);
  const selectionRef = useRef(selectedItems);
  const setSelectedItems = useCallback((update: SetStateAction<SelectionItem[]>) => {
    const next = typeof update === "function" ? update(selectionRef.current) : update;
    if (next.length === selectionRef.current.length
      && next.every((item, index) => selectionKey(item) === selectionKey(selectionRef.current[index]))) return;
    if (next.length !== 1 || selectionKey(next[0]) !== enteredMember.current) enteredMember.current = null;
    selectionRef.current = next;
    setSelectedItemsState(next);
  }, []);
  const clearNoteSelection = useCallback(() => {
    const current = apiRef.current;
    if (current && notesRef.current.some(note => current.getAppState().selectedElementIds[note.id])) {
      nativeSelectionKey.current = noteSelectionSignature([]);
      expectedNativeSelection.current = nativeSelectionKey.current;
      current.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }, []);
  const setSelection = useCallback((item: Selection) => {
    if (item) clearNoteSelection();
    setSelectedItems(item ? [item] : []);
  }, [clearNoteSelection]);
  const [editingDimension, setEditingDimension] = useState<{ kind: "wall" | "angle" | "thickness"; id: string } | null>(null);
  const [measurementType, setMeasurementType] = useState<"length" | "thickness">("length");
  const [origin, setOrigin] = useState<Point | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [angleDraft, setAngleDraft] = useState<{ wallA: string; wallB?: string } | null>(null);
  const [previewFrame] = useState(createFrameScheduler);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const lastPointer = useRef<PointerSample | null>(null);
  const [draftGuides, setDraftGuides] = useState<SnapGuide[]>([]);
  const [placement, setPlacement] = useState<Opening | null>(null);
  const clearGuides = useCallback(() => {
    setDraftGuides(current => current.length ? [] : current);
    setPlacement(null);
  }, []);
  const showGuides = (guides: SnapGuide[]) => setDraftGuides(current => sameGuides(current, guides) ? current : guides);
  const setDrag = useCallback((next: Drag | null) => {
    previewFrame.cancel();
    dragRef.current = next;
    setDragState(next);
    if (!next) clearGuides();
  }, [previewFrame, clearGuides]);
  useEffect(() => previewFrame.cancel, [previewFrame]);
  const dimensionWasDragged = useRef(false);
  const angleWasDragged = useRef(false);
  const wallWasDragged = useRef(false);
  const pointerTarget = useRef<"wall" | "node" | "annotation" | null>(null);
  const [view, setView] = useState({ scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 });
  const [snap, setSnap] = useState(true);
  const [orthogonal, setOrthogonal] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showDimensions, setShowDimensions] = useState(true);
  const [thickness, setThickness] = useState(150);
  const [doorWidth, setDoorWidth] = useState(900);
  const [windowWidth, setWindowWidth] = useState(1200);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const pastRef = useRef(past), futureRef = useRef(future);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(
    initial.error ? { text: initial.error, error: true } : null,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(initial.error ? "error" : "saved");
  const [savedSnapshot, setSavedSnapshot] = useState<{ plan: Plan; notes: readonly CanvasElement[]; groups: readonly ElementGroup[] } | null>(null);
  const [savePaused, setSavePaused] = useState(!!initial.error);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingNew, setPendingNew] = useState(false);
  const [exporting, setExporting] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialized = useRef<CanvasApi | null>(null);
  const geometryDrag = isGeometryDrag(drag) ? drag : null;
  const draggedItems = drag?.kind === "group" ? drag.items : null;
  const movedNodeIds = useMemo(() => draggedItems ? getSelectionNodeIds(plan, planMembers(draggedItems))
    : drag?.kind === "wall" ? plan.walls.filter(wall => wall.id === drag.id).flatMap(wall => [wall.a, wall.b]) : [],
  [plan, draggedItems, drag?.kind, drag && "id" in drag ? drag.id : null]);
  const activeGuides = snap ? drag ? "guides" in drag ? drag.guides ?? [] : [] : draftGuides : [];
  const displayPlan = geometryDrag?.preview ?? plan;
  const displayNotes = drag?.kind === "group" ? drag.previewNotes : notes;
  const visibleSelection = useMemo(() => drag?.kind === "marquee"
    ? marqueeItems(plan, notes, groups, drag, view.zoom, showDimensions)
    : drag && "press" in drag && drag.press ? drag.press.started ? drag.press.items : drag.press.initial
    : selectedItems, [drag, plan, notes, groups, selectedItems, view.zoom, showDimensions]);
  const selection = visibleSelection.length === 1 && visibleSelection[0].kind !== "note" ? visibleSelection[0] : null;
  const selectedKeys = useMemo(() => new Set(visibleSelection.map(selectionKey)), [visibleSelection]);
  const selectedWallIds = useMemo(() => new Set(visibleSelection.filter(item => item.kind === "wall").map(item => item.id)), [visibleSelection]);
  const selectedNodeIds = useMemo(() => new Set(visibleSelection.filter(item => item.kind === "node").map(item => item.id)), [visibleSelection]);
  const selectedWallNodeIds = useMemo(() => new Set(displayPlan.walls.filter(wall => selectedWallIds.has(wall.id))
    .flatMap(wall => [wall.a, wall.b])), [displayPlan, selectedWallIds]);
  const groupBounds = useMemo(() => visibleSelection.length > 1 ? editorBounds(displayPlan, displayNotes, visibleSelection, showDimensions) : null,
    [displayPlan, displayNotes, visibleSelection, showDimensions]);
  const geometryIssues = useMemo(() => getGeometryIssues(displayPlan), [displayPlan]);
  const drawingFeedback = useMemo(() => {
    if (!origin || !pointer || !["wall", "room"].includes(tool) || distance(origin, pointer) < 1e-6) return null;
    try {
      return { plan: tool === "room" ? addRoom(plan, origin, pointer, thickness)
        : addWall(plan, origin, pointer, thickness), error: null };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { plan: null, error: error.message };
    }
  }, [plan, tool, origin, pointer, thickness]);
  const feedbackPlan = drawingFeedback?.plan ?? displayPlan;
  const feedbackIssues = useMemo(() => drawingFeedback?.plan
    ? getGeometryIssues(drawingFeedback.plan) : geometryIssues, [drawingFeedback, geometryIssues]);
  const highlights = useMemo(() => geometryHighlights(feedbackPlan, feedbackIssues), [feedbackPlan, feedbackIssues]);
  const drawingInvalid = !!drawingFeedback?.error || !!drawingFeedback?.plan && feedbackIssues.some(issue =>
    issue.wallIds.some(id => !plan.walls.some(wall => wall.id === id)));
  const nodeDragId = drag?.kind === "node" ? drag.id : null;
  const nodeSnapPlan = useMemo(() => nodeDragId ? {
    ...plan, nodes: plan.nodes.filter(node => node.id !== nodeDragId),
    walls: plan.walls.filter(wall => wall.a !== nodeDragId && wall.b !== nodeDragId),
  } : plan, [plan, nodeDragId]);
  const nodeMergeTarget = geometryDrag?.kind === "node"
    ? plan.nodes.find(node => node.id === geometryDrag.mergeTarget) : undefined;
  const dimensionPreview = drag?.kind === "dimension" ? drag : undefined;
  const propertyPlan = useMemo(() => dimensionPreview?.measurement === "thickness" && displayPlan.thicknessDimensions
    ? { ...displayPlan, thicknessDimensions: displayPlan.thicknessDimensions.map(dimension =>
      dimension.id === dimensionPreview.id ? { ...dimension, offset: dimensionPreview.offset } : dimension) }
    : dimensionPreview?.measurement !== "thickness" && dimensionPreview
      ? { ...displayPlan, walls: displayPlan.walls.map(wall => wall.id === dimensionPreview.id
        ? { ...wall, dimensionOffset: dimensionPreview.offset } : wall) }
      : displayPlan, [displayPlan, dimensionPreview]);
  const renderPlan = useMemo(() => angleDraft?.wallB && pointer
    && hasAngleGeometry(displayPlan, { wallA: angleDraft.wallA, wallB: angleDraft.wallB }) ? {
    ...displayPlan, angleDimensions: [...(displayPlan.angleDimensions ?? []), {
      ...angleDimensionAt(displayPlan, angleDraft.wallA, angleDraft.wallB, pointer), id: ANGLE_PREVIEW_ID,
    }],
  } : displayPlan, [displayPlan, angleDraft, pointer]);
  const [sceneRenderer] = useState(createPlanRenderer);
  const [fontRevision, setFontRevision] = useState(0);
  useEffect(() => {
    const refresh = () => { sceneRenderer.clear(); setFontRevision(revision => revision + 1); };
    document.fonts.addEventListener("loadingdone", refresh);
    return () => document.fonts.removeEventListener("loadingdone", refresh);
  }, [sceneRenderer]);
  const geometry = useMemo(() => sceneRenderer.render(renderPlan, showDimensions, dimensionPreview, geometryIssues),
    [sceneRenderer, renderPlan, showDimensions, dimensionPreview, geometryIssues, fontRevision]);
  const dimensionLabels = useMemo(() => geometry.filter(element => element.type === "text")
    .filter(element => element.id.startsWith("plan-dim-label-") || element.id.startsWith("plan-warning-length-")), [geometry]);
  const thicknessLabels = useMemo(() => geometry.filter(element => element.type === "text")
    .filter(element => element.id.startsWith("plan-thickness-label-")), [geometry]);
  const angleLabels = useMemo(() => geometry.filter(element => element.type === "text")
    .filter(element => element.id.startsWith("plan-angle-label-") || element.id.startsWith("plan-warning-angle-label-")), [geometry]);
  const [initialElements] = useState(() => [...geometry, ...initial.project.sketches]);
  const geometryRef = useRef(geometry);
  const rooms = useMemo(() => detectRooms(displayPlan, geometryIssues), [displayPlan, geometryIssues]);

  const notify = useCallback((text: string, error = false) => setMessage({ text, error }), []);
  const unsupportedNotes = useCallback((message: string) => notify(message, true), [notify]);
  const applySnapshot = useCallback((snapshot: Snapshot, liveNotes = structuredClone(snapshot.notes)) => {
    committed.current = snapshot;
    pendingNotes.current = false;
    planRef.current = snapshot.plan;
    notesRef.current = liveNotes;
    notesVersionRef.current = getSceneVersion(liveNotes);
    groupsRef.current = snapshot.groups;
    setPlan(snapshot.plan);
    setNotes(liveNotes);
    setGroups(snapshot.groups);
  }, []);
  const commitEditor = useCallback((change: (current: Snapshot) => Snapshot) => {
    previewFrame.cancel();
    try {
      const current = { plan: planRef.current, notes: notesRef.current, groups: groupsRef.current };
      let next = change(current);
      if (next.notes.some(note => note.groupIds.length)) {
        const imported = parseProject(JSON.stringify(makeProject(next.plan, next.notes, next.groups)));
        next = { ...next, notes: imported.sketches, groups: imported.groups ?? [] };
      }
      setEditError(null);
      const nextGroups = validateGroups(reconcileGroups(next.groups, next.plan, next.notes, current.plan), next.plan, next.notes);
      pendingNotes.current = false;
      if (next.plan === committed.current.plan && noteContent(next.notes) === noteContent(committed.current.notes)
        && JSON.stringify(nextGroups) === JSON.stringify(committed.current.groups)) return true;
      const snapshot: Snapshot = { plan: next.plan, notes: structuredClone(next.notes), groups: nextGroups };
      if (next.notes !== current.notes) syncingProject.current = true;
      pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), committed.current];
      futureRef.current = [];
      setPast(pastRef.current);
      setFuture(futureRef.current);
      applySnapshot(snapshot, next.notes);
      setAngleDraft(null);
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setEditError(error.message);
      return false;
    }
  }, [applySnapshot, previewFrame]);
  const commit = useCallback((change: (current: Plan) => Plan) =>
    commitEditor(current => ({ ...current, plan: change(current.plan) })), [commitEditor]);

  const chooseTool = useCallback((next: Tool) => {
    lastPointer.current = null;
    toolRef.current = next;
    if (apiRef.current && apiRef.current.getAppState().activeTool.type !== canvasTool(next)) {
      apiRef.current.setActiveTool({ type: canvasTool(next) });
    }
    if (next === "notes" || next === "text") {
      setSelection(null);
    }
    setTool(next);
    setOrigin(null);
    setDrag(null);
    setPointer(null);
    setEditingDimension(null);
    setAngleDraft(null);
    setEditError(null);
  }, [setDrag, setSelection]);

  const chooseShortcut = useCallback((key: string) => {
    if (toolRef.current === "notes") return false;
    const lower = key.toLowerCase();
    const shortcut = tools.find(tool => tool.key.toLowerCase() === lower)?.id
      ?? (lower === "t" ? "text" : lower === "h" ? "hand" : lower === "s" ? "notes" : undefined);
    if (!shortcut) return false;
    chooseTool(shortcut);
    return true;
  }, [chooseTool]);

  const restoreSnapshot = useCallback((snapshot: Snapshot) => {
    syncingProject.current = true;
    applySnapshot(snapshot);
    nativeSelectionKey.current = noteSelectionSignature([]);
    clearNoteSelection();
    setSelection(null);
    setOrigin(null);
    setEditingDimension(null);
    setDrag(null);
    setAngleDraft(null);
    setEditError(null);
  }, [applySnapshot, clearNoteSelection, setDrag, setSelection]);
  const runHistory = useCallback((forward: boolean) => {
    const source = forward ? futureRef : pastRef;
    const target = forward ? pastRef : futureRef;
    const next = forward ? source.current[0] : source.current.at(-1);
    if (!next) return;
    source.current = forward ? source.current.slice(1) : source.current.slice(0, -1);
    target.current = forward ? [...target.current, committed.current] : [committed.current, ...target.current];
    setPast(pastRef.current);
    setFuture(futureRef.current);
    restoreSnapshot(next);
  }, [restoreSnapshot]);

  useEffect(() => {
    if (!api) return;
    apiRef.current = api;
    geometryRef.current = geometry;
    notesVersionRef.current = getSceneVersion(displayNotes);
    const ids = nativeNoteSelection(groups, selectedItems);
    const state = api.getAppState();
    const selected = Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id]);
    const key = noteSelectionSignature(ids);
    const selectionChanged = noteSelectionSignature(selected) !== key || Object.keys(state.selectedGroupIds).length > 0 || state.editingGroupId !== null;
    nativeSelectionKey.current = key;
    expectedNativeSelection.current = selectionChanged ? key : null;
    syncingProject.current = true;
    api.updateScene({ elements: [...geometry, ...displayNotes],
      ...(selectionChanged ? { appState: {
        selectedElementIds: Object.fromEntries(ids.map(id => [id, true])), selectedGroupIds: {}, editingGroupId: null,
      } } : {}),
      captureUpdate: CaptureUpdateAction.NEVER });
    syncingProject.current = false;
    if (initialized.current !== api) {
      initialized.current = api;
      requestAnimationFrame(() => api.scrollToContent([...geometry, ...notesRef.current], {
        fitToViewport: true, viewportZoomFactor: 0.72, maxZoom: 1.1, animate: false,
      }));
    }
  }, [api, geometry, displayNotes, groups, selectedItems]);

  useEffect(() => {
    if (!api) return;
    if (api.getAppState().activeTool.type !== canvasTool(tool)) api.setActiveTool({ type: canvasTool(tool) });
    if (!["select", "notes", "text"].includes(tool)) {
      api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }, [api, tool]);

  useEffect(() => {
    if (savePaused) return;
    setSaveState("saving");
    const timer = setTimeout(() => {
      try {
        const snapshot = committed.current;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(makeProject(snapshot.plan, snapshot.notes, snapshot.groups)));
        setSavedSnapshot({ plan, notes, groups });
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        notify(`Could not save on this device: ${errorMessage(error)} Download your project to keep your work.`, true);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [plan, notes, groups, savePaused, notify]);

  // Flush the debounce when leaving so the latest small edits are not lost.
  useEffect(() => {
    const flush = () => {
      if (savePaused) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(makeProject(planRef.current, notesRef.current, groupsRef.current)));
        setSavedSnapshot({ plan: planRef.current, notes: notesRef.current, groups: groupsRef.current });
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        notify(`Could not save: ${errorMessage(error)} Download your project before closing.`, true);
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [notify, savePaused]);

  useEffect(() => {
    if (!message || message.error) return;
    const timer = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!showHelp && !pendingNew) return;
    const onModalKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHelp(false);
        setPendingNew(false);
      }
      if (event.key === "Tab") {
        const focusable = document.querySelectorAll<HTMLButtonElement>(".modal button:not(:disabled)");
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onModalKey);
    return () => window.removeEventListener("keydown", onModalKey);
  }, [showHelp, pendingNew]);

  const onSceneChange = useCallback((elements: readonly CanvasElement[], state: CanvasState) => {
    setView(current => current.scrollX === state.scrollX && current.scrollY === state.scrollY
      && current.zoom === state.zoom.value && current.width === state.width && current.height === state.height ? current
      : { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value, width: state.width, height: state.height });
    // Old canvas data must not overwrite a project snapshot while it is being applied.
    if (syncingProject.current) return;
    const unsupported = elements.some(e => !isPlanElement(e) && !e.isDeleted && !SUPPORTED_NOTE_TYPES.has(e.type));
    const notes = elements.filter(e => !isPlanElement(e) && !e.isDeleted && SUPPORTED_NOTE_TYPES.has(e.type));
    const selected = notes.filter(element => state.selectedElementIds[element.id]).map(element => element.id);
    const selectionSignature = noteSelectionSignature(selected);
    if (expectedNativeSelection.current !== null) {
      if (expectedNativeSelection.current === selectionSignature) {
        nativeSelectionKey.current = selectionSignature;
        expectedNativeSelection.current = null;
      }
    } else if (nativeSelectionKey.current !== selectionSignature) {
      nativeSelectionKey.current = selectionSignature;
      if (!dragRef.current) {
        const items: SelectionItem[] = selected.map(id => ({ kind: "note", id }));
        const combined = addSelections(nativeSelectionBase.current, items);
        setSelectedItems(nativeIndividual.current ? combined : expandGroups(groupsRef.current, combined));
      }
    }
    if (editingTextRef.current && !state.editingTextElement && toolRef.current === "text") {
      queueMicrotask(() => { if (toolRef.current === "text") chooseTool("select"); });
    } else if (toolRef.current === "text" && !state.editingTextElement && state.activeTool.type !== "text") {
      queueMicrotask(() => {
        if (toolRef.current === "text" && apiRef.current?.getAppState().activeTool.type !== "text") {
          apiRef.current?.setActiveTool({ type: "text" });
        }
      });
    }
    editingTextRef.current = !!state.editingTextElement;
    if (unsupported) notify("Renovation notes support text, arrows, and drawing marks, not images, frames, or embedded content.", true);
    // Measured geometry is owned by the plan, never by annotation edits.
    const measured = elements.filter(e => isPlanElement(e) && !e.isDeleted);
    if (apiRef.current && initialized.current === apiRef.current
      && (unsupported || measured.length !== geometryRef.current.length || measured.some((element, i) => {
        const source = geometryRef.current[i];
        return !source || element.id !== source.id || !element.locked
          || element.x !== source.x || element.y !== source.y || element.width !== source.width
          || element.height !== source.height || element.angle !== source.angle;
      }))) {
      queueMicrotask(() => apiRef.current?.updateScene({
        elements: [...geometryRef.current, ...notesRef.current], captureUpdate: CaptureUpdateAction.NEVER,
      }));
    }
    // The engine mutates elements in place, so retain the previous numeric version separately.
    const notesVersion = getSceneVersion(notes);
    if (notesVersion !== notesVersionRef.current
      || notes.map(e => e.id).join() !== notesRef.current.map(e => e.id).join()) {
      notesRef.current = notes;
      notesVersionRef.current = notesVersion;
      pendingNotes.current = true;
      setNotes(notes);
    }
    if (pendingNotes.current && state.cursorButton === "up" && !state.editingTextElement && !state.newElement
      && !state.multiElement && !state.isResizing && !state.isRotating && !dragRef.current) {
      const adoptedGroup = notes.some(note => note.groupIds.length);
      if (commitEditor(current => ({ ...current, notes })) && adoptedGroup) {
        queueMicrotask(() => {
          chooseTool("select");
          setSelectedItems(expandGroups(groupsRef.current, selected.map(id => ({ kind: "note", id }))));
        });
      }
    }
  }, [notify, chooseTool, setSelectedItems, commitEditor]);

  const saveProject = useCallback(() => {
    const current = planRef.current;
    downloadFile(JSON.stringify(makeProject(current, notesRef.current, groupsRef.current), null, 2), "application/json",
      `${current.name.replace(/[<>:"/\\|?*]/g, "-") || "My floor plan"}.homedraw.json`);
    notify("Project downloaded, including renovation notes.");
  }, [notify]);

  const removeItems = useCallback((items: readonly SelectionItem[]) => {
    setDrag(null);
    setEditingDimension(null);
    const ids = new Set(noteMemberIds(items));
    if (commitEditor(current => ({ ...current, plan: deleteSelection(current.plan, planMembers(items)),
      notes: current.notes.filter(note => !ids.has(note.id)) }))) {
      setSelection(null);
      setOrigin(null);
      setAngleDraft(null);
    }
  }, [commitEditor, setDrag, setSelection]);
  const removeSelected = useCallback(() => removeItems(visibleSelection), [removeItems, visibleSelection]);

  const addThickness = (wallId: string, offset?: number) => {
    setDrag(null);
    let dimensionId = "";
    if (commit(current => {
      const next = addThicknessDimension(current, wallId, offset);
      dimensionId = next.thicknessDimensions!.at(-1)!.id;
      return next;
    })) {
      chooseTool("select");
      setShowDimensions(true);
      setSelection({ kind: "thickness", id: dimensionId });
    }
  };

  const changeGrouping = useCallback((ungroup: boolean) => {
    const items = selectionRef.current;
    let members = items;
    if (commitEditor(current => {
      const next = ungroup ? ungroupSelection(current.groups, items) : groupSelection(current.groups, current.plan, current.notes, items);
      if (!ungroup) {
        const created = next.find(group => !current.groups.some(previous => previous.id === group.id));
        if (created) members = created.members;
      }
      return { ...current, groups: next };
    })) {
      chooseTool("select");
      setSelectedItems(expandGroups(groupsRef.current, members));
    }
  }, [chooseTool, commitEditor, setSelectedItems]);
  const selectAll = useCallback(() => {
    const notesOnly = toolRef.current === "notes";
    const items = expandGroups(groupsRef.current, [
      ...(notesOnly ? [] : planRef.current.walls.map(wall => ({ kind: "wall" as const, id: wall.id }))),
      ...notesRef.current.map(note => ({ kind: "note" as const, id: note.id })),
    ]);
    if (!notesOnly || selectedGroups(groupsRef.current, items).length) chooseTool("select");
    setSelectedItems(items);
  }, [chooseTool, setSelectedItems]);

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return false;
    const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
    if (command && key === "s" && !showHelp && !pendingNew) {
      event.preventDefault();
      saveProject();
      return true;
    }
    if (isEditableTarget(event.target) || showHelp || pendingNew) return false;
    if (command && ["z", "y"].includes(key)) {
      event.preventDefault();
      runHistory(event.shiftKey || key === "y");
      return true;
    }
    if (command && key === "g") {
      event.preventDefault();
      changeGrouping(event.shiftKey);
      return true;
    }
    if (key === "escape" && tool !== "notes") {
      event.preventDefault();
      if (dragRef.current?.kind === "marquee") { setDrag(null); return true; }
      chooseTool("select");
      setSelection(null);
      return true;
    }
    if (command && key === "a") {
      event.preventDefault();
      selectAll();
      return true;
    }
    if (!command && !event.altKey) {
      if (chooseShortcut(key)) { event.preventDefault(); return true; }
      if (["delete", "backspace"].includes(key) && visibleSelection.length) {
        event.preventDefault();
        if (selection?.kind === "room") { setDrag(null); setEditingDimension(null); setSelection(null); }
        else removeSelected();
        return true;
      }
    }
    return false;
  }, [chooseTool, chooseShortcut, changeGrouping, selectAll, pendingNew, runHistory, removeSelected, saveProject, selection, setDrag, setSelection, showHelp, tool, visibleSelection]);
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const fit = () => api?.scrollToContent([...geometryRef.current, ...notesRef.current], {
    fitToViewport: true, viewportZoomFactor: 0.72, maxZoom: 1.5, animate: false,
  });
  const zoom = (factor: number, at?: Point) => {
    if (!api || !stage.current) return;
    const state = api.getAppState();
    const next = Math.min(3, Math.max(0.2, state.zoom.value * factor));
    const center = at ?? { x: stage.current.clientWidth / 2, y: stage.current.clientHeight / 2 };
    api.updateScene({ appState: {
      zoom: { value: next as CanvasState["zoom"]["value"] },
      scrollX: state.scrollX + center.x / next - center.x / state.zoom.value,
      scrollY: state.scrollY + center.y / next - center.y / state.zoom.value,
    }, captureUpdate: CaptureUpdateAction.NEVER });
  };
  const toWorld = useCallback((event: { clientX: number; clientY: number }): Point => {
    const bounds = stage.current!.getBoundingClientRect();
    const state = apiRef.current!.getAppState();
    return {
      x: ((event.clientX - bounds.left) / state.zoom.value - state.scrollX) / SCALE,
      y: ((event.clientY - bounds.top) / state.zoom.value - state.scrollY) / SCALE,
    };
  }, []);
  const snapped = (point: Point, altKey: boolean, shiftKey: boolean) => snapDraftPoint(
    plan, point, snap && !altKey ? 50 : 0, snap && !altKey ? 12 / (SCALE * view.zoom) : 0,
    tool === "wall" ? origin ?? undefined : undefined,
    tool === "wall" && (orthogonal || shiftKey),
  );
  const draftPoint = (point: Point, altKey: boolean, shiftKey: boolean, preview = true) => {
    try {
      const next = snapped(point, altKey, shiftKey);
      setEditError(null);
      if (preview) showGuides(next.guides);
      return next.point;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setEditError(error.message);
      clearGuides();
      return null;
    }
  };
  const screen = (point: Point) => ({
    x: (point.x * SCALE + view.scrollX) * view.zoom,
    y: (point.y * SCALE + view.scrollY) * view.zoom,
  });
  const deltaFor = (start: Point, current: Point, altKey: boolean, shiftKey: boolean) => {
    const position = shiftKey ? constrainToAxis(current, start) : current;
    const delta = { x: position.x - start.x, y: position.y - start.y };
    return snap && !altKey ? { x: Math.round(delta.x / 50) * 50, y: Math.round(delta.y / 50) * 50 } : delta;
  };
  const geometryDragAt = (movement: GeometryDrag, current: Point, altKey: boolean, shiftKey: boolean): GeometryDrag => {
    const nearStart = distance(movement.start, current) * SCALE * view.zoom <= 3;
    const enabled = snap && !altKey;
    const movingIds = movement.kind === "group" && movement.items !== draggedItems
      ? getSelectionNodeIds(plan, planMembers(movement.items))
      : movement.kind === "wall" && (drag?.kind !== "wall" || movement.id !== drag.id)
        ? plan.walls.filter(wall => wall.id === movement.id).flatMap(wall => [wall.a, wall.b]) : movedNodeIds;
    const translate = () => {
      const delta = { x: current.x - movement.start.x, y: current.y - movement.start.y };
      return snapTranslation(plan, movingIds, delta, enabled ? 50 : 0, enabled ? 10 / (SCALE * view.zoom) : 0,
        shiftKey ? Math.abs(delta.x) >= Math.abs(delta.y) ? "x" : "y" : undefined);
    };
    if (movement.kind === "group") {
      if (nearStart) return { ...movement, current, delta: { x: 0, y: 0 }, base: plan, preview: plan,
        previewNotes: movement.baseNotes, error: null, guides: [] };
      try {
        let delta: Point, guides: SnapGuide[] = [];
        if (movingIds.length) {
          ({ delta, guides } = translate());
        } else if (movement.items.length === 1 && ["door", "window"].includes(movement.items[0].kind)) {
          const opening = plan.openings.find(opening => opening.id === movement.items[0].id)!;
          const wall = plan.walls.find(wall => wall.id === opening.wallId)!;
          const [a, b] = wallPoints(plan, wall), length = distance(a, b);
          if (length < 1) throw new Error("Move the wall's junctions apart before moving its opening.");
          const axis = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
          const rawOffset = draggedDimensionOffset(opening.offset, axis, movement.start, current);
          const result = snapOpeningPosition(plan, wall, rawOffset, enabled ? 50 : 0, enabled ? 10 / (SCALE * view.zoom) : 0, [opening.id]);
          delta = { x: axis.x * (result.offset - opening.offset), y: axis.y * (result.offset - opening.offset) };
          guides = result.guides;
        } else {
          delta = deltaFor(movement.start, current, altKey || !planMembers(movement.items).length,
            shiftKey && noteMemberIds(movement.items).length > 0);
        }
        if (delta.x === 0 && delta.y === 0) return { ...movement, current, delta, base: plan, preview: plan,
          previewNotes: movement.baseNotes, error: null, guides };
        if (movement.base === plan && delta.x === movement.delta.x && delta.y === movement.delta.y) return { ...movement, current, error: null, guides };
        return { ...movement, current, delta, base: plan, preview: moveSelection(plan, planMembers(movement.items), delta),
          previewNotes: movedNotes(movement.baseNotes, movement.items, delta), error: null, guides };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { ...movement, current, error: error.message, guides: [] };
      }
    }
    const next = { ...movement, current, hasMoved: movement.hasMoved || !nearStart };
    if (nearStart && (movement.kind !== "node" || !next.hasMoved)) {
      return { ...next, preview: plan, error: null, mergeTarget: undefined, guides: [] };
    }
    try {
      if (movement.kind === "angle") {
        const angle = plan.angleDimensions!.find(angle => angle.id === movement.id)!;
        const { axis } = anglePosition(plan, angle);
        const offset = draggedDimensionOffset(angle.radius, axis, movement.start, current);
        const radius = Math.abs(offset - angle.radius) * SCALE * view.zoom <= 3 ? angle.radius : Math.max(100, offset);
        const position = anglePosition(plan, { ...angle, radius });
        const guides: SnapGuide[] = enabled
          ? [{ id: `angle:${angle.id}`, kind: "constraint", a: position.vertex, b: position.label }] : [];
        if (radius === movement.preview.angleDimensions!.find(angle => angle.id === movement.id)!.radius) {
          return { ...next, error: null, guides };
        }
        return { ...next, preview: updateAngleDimension(plan, angle.id, { radius }), error: null, guides };
      }
      if (movement.kind === "node") {
        const node = plan.nodes.find(node => node.id === movement.id)!;
        const target = { x: node.x + current.x - movement.start.x, y: node.y + current.y - movement.start.y };
        const { point: position, guides } = snapDraftPoint(nodeSnapPlan, target, enabled ? 50 : 0,
          enabled ? 10 / (SCALE * view.zoom) : 0, shiftKey ? node : undefined, shiftKey);
        let mergeTarget: string | undefined;
        if (snap && !altKey) for (const candidate of nodeSnapPlan.nodes) {
          if (distance(candidate, position) <= 1e-6) mergeTarget = candidate.id;
        }
        if (nearStart && !mergeTarget) return { ...next, preview: plan, error: null, mergeTarget: undefined, guides: [] };
        const previous = movement.preview.nodes.find(node => node.id === movement.id)!;
        if (position.x === previous.x && position.y === previous.y) return { ...next, error: null, mergeTarget, guides };
        return { ...next, preview: moveNode(plan, movement.id, position), error: null, mergeTarget, guides };
      }
      const { delta, guides } = translate();
      if (delta.x === 0 && delta.y === 0) return { ...next, preview: plan, error: null, guides };
      const wall = plan.walls.find(wall => wall.id === movement.id)!;
      const start = plan.nodes.find(node => node.id === wall.a)!;
      const previous = movement.preview.nodes.find(node => node.id === wall.a)!;
      if (start.x + delta.x === previous.x && start.y + delta.y === previous.y) return { ...next, error: null, guides };
      return { ...next, preview: moveWall(plan, movement.id, delta), error: null, guides };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Only malformed or out-of-range input is blocked; spatial conflicts remain editable.
      return { ...next, error: error.message, mergeTarget: undefined, guides: [] };
    }
  };
  const rememberPointer = ({ clientX, clientY, altKey, shiftKey }: PointerSample) => {
    const sample = { clientX, clientY, altKey, shiftKey };
    lastPointer.current = sample;
    return sample;
  };
  const startItemDrag = (event: ReactPointerEvent<SVGElement>, movement: ItemDrag, item?: SelectionItem,
    items = item ? [item] : visibleSelection, toggled?: SelectionItem[]) => {
    clearNoteSelection();
    rememberPointer(event);
    setEditingDimension(null);
    setEditError(null);
    const press = event.shiftKey && tool === "select" && item
      ? { item, initial: selectedItems, items, toggle: toggled, started: false } : undefined;
    if (!press) setSelectedItems(items);
    setDrag({ ...movement, press });
  };
  const activatePress = (movement: ItemDrag, point: Point): ItemDrag => {
    if (!movement.press || movement.press.started || distance(movement.start, point) * SCALE * view.zoom <= 3) return movement;
    return { ...movement, press: { ...movement.press, started: true } };
  };
  const startGroupDrag = (event: ReactPointerEvent<SVGElement>, items = visibleSelection, item?: SelectionItem, toggled?: SelectionItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement!;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointerTarget.current = null;
    wallWasDragged.current = dimensionWasDragged.current = angleWasDragged.current = true;
    const start = toWorld(event);
    startItemDrag(event, { kind: "group", items, start, current: start, base: plan, preview: plan,
      baseNotes: notesRef.current, previewNotes: notesRef.current, error: null, delta: { x: 0, y: 0 } }, item, items, toggled);
  };
  const startGroupedItem = (event: ReactPointerEvent<SVGElement>, item: SelectionItem) => {
    if (event.ctrlKey || event.metaKey) { enteredMember.current = selectionKey(item); return false; }
    if (enteredMember.current === selectionKey(item)) return false;
    const members = membersAt(plan, groups, item);
    if (members.length <= 1) return false;
    const included = members.every(member => selectedKeys.has(selectionKey(member)));
    const items = event.shiftKey ? addSelections(visibleSelection, members) : included ? visibleSelection : members;
    startGroupDrag(event, items, item, members);
    return true;
  };
  const startNodeDrag = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    if (!api || event.button !== 0) return;
    if (startGroupedItem(event, { kind: "node", id: nodeId })) return;
    if (!event.ctrlKey && !event.metaKey && visibleSelection.length > 1 && (selectedNodeIds.has(nodeId) || selectedWallNodeIds.has(nodeId))) {
      startGroupDrag(event, visibleSelection, { kind: "node", id: nodeId }); return;
    }
    pointerTarget.current = "node";
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.ownerSVGElement!;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const start = toWorld(event);
    startItemDrag(event, { kind: "node", id: nodeId, start, current: start, preview: plan, error: null }, { kind: "node", id: nodeId });
  };
  const startDimensionDrag = (event: ReactPointerEvent<SVGElement>, id: string, measurement?: "thickness") => {
    if (event.button !== 0 || !api) return;
    const thickness = measurement === "thickness" ? plan.thicknessDimensions!.find(dimension => dimension.id === id) : undefined;
    const wall = plan.walls.find(w => w.id === (thickness?.wallId ?? id))!;
    const item: SelectionItem = { kind: measurement === "thickness" ? "thickness" : "dimension", id };
    if (startGroupedItem(event, item)) return;
    if (!event.ctrlKey && !event.metaKey && tool === "select" && visibleSelection.length > 1 && (selectedWallIds.has(wall.id) || selectedKeys.has(selectionKey(item)))) {
      startGroupDrag(event, visibleSelection, item); return;
    }
    pointerTarget.current = "annotation";
    event.stopPropagation();
    const canvas = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement!;
    canvas.focus({ preventScroll: true });
    dimensionWasDragged.current = false;
    if (isWallDegenerate(plan, wall)) {
      setDrag(null);
      if (event.shiftKey) setSelectedItems(current => toggleSelection(current, item)); else setSelection(item);
      setEditError("Move the wall's junctions apart before repositioning this measurement.");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const { axis, offset } = thickness ? thicknessDimensionPosition(plan, thickness) : dimensionPosition(plan, wall);
    startItemDrag(event, { kind: "dimension", id, measurement, start: toWorld(event), axis, initialOffset: offset, offset }, item);
  };
  const startAngleDrag = (event: ReactPointerEvent<SVGElement>, angleId: string) => {
    if (!api || event.button !== 0) return;
    if (startGroupedItem(event, { kind: "angle", id: angleId })) return;
    const angle = plan.angleDimensions!.find(angle => angle.id === angleId)!;
    if (!event.ctrlKey && !event.metaKey && visibleSelection.length > 1 && (selectedKeys.has(`angle:${angleId}`)
      || selectedWallIds.has(angle.wallA) || selectedWallIds.has(angle.wallB))) {
      startGroupDrag(event, visibleSelection, { kind: "angle", id: angleId }); return;
    }
    pointerTarget.current = "annotation";
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.ownerSVGElement!;
    canvas.focus({ preventScroll: true });
    if (!hasAngleGeometry(plan, angle)) {
      setDrag(null);
      setEditError(null);
      const item: SelectionItem = { kind: "angle", id: angleId };
      if (event.shiftKey) setSelectedItems(current => toggleSelection(current, item)); else setSelection(item);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    angleWasDragged.current = false;
    const start = toWorld(event);
    startItemDrag(event, { kind: "angle", id: angleId, start, current: start, preview: plan, error: null }, { kind: "angle", id: angleId });
  };
  const dimensionOffsetAt = (movement: Extract<Drag, { kind: "dimension" }>, point: Point) => {
    const offset = draggedDimensionOffset(movement.initialOffset, movement.axis, movement.start, point);
    return Math.abs(offset - movement.initialOffset) * SCALE * view.zoom > 3 ? offset : movement.initialOffset;
  };
  const dimensionGuides = (movement: DimensionDrag, offset: number, altKey: boolean): SnapGuide[] => {
    if (!snap || altKey || offset === movement.initialOffset) return [];
    const dimension = movement.measurement === "thickness"
      ? plan.thicknessDimensions!.find(dimension => dimension.id === movement.id) : undefined;
    const wall = plan.walls.find(wall => wall.id === (dimension?.wallId ?? movement.id))!;
    const at = (offset: number) => dimension ? thicknessDimensionPosition(plan, { ...dimension, offset }).label
      : dimensionPosition(plan, { ...wall, dimensionOffset: offset }).label;
    return [{ id: `dimension:${movement.id}`, kind: "constraint", a: at(movement.initialOffset), b: at(offset) }];
  };
  const placementAt = (raw: Point, altKey: boolean) => {
    const hit = nearestWall(plan, raw, 18 / (SCALE * view.zoom));
    if (!hit) return null;
    const enabled = snap && !altKey;
    if (tool === "dimension" && measurementType === "length") {
      const [a, b] = wallPoints(plan, hit.wall);
      const guides: SnapGuide[] = enabled && !isWallDegenerate(plan, hit.wall)
        ? [{ id: `wall:${hit.wall.id}`, kind: "wall", a, b, target: hit.point }] : [];
      return { wall: hit.wall, offset: hit.offset, point: hit.point, guides };
    }
    return { wall: hit.wall, ...snapOpeningPosition(plan, hit.wall, hit.offset,
      enabled ? 50 : 0, enabled ? 10 / (SCALE * view.zoom) : 0) };
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!api || (event.button !== 0 && event.button !== 1)) return;
    clearNoteSelection();
    rememberPointer(event);
    pointerTarget.current = null;
    setEditError(null);
    if (tool === "angle") {
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "hand" || event.button === 1) {
      const state = api.getAppState();
      setDrag({ kind: "pan", client: { x: event.clientX, y: event.clientY }, scrollX: state.scrollX, scrollY: state.scrollY });
    } else if (tool === "select") {
      event.currentTarget.focus({ preventScroll: true });
      const point = toWorld(event);
      const hit = hitTest(plan, point, 12 / (SCALE * view.zoom), showDimensions);
      if (hit && startGroupedItem(event, hit)) return;
      const padding = 8 / (SCALE * view.zoom);
      const inGroup = groupBounds && point.x >= groupBounds.x - padding && point.x <= groupBounds.x + groupBounds.width + padding
        && point.y >= groupBounds.y - padding && point.y <= groupBounds.y + groupBounds.height + padding;
      if (!event.ctrlKey && !event.metaKey && visibleSelection.length > 1 && (hit && selectedKeys.has(selectionKey(hit))
        || !event.shiftKey && (!hit || hit.kind === "room") && inGroup
        || hit && (hit.kind === "door" || hit.kind === "window") && selectedWallIds.has(plan.openings.find(opening => opening.id === hit.id)!.wallId))) {
        startGroupDrag(event, visibleSelection, hit ?? undefined); return;
      }
      if (!hit || hit.kind === "room") {
        setEditingDimension(null);
        setDrag({ kind: "marquee", start: point, current: point, initial: selectedItems, additive: event.shiftKey, click: hit });
        return;
      }
      if (hit.kind === "thickness") { startDimensionDrag(event, hit.id, "thickness"); return; }
      if (hit.kind === "dimension") { startDimensionDrag(event, hit.id); return; }
      if (hit.kind === "door" || hit.kind === "window") { startGroupDrag(event, [hit], hit); return; }
      if (hit?.kind === "wall" && nearestWall(plan, point, 12 / (SCALE * view.zoom))?.wall.id === hit.id) {
        setEditingDimension(null);
        pointerTarget.current = "wall";
        wallWasDragged.current = false;
        startItemDrag(event, { kind: "wall", id: hit.id, start: point, current: point, preview: plan, error: null }, hit);
      } else if (event.shiftKey) setSelectedItems(current => toggleSelection(current, hit));
      else setSelection(hit);
    }
  };
  const onWallDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    // Pointer capture can retarget a node's double-click to the canvas.
    if (!api || tool !== "select" || event.shiftKey || pointerTarget.current !== "wall" || wallWasDragged.current) return;
    if (event.target instanceof Element &&
      event.target.closest(".node-control, .dimension-hit-target, .dimension-line-target, .angle-control")) return;
    const current = planRef.current;
    const point = toWorld(event);
    const threshold = 12 / (SCALE * view.zoom);
    const hit = hitTest(current, point, threshold, showDimensions);
    const wall = nearestWall(current, point, threshold);
    if (hit?.kind !== "wall" || !wall || wall.wall.id !== hit.id) return;
    event.preventDefault();
    setDrag(null);
    setEditingDimension(null);
    const offset = snap && !event.altKey ? Math.round(wall.offset / 50) * 50 : wall.offset;
    if (commit(p => splitWall(p, wall.wall.id, offset))) {
      setSelection({ kind: "wall", id: wall.wall.id });
      event.currentTarget.focus({ preventScroll: true });
    }
  };
  const updatePointerPreview = ({ clientX, clientY, altKey, shiftKey }: PointerSample) => {
    if (!api) return;
    if (!dragRef.current && !["wall", "room", "angle", "door", "window", "dimension"].includes(tool)) return;
    let movement = dragRef.current;
    if (movement?.kind === "pan") {
      const client = shiftKey ? constrainToAxis({ x: clientX, y: clientY }, movement.client) : { x: clientX, y: clientY };
      api.updateScene({ appState: {
        scrollX: movement.scrollX + (client.x - movement.client.x) / view.zoom,
        scrollY: movement.scrollY + (client.y - movement.client.y) / view.zoom,
      }, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    const point = toWorld({ clientX, clientY });
    if (isGeometryDrag(movement) || movement?.kind === "dimension") {
      movement = activatePress(movement, point);
      if (movement.press && !movement.press.started) return;
    }
    if (movement?.kind === "marquee") {
      if (point.x !== movement.current.x || point.y !== movement.current.y) setDrag({ ...movement, current: point });
    } else if (movement?.kind === "dimension") {
      const offset = dimensionOffsetAt(movement, point);
      const guides = dimensionGuides(movement, offset, altKey);
      if (offset !== movement.offset || movement !== dragRef.current || !sameGuides(movement.guides, guides)) setDrag({ ...movement, offset, guides });
    } else if (isGeometryDrag(movement)) {
      const next = geometryDragAt(movement, point, altKey, shiftKey);
      if (movement !== dragRef.current || next.preview !== movement.preview || next.error !== movement.error || !sameGuides(next.guides, movement.guides)
        || next.kind !== "group" && movement.kind !== "group"
        && (next.mergeTarget !== movement.mergeTarget || next.hasMoved !== movement.hasMoved)) setDrag(next);
    } else if (tool === "door" || tool === "window" || tool === "dimension") {
      try {
        const hit = placementAt(point, altKey);
        showGuides(hit?.guides ?? []);
        setEditError(null);
        if (hit && (tool === "door" || tool === "window")) {
          const width = tool === "door" ? doorWidth : windowWidth;
          setPlacement(previous => previous?.wallId === hit.wall.id && previous.offset === hit.offset
            && previous.kind === tool && previous.width === width ? previous
            : { id: "preview-opening", wallId: hit.wall.id, offset: hit.offset, width, kind: tool, flip: false });
        } else setPlacement(null);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        clearGuides();
        setEditError(error.message);
      }
    } else {
      const next = tool === "angle" ? point : draftPoint(point, altKey, shiftKey) ?? point;
      if (tool === "angle" && angleDraft?.wallB && hasAngleGeometry(plan, { wallA: angleDraft.wallA, wallB: angleDraft.wallB })) {
        const angle = { ...angleDimensionAt(plan, angleDraft.wallA, angleDraft.wallB, next), id: ANGLE_PREVIEW_ID };
        const position = anglePosition(plan, angle);
        showGuides(snap && !altKey ? [{ id: "angle-placement", kind: "constraint", a: position.vertex, b: position.label }] : []);
      }
      setPointer(previous => previous?.x === next.x && previous.y === next.y ? previous : next);
    }
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement | HTMLDivElement>) => {
    if (!api || !dragRef.current && !["wall", "room", "angle", "door", "window", "dimension"].includes(tool)) return;
    const sample = rememberPointer(event);
    previewFrame.schedule(() => updatePointerPreview(sample));
  };
  useEffect(() => {
    const onModifier = (event: KeyboardEvent) => {
      if (!["Shift", "Alt"].includes(event.key) || tool === "notes" || showHelp || pendingNew
        || isEditableTarget(event.target)) return;
      const previous = lastPointer.current;
      if (!previous || previous.shiftKey === event.shiftKey && previous.altKey === event.altKey) return;
      const sample = rememberPointer({ ...previous, shiftKey: event.shiftKey, altKey: event.altKey });
      previewFrame.schedule(() => updatePointerPreview(sample));
    };
    const onBlur = () => { lastPointer.current = null; setDrag(null); };
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
      window.removeEventListener("blur", onBlur);
    };
  }, [tool, showHelp, pendingNew, previewFrame, setDrag, updatePointerPreview]);
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement | HTMLDivElement>) => {
    if (!api || dragRef.current?.kind === "dimension" && event.button !== 0) return;
    lastPointer.current = null;
    previewFrame.cancel();
    clearGuides();
    let movement = dragRef.current;
    const releasePoint = toWorld(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (isGeometryDrag(movement) || movement?.kind === "dimension") {
      movement = activatePress(movement, releasePoint);
      if (movement.press) {
        if (!movement.press.started) {
          setSelectedItems(toggleSelections(movement.press.initial, movement.press.toggle ?? [movement.press.item]));
          setDrag(null);
          return;
        }
        setSelectedItems(movement.press.items);
      }
    }
    if (movement) {
      if (movement.kind === "marquee") {
        setSelectedItems(marqueeItems(plan, notes, groups, { ...movement, current: releasePoint }, view.zoom, showDimensions));
      } else if (movement.kind === "dimension") {
        const offset = dimensionOffsetAt(movement, releasePoint);
        dimensionWasDragged.current = offset !== movement.initialOffset;
        if (dimensionWasDragged.current) commit(current => movement.measurement === "thickness"
          ? updateThicknessDimension(current, movement.id, { offset }) : setDimensionOffset(current, movement.id, offset));
      } else if (isGeometryDrag(movement)) {
        const final = geometryDragAt(movement, releasePoint, event.altKey, event.shiftKey);
        if (movement.kind === "angle") angleWasDragged.current = final.preview !== plan || !!final.error;
        if (movement.kind === "wall") wallWasDragged.current = final.preview !== plan || !!final.error;
        if (final.error) setEditError(final.error);
        else if (final.kind === "node" && final.mergeTarget) {
          const targetId = final.mergeTarget;
          if (commit(current => mergeNodes(current, final.id, targetId))) {
            setSelection(planRef.current.nodes.some(node => node.id === targetId) ? { kind: "node", id: targetId } : null);
          }
        } else if (final.kind === "group" && (final.preview !== plan || final.previewNotes !== notesRef.current)) {
          commitEditor(current => ({ ...current, plan: final.preview, notes: final.previewNotes }));
        } else if (final.preview !== plan) commit(() => final.preview);
      } else if (movement.kind === "pan") {
        const client = event.shiftKey ? constrainToAxis({ x: event.clientX, y: event.clientY }, movement.client)
          : { x: event.clientX, y: event.clientY };
        api.updateScene({ appState: {
          scrollX: movement.scrollX + (client.x - movement.client.x) / view.zoom,
          scrollY: movement.scrollY + (client.y - movement.client.y) / view.zoom,
        }, captureUpdate: CaptureUpdateAction.NEVER });
      }
      setDrag(null);
      return;
    }
    if (event.button !== 0 || tool === "select" || tool === "hand") return;
    const raw = toWorld(event);
    if (tool === "angle") {
      if (angleDraft?.wallB) {
        const { wallA, wallB } = angleDraft;
        let angleId = "";
        if (commit(p => {
          const next = addAngleDimension(p, angleDimensionAt(p, wallA, wallB, raw));
          angleId = next.angleDimensions!.at(-1)!.id;
          return next;
        })) {
          chooseTool("select");
          setShowDimensions(true);
          setSelection({ kind: "angle", id: angleId });
          setMessage(null);
        }
        return;
      }
      const hit = nearestWall(plan, raw, 18 / (SCALE * view.zoom));
      if (!hit) { setEditError("Click directly on a wall to measure its angle."); return; }
      if (angleDraft) {
        try {
          angleVertex(plan, angleDraft.wallA, hit.wall.id);
          if (!hasAngleGeometry(plan, { wallA: angleDraft.wallA, wallB: hit.wall.id })) {
            throw new Error("Move the junctions apart before measuring this angle.");
          }
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          setEditError(error.message);
          return;
        }
        setAngleDraft({ ...angleDraft, wallB: hit.wall.id });
      } else {
        setAngleDraft({ wallA: hit.wall.id });
        setSelection({ kind: "wall", id: hit.wall.id });
      }
      setShowDimensions(true);
      setPointer(raw);
      setMessage(null);
      return;
    }
    if (tool === "wall" || tool === "room") {
      const point = draftPoint(raw, event.altKey, event.shiftKey, false);
      if (!point) return;
      if (!origin) { setOrigin(point); setPointer(point); return; }
      const joinsExisting = plan.nodes.some(node => distance(node, point) < 1);
      const success = commit(p => tool === "room" ? addRoom(p, origin, point, thickness) : addWall(p, origin, point, thickness));
      if (success) {
        setOrigin(tool === "room" || joinsExisting ? null : point);
        setPointer(point);
        setSelection(null);
      }
    } else {
      let hit: ReturnType<typeof placementAt>;
      try {
        hit = placementAt(raw, event.altKey);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        setEditError(error.message);
        return;
      }
      if (!hit) { setEditError("Click directly on a wall to place an opening or dimension."); return; }
      if (tool === "dimension") {
        setShowDimensions(true);
        if (measurementType === "thickness") addThickness(hit.wall.id, hit.offset - distance(...wallPoints(plan, hit.wall)));
        else {
          commit(p => toggleDimension(p, hit.wall.id));
          setSelection({ kind: "wall", id: hit.wall.id });
        }
      } else if (tool === "door" || tool === "window") {
        const width = tool === "door" ? doorWidth : windowWidth;
        let openingId = "";
        if (commit(p => {
          const next = addOpening(p, hit.wall.id, tool, hit.offset, width);
          openingId = next.openings.at(-1)!.id;
          return next;
        })) { setSelection({ kind: tool, id: openingId }); chooseTool("select"); }
      }
    }
  };

  const replaceProject = (next: ReturnType<typeof makeProject>) => {
    syncingProject.current = true;
    applySnapshot({ plan: next.plan, notes: structuredClone(next.sketches), groups: next.groups ?? [] }, next.sketches);
    setPast([]);
    setFuture([]);
    pastRef.current = [];
    futureRef.current = [];
    setSelection(null);
    chooseTool("select");
    setSavePaused(false);
    setMessage(null);
    api?.history.clear();
    requestAnimationFrame(() => requestAnimationFrame(fit));
  };
  const importProject = async (file: File) => {
    try {
      if (file.size > 10_000_000) throw new Error("This project is too large. The limit is 10 MB.");
      const next = parseProject(await file.text());
      if ((plan.walls.length || notes.length) && !window.confirm("Open this project? Download the current project first if you want to keep it.")) return;
      replaceProject(next);
      notify("Project opened.");
    } catch (error) {
      notify(`Could not open project: ${errorMessage(error)}`, true);
    }
  };
  const exportImage = async (format: "svg" | "png") => {
    if (!api) return;
    setExporting(true);
    try {
      const content = await exportDrawing(api, [...planToElements(planRef.current, showDimensions), ...notesRef.current], format);
      downloadFile(content, format === "svg" ? "image/svg+xml" : "image/png", `${plan.name}.${format}`);
      notify(`${format.toUpperCase()} exported. Use the labeled dimensions; the image is not print-to-scale.`);
    } catch (error) {
      notify(`Export failed: ${errorMessage(error)}`, true);
    } finally {
      setExporting(false);
    }
  };

  const selectedWall = selection?.kind === "wall" ? displayPlan.walls.find(w => w.id === selection.id) : undefined;
  const selectedNode = selection?.kind === "node" ? displayPlan.nodes.find(node => node.id === selection.id) : undefined;
  const editingThickness = editingDimension?.kind === "thickness"
    ? plan.thicknessDimensions?.find(dimension => dimension.id === editingDimension.id) : undefined;
  const editingWall = editingDimension?.kind === "wall" || editingThickness
    ? plan.walls.find(wall => wall.id === (editingThickness?.wallId ?? editingDimension?.id)) : undefined;
  const editingAngle = editingDimension?.kind === "angle"
    ? plan.angleDimensions?.find(angle => angle.id === editingDimension.id && hasAngleGeometry(plan, angle)) : undefined;
  const editingLabel = editingDimension?.kind === "angle"
    ? angleLabels.find(label => label.id === `plan-angle-label-${editingDimension.id}`)
    : editingThickness ? thicknessLabels.find(label => label.id === `plan-thickness-label-${editingThickness.id}`)
    : dimensionLabels.find(label => label.id === `plan-dim-label-${editingDimension?.id}`);
  const beginDimensionEdit = (id: string, measurement?: "thickness") => {
    chooseTool("select");
    const kind = measurement === "thickness" ? "thickness" : "wall";
    setSelection({ kind: measurement === "thickness" ? "thickness" : "dimension", id });
    if (!measurement && isWallDegenerate(plan, plan.walls.find(wall => wall.id === id)!)) {
      setEditError("Move the wall's junctions apart before editing its length.");
      return;
    }
    setEditingDimension({ kind, id });
  };
  const beginAngleEdit = (angleId: string) => {
    chooseTool("select");
    setSelection({ kind: "angle", id: angleId });
    if (!hasAngleGeometry(plan, plan.angleDimensions!.find(angle => angle.id === angleId)!)) return;
    setEditingDimension({ kind: "angle", id: angleId });
  };
  const measurementKeyDown = (event: ReactKeyboardEvent<SVGRectElement>, item: SelectionItem, edit: () => void) => {
    if (!["Enter", " ", "Delete", "Backspace"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Delete" || event.key === "Backspace") {
      if (visibleSelection.length > 1 && selectedKeys.has(selectionKey(item))) removeSelected();
      else removeItems([item]);
    } else if (event.shiftKey) setSelectedItems(current => toggleSelection(current, item));
    else edit();
  };
  const selectedOpening = selection && ["door", "window"].includes(selection.kind) ? displayPlan.openings.find(o => o.id === selection.id) : undefined;
  const selectedRoom = selection?.kind === "room" ? rooms.find(r => r.id === selection.id) : undefined;
  const drawing = !!origin && !!pointer && (tool === "wall" || tool === "room");
  const toolHint = nodeMergeTarget ? "Release to combine nodes. Hold Alt to keep them separate."
    : tool === "dimension" && measurementType === "thickness" ? "Click a wall to measure its thickness. Drag the measurement along the wall to reposition it."
    : tool === "select" && visibleSelection.length > 1 ? "Drag selection to move. Shift-click to toggle items. Delete removes selection; Esc clears."
    : tool === "angle" && angleDraft
    ? angleDraft.wallB
      ? "Move inside or outside the corner to choose the measured angle, then click to place its arc. Esc cancels."
      : "Click a different wall sharing a junction with the highlighted wall. Esc cancels."
    : hints[tool];
  const lengthUnit = getLengthUnit(plan);
  const unitLabel = { m: "Meters", cm: "Centimeters", ft: "Feet & inches", in: "Inches" }[lengthUnit];
  const displayedSaveState = savePaused || saveState === "error" ? "error"
    : !pendingNotes.current && savedSnapshot?.plan === plan && savedSnapshot.notes === notes && savedSnapshot.groups === groups ? "saved" : "saving";
  const saveLabel = displayedSaveState === "saved" ? "Saved on this device"
    : displayedSaveState === "saving" ? "Saving..." : "Not saved locally";
  const showDefaults = ["wall", "room", "door", "window"].includes(tool);
  const hasSelection = visibleSelection.length > 1 || !!(selectedWall || selectedNode || selectedOpening || selectedRoom
    || selection?.kind === "dimension" && displayPlan.walls.some(wall => wall.id === selection.id && wall.dimension)
    || selection?.kind === "thickness" && displayPlan.thicknessDimensions?.some(dimension => dimension.id === selection.id)
    || selection?.kind === "angle" && displayPlan.angleDimensions?.some(angle => angle.id === selection.id));
  const inputFeedback = geometryDrag?.error ?? drawingFeedback?.error ?? editError;
  const pickedGroups = selectedGroups(groups, visibleSelection);
  const canGroup = visibleSelection.length > 1 && !(pickedGroups.length === 1
    && pickedGroups[0].members.length === visibleSelection.length);
  const showTextProperties = tool === "text" || tool === "select" && visibleSelection.length === 1 && visibleSelection[0].kind === "note";
  const onNativePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest("canvas")) return;
    nativeSelectionBase.current = event.shiftKey ? planMembers(selectionRef.current) : [];
    const current = apiRef.current;
    if (!current || current.getAppState().activeTool.type !== "selection" || !stage.current) return;
    const start = toWorld(event);
    const note = [...notesRef.current].reverse().find(note => {
      const bounds = noteBounds([note])!;
      return start.x >= bounds.x && start.y >= bounds.y && start.x <= bounds.x + bounds.width && start.y <= bounds.y + bounds.height;
    });
    if (!note) return;
    const item: SelectionItem = { kind: "note", id: note.id };
    if (event.ctrlKey || event.metaKey) enteredMember.current = selectionKey(item);
    nativeIndividual.current = enteredMember.current === selectionKey(item);
    if (nativeIndividual.current) return;
    const members = expandGroups(groupsRef.current, [item]);
    const initial = selectionRef.current;
    const mixed = initial.some(item => item.kind !== "note");
    const included = members.every(member => initial.some(item => selectionKey(item) === selectionKey(member)));
    if (members.length === 1 && !(mixed && (included || event.shiftKey))) return;
    event.preventDefault();
    event.stopPropagation();
    const items = event.shiftKey ? addSelections(initial, members) : included ? initial : members;
    chooseTool("select");
    const base = planRef.current, baseNotes = notesRef.current;
    setDrag({ kind: "group", items, start, current: start, base, preview: base, baseNotes, previewNotes: baseNotes,
      error: null, delta: { x: 0, y: 0 },
      press: event.shiftKey ? { item, initial, items, toggle: members, started: false } : undefined });
    clearNoteSelection();
    if (!event.shiftKey) setSelectedItems(items);
    stage.current.setPointerCapture(event.pointerId);
  }, [chooseTool, clearNoteSelection, setDrag, setSelectedItems, toWorld]);
  // Holes let the real canvas receive text and resize-handle gestures without synthetic events.
  const textClip = useMemo(() => tool === "select" && api ? textInteractionClip(notes, {
    ...api.getAppState(), selectedElementIds: Object.fromEntries(nativeNoteSelection(groups, selectedItems).map(id => [id, true])),
  }) : undefined, [api, tool, notes, selectedItems, groups, view]);
  const editor = useMemo(() => <DrawingCanvas onReady={setApi} onChange={onSceneChange}
    initialElements={initialElements} onUnsupported={unsupportedNotes} onPointerDown={onNativePointerDown}
    onKeyDown={onKeyDown} />,
  [initialElements, onSceneChange, unsupportedNotes, onKeyDown, onNativePointerDown]);

  return <div className="app">
    <header className="app-header">
      <div className="project-controls">
        <EditorPopover label="Project menu" trigger={<Menu size={18} />} className="project-menu">
          <div className="menu-heading">Homedraw</div>
          <button data-close-popover onClick={() => fileInput.current?.click()}><ArrowUpFromLine size={16} /> Open project</button>
          <button data-close-popover onClick={saveProject}><Save size={16} /> Save a copy <kbd>Ctrl+S</kbd></button>
          <button data-close-popover onClick={() => setPendingNew(true)}><Plus size={16} /> New plan</button>
          <div className="sidebar-divider" />
          <button data-close-popover onClick={() => setShowHelp(true)}><CircleHelp size={16} /> Quick guide & shortcuts</button>
          <small>Saved locally in this browser.</small>
        </EditorPopover>
        <div className="project-heading">
          <input aria-label="Project name" value={plan.name} maxLength={80}
            onChange={event => commit(p => ({ ...p, name: event.target.value }))} />
          <span className={`save-indicator ${displayedSaveState === "error" ? "save-error" : ""}`}
            role="status" aria-label={saveLabel} title={saveLabel}>
            {displayedSaveState === "saved" ? <Check size={14} /> : <Save size={14} />}
          </span>
        </div>
      </div>
      <div className="project-actions">
        <EditorPopover label="Plan details" trigger={<House size={18} />} className="rooms-menu">
          <div className="menu-heading">Plan details</div>
          <div className="plan-summary"><div><span>Enclosed area</span><strong className="area-value">{formatArea(rooms.reduce((sum, r) => sum + r.area, 0), plan.units)}</strong></div>
            <div><span>Rooms</span><strong>{rooms.length}</strong></div>
          </div>
          <p className="summary-meta">{plan.walls.length} walls · {plan.openings.filter(o => o.kind === "door").length} doors · {plan.openings.filter(o => o.kind === "window").length} windows</p>
          <div className="sidebar-divider" />
          <div className="room-list">{rooms.length ? rooms.map(room =>
            <button key={room.id} data-close-popover className={selection?.id === room.id ? "selected" : ""} onClick={() => {
              setSelection({ kind: "room", id: room.id }); chooseTool("select");
            }}><span className="room-dot" /><span>{room.name}<small>{formatArea(room.area, plan.units)}</small></span><ChevronDown size={13} /></button>,
          ) : <p className="helper">Draw a closed wall boundary to create a room.</p>}</div>
          <p className="helper">Areas and wall lengths use centerlines. Thickness is measured face to face. Verify measurements on site.</p>
        </EditorPopover>
        <EditorPopover label="Drawing settings" trigger={<Settings2 size={18} />} className="settings-menu">
          <div className="menu-heading">Drawing settings</div>
          <label className="field"><span>Measurement units</span><select aria-label="Measurement units" value={plan.units}
            onChange={event => {
              const units = event.target.value === "metric" ? "metric" : "imperial";
              if (commit(p => p.units === units ? p : { ...p, units })) setEditingDimension(null);
            }}>
            <option value="metric">Metric (m / cm / mm)</option><option value="imperial">Imperial (ft / in)</option>
          </select></label>
          <label className="field"><span>Length units</span><select aria-label="Length units" value={lengthUnit}
            onChange={event => {
              const unit = event.target.value;
              if (commit(p => setLengthUnit(p, unit))) setEditingDimension(null);
            }}>
            {plan.units === "metric" ? <><option value="m">Meters (m)</option><option value="cm">Centimeters (cm)</option></>
              : <><option value="ft">Feet & inches (ft)</option><option value="in">Inches (in)</option></>}
          </select></label>
          <p className="helper">Lengths and unitless input use this unit. Room areas stay in {plan.units === "metric" ? "square meters" : "square feet"}.</p>
          <button className={`option-row ${snap ? "enabled" : ""}`} aria-pressed={snap} onClick={() => setSnap(!snap)}><Magnet size={16} /> Snap to geometry <span className="switch" /></button>
          <button className={`option-row ${orthogonal ? "enabled" : ""}`} aria-pressed={orthogonal} onClick={() => setOrthogonal(!orthogonal)}><Scan size={16} /> Straight walls <span className="switch" /></button>
          <p className="helper">Dashed guides show alignment with existing geometry. Hold Shift to lock an axis; Alt hides guides and bypasses snapping without disabling the Shift lock.</p>
          <div className="sidebar-divider" />
          <button className={`option-row ${showDimensions ? "enabled" : ""}`} onClick={() => { setShowDimensions(!showDimensions); setEditingDimension(null); }} aria-pressed={showDimensions}><Ruler size={15} /> Dimensions <span className="switch" /></button>
          <button className={`option-row ${showGrid ? "enabled" : ""}`} onClick={() => setShowGrid(!showGrid)} aria-pressed={showGrid}><Grid2X2 size={15} /> Dot grid <span className="switch" /></button>
        </EditorPopover>
        <EditorPopover label="Export" trigger={<><ArrowDownToLine size={16} /><span>Export</span></>} className="export-menu">
          <button onClick={saveProject}><Save size={16} /> Editable project</button>
          <button disabled={exporting} onClick={() => void exportImage("svg")}><Square size={16} /> SVG drawing</button>
          <button disabled={exporting} onClick={() => void exportImage("png")}><Grid2X2 size={16} /> PNG image</button>
          <small>Images are not print-to-scale.</small>
        </EditorPopover>
      </div>
      <input hidden ref={fileInput} type="file" accept=".json,.homedraw.json" onChange={event => {
        const file = event.target.files?.[0];
        if (file) void importProject(file);
        event.target.value = "";
      }} />
    </header>

    {tool === "notes" ? <NotesControls api={api} onDone={() => chooseTool("select")}
      onDelete={removeSelected} onGroup={changeGrouping} canGroup={canGroup}
      canUngroup={pickedGroups.length > 0} error={inputFeedback} /> : <nav className="tool-toolbar" aria-label="Drawing tools">
      <button className={`tool-button ${tool === "hand" ? "active" : ""}`} aria-label="Pan tool" aria-pressed={tool === "hand"} title="Pan (H)"
        onClick={() => chooseTool(tool === "hand" ? "select" : "hand")}><Hand size={19} /><kbd>H</kbd></button>
      <span className="toolbar-divider" />
      {tools.map(({ id, label, key, icon: Icon }) =>
        <button key={id} className={`tool-button ${tool === id ? "active" : ""}`}
          aria-label={`${label} tool`} aria-pressed={tool === id} title={`${label} (${key})`} onClick={() => chooseTool(id)}>
          <Icon size={20} strokeWidth={1.7} /><kbd>{key}</kbd>
        </button>,
      )}
      <span className="toolbar-divider" />
      <button className={`tool-button ${tool === "text" ? "active" : ""}`} onClick={() => chooseTool("text")}
        aria-label="Text tool" aria-pressed={tool === "text"} title="Text (T)"><Type size={19} /><kbd>T</kbd></button>
      <button className="tool-button" onClick={() => chooseTool("notes")}
        aria-label="Renovation notes" title="Renovation notes (S)"><Pencil size={19} /><kbd>S</kbd></button>
    </nav>}
    {showTextProperties && <NotesControls api={api} onDelete={removeSelected} error={inputFeedback} />}

      <main className="drawing-area">
        <div className="canvas-stage" ref={stage}
          onPointerMoveCapture={event => { if (event.target === stage.current) onPointerMove(event); }}
          onPointerUpCapture={event => { if (event.target === stage.current) onPointerUp(event); }}
          onPointerCancel={event => { if (event.target === stage.current) setDrag(null); }}
          onLostPointerCapture={event => { if (event.target === stage.current) setDrag(null); }}
          onWheelCapture={event => {
            if (tool === "notes" || !(event.target instanceof Element)
              || !event.target.closest("canvas, .interaction-layer")) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = stage.current!.getBoundingClientRect();
            zoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
          }}>
          {editor}
          {showGrid && tool !== "notes" && <div className="grid-layer" style={{
            backgroundSize: `${50 * SCALE * view.zoom}px ${50 * SCALE * view.zoom}px`,
            backgroundPosition: `${view.scrollX * view.zoom}px ${view.scrollY * view.zoom}px`,
            opacity: view.zoom < 0.5 ? 0.22 : 0.45,
          }} />}
          {tool !== "notes" && <svg className={`interaction-layer tool-${tool}`} aria-label="Floor plan canvas" data-testid="draft-canvas" tabIndex={-1}
            style={textClip === undefined ? undefined : { clipPath: "url(#text-interaction-clip)" }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onDoubleClick={onWallDoubleClick}
            onPointerCancel={() => { setDrag(null); setOrigin(null); setAngleDraft(null); }}
            onLostPointerCapture={() => setDrag(null)}
            onPointerLeave={() => {
              if (!dragRef.current) {
                previewFrame.cancel(); clearGuides(); lastPointer.current = null;
                if (!origin && !angleDraft) setPointer(null);
              }
            }}
            onContextMenu={event => {
              event.preventDefault(); previewFrame.cancel(); clearGuides(); lastPointer.current = null;
              setOrigin(null); setAngleDraft(null);
            }}>
            {textClip !== undefined && <defs><clipPath id="text-interaction-clip" clipPathUnits="userSpaceOnUse">
              <path d={textClip} clipRule="evenodd" />
            </clipPath></defs>}
            <g transform={`translate(${view.scrollX * view.zoom}, ${view.scrollY * view.zoom}) scale(${SCALE * view.zoom})`}>
              {selectedRoom && <polygon points={selectedRoom.points.map(p => `${p.x},${p.y}`).join(" ")} className="selected-room" />}
              {displayPlan.walls.filter(wall => selectedNodeIds.has(wall.a) || selectedNodeIds.has(wall.b)).map(wall => {
                const [a, b] = wallPoints(displayPlan, wall);
                return <line key={wall.id} className="node-wall-highlight" x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  strokeWidth={wall.thickness + 60} />;
              })}
              {visibleSelection.length > 1 && <g className="multi-selection">
                {rooms.filter(room => selectedKeys.has(`room:${room.id}`)).map(room =>
                  <polygon key={room.id} points={room.points.map(point => `${point.x},${point.y}`).join(" ")} className="selected-room" />)}
                {displayPlan.walls.filter(wall => selectedWallIds.has(wall.id)).map(wall => {
                  const [a, b] = wallPoints(displayPlan, wall);
                  return <line key={wall.id} data-testid={`selected-wall-${wall.id}`} className="selection-line"
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={wall.thickness + 60} />;
                })}
                {displayPlan.openings.filter(opening => selectedKeys.has(`${opening.kind}:${opening.id}`)).map(opening => {
                  const points = openingPoints(displayPlan, opening);
                  const [a] = wallPoints(displayPlan, displayPlan.walls.find(wall => wall.id === opening.wallId)!);
                  return <circle key={opening.id} data-testid={`selected-opening-${opening.id}`}
                    cx={points ? (points[0].x + points[1].x) / 2 : a.x} cy={points ? (points[0].y + points[1].y) / 2 : a.y}
                    r={120 / view.zoom} className="opening-handle" />;
                })}
                {groupBounds && <rect data-testid="selection-bounds" className="selection-bounds"
                  x={groupBounds.x - 80 / view.zoom} y={groupBounds.y - 80 / view.zoom}
                  width={groupBounds.width + 160 / view.zoom} height={groupBounds.height + 160 / view.zoom} />}
              </g>}
              {angleDraft && [angleDraft.wallA, angleDraft.wallB].filter(id => id !== undefined).map(id => {
                const wall = displayPlan.walls.find(wall => wall.id === id)!;
                const [a, b] = wallPoints(displayPlan, wall);
                return <line key={id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  className="angle-wall-highlight" strokeWidth={wall.thickness + 90} />;
              })}
              {selectedWall && (() => {
                const [a, b] = wallPoints(displayPlan, selectedWall);
                return <g><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="selection-line" strokeWidth={selectedWall.thickness + 60} />
                  {[a, b].map((p, i) => <g key={p.id}>
                    {tool !== "select" && <circle cx={p.x} cy={p.y} r={45 / view.zoom} className="node-handle" />}
                    <text x={p.x + 100 / view.zoom} y={p.y - 100 / view.zoom} fontSize={120 / view.zoom} className="node-label">{i ? "B" : "A"}</text></g>)}
                </g>;
              })()}
              {selectedOpening && (() => {
                const wall = displayPlan.walls.find(w => w.id === selectedOpening.wallId)!;
                const points = openingPoints(displayPlan, selectedOpening);
                const [a] = wallPoints(displayPlan, wall);
                const x = points ? (points[0].x + points[1].x) / 2 : a.x;
                const y = points ? (points[0].y + points[1].y) / 2 : a.y;
                return <circle cx={x} cy={y} r={120 / view.zoom} className="opening-handle" />;
              })()}
              {drawing && (tool === "room"
                ? <rect x={Math.min(origin.x, pointer.x)} y={Math.min(origin.y, pointer.y)} width={Math.abs(origin.x - pointer.x)}
                  height={Math.abs(origin.y - pointer.y)} className={`preview-room ${drawingInvalid ? "invalid-preview" : ""}`} strokeWidth={thickness} />
                : <line x1={origin.x} y1={origin.y} x2={pointer.x} y2={pointer.y}
                  className={`preview-line ${drawingInvalid ? "invalid-preview" : ""}`} strokeWidth={thickness} />)}
              {placement && !drag && (tool === "door" || tool === "window") && (() => {
                const points = openingPoints(plan, placement);
                if (!points) return null;
                const [a, b] = points;
                const wall = plan.walls.find(wall => wall.id === placement.wallId)!;
                const normal = { x: -(b.y - a.y) / placement.width, y: (b.x - a.x) / placement.width };
                const leaf = { x: a.x + normal.x * placement.width, y: a.y + normal.y * placement.width };
                const outside = placement.offset - placement.width / 2 < 0
                  || placement.offset + placement.width / 2 > distance(...wallPoints(plan, wall))
                  || plan.openings.some(opening => opening.wallId === wall.id
                    && Math.abs(opening.offset - placement.offset) < (opening.width + placement.width) / 2);
                return <g className={`opening-placement ${outside ? "invalid-placement" : ""}`} data-testid="opening-placement" aria-hidden="true">
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="opening-placement-body" strokeWidth={wall.thickness} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  {placement.kind === "door" && <>
                    <line x1={a.x} y1={a.y} x2={leaf.x} y2={leaf.y} />
                    <path d={`M ${b.x} ${b.y} A ${placement.width} ${placement.width} 0 0 1 ${leaf.x} ${leaf.y}`} />
                  </>}
                  {placement.kind === "window" && <path d={[
                    `M ${a.x + normal.x * wall.thickness / 2} ${a.y + normal.y * wall.thickness / 2}`,
                    `L ${b.x + normal.x * wall.thickness / 2} ${b.y + normal.y * wall.thickness / 2}`,
                    `L ${b.x - normal.x * wall.thickness / 2} ${b.y - normal.y * wall.thickness / 2}`,
                    `L ${a.x - normal.x * wall.thickness / 2} ${a.y - normal.y * wall.thickness / 2} Z`,
                  ].join(" ")} />}
                </g>;
              })()}
              {highlights.length > 0 && <g className="geometry-warning-overlay" data-testid="geometry-warning-overlay"
                role="img" aria-label={feedbackIssues.map(issue => issue.message).join(" ")}>
                {highlights.map(highlight => "point" in highlight
                  ? <circle key={`${highlight.kind}:${highlight.id}`} data-testid={`warning-${highlight.kind}-${highlight.id}`}
                    cx={highlight.point.x} cy={highlight.point.y} r={85 / view.zoom} className="geometry-warning-node" />
                  : <line key={`${highlight.kind}:${highlight.id}`} data-testid={`warning-${highlight.kind}-${highlight.id}`}
                    x1={highlight.a.x} y1={highlight.a.y} x2={highlight.b.x} y2={highlight.b.y} className="geometry-warning-line" />)}
              </g>}
              {origin && <circle cx={origin.x} cy={origin.y} r={45 / view.zoom} className="node-handle" />}
              {pointer && ["wall", "room"].includes(tool) && <g className="crosshair">
                <circle cx={pointer.x} cy={pointer.y} r={40 / view.zoom} />
                <path d={`M ${pointer.x - 100 / view.zoom} ${pointer.y} h ${200 / view.zoom} M ${pointer.x} ${pointer.y - 100 / view.zoom} v ${200 / view.zoom}`} />
              </g>}
              {(tool === "select" || tool === "dimension") && dimensionLabels.map(label => {
                const wallId = label.id.startsWith("plan-warning-length-")
                  ? label.id.slice("plan-warning-length-".length) : label.id.slice("plan-dim-label-".length);
                const padding = 5 / (SCALE * view.zoom);
                const wall = displayPlan.walls.find(w => w.id === wallId)!;
                const dim = isWallDegenerate(displayPlan, wall) ? null
                  : dimensionPosition(displayPlan, dimensionPreview?.measurement !== "thickness" && dimensionPreview?.id === wallId
                    ? { ...wall, dimensionOffset: dimensionPreview.offset } : wall);
                const cursor = !dim ? "pointer" : Math.abs(dim.axis.x) < 0.15 ? "ns-resize" : Math.abs(dim.axis.y) < 0.15 ? "ew-resize"
                  : dim.axis.x * dim.axis.y > 0 ? "nwse-resize" : "nesw-resize";
                return <g key={wallId} style={{ cursor }} className={`dimension-control ${selectedKeys.has(`dimension:${wallId}`) ? "selected" : ""} ${drag?.kind === "dimension" && drag.id === wallId ? "dimension-dragging" : ""}`}>
                  {dim && <line data-testid={`dimension-line-${wallId}`} className="dimension-line-target"
                    x1={dim.a.x} y1={dim.a.y} x2={dim.b.x} y2={dim.b.y}
                    onPointerDown={event => startDimensionDrag(event, wallId)}>
                    <title>Drag to move this measurement inward or outward</title>
                  </line>}
                  <rect data-testid={`${dim ? "dimension" : "dimension-warning"}-${wallId}`} className="dimension-hit-target"
                  x={label.x / SCALE - padding} y={label.y / SCALE - padding}
                  width={label.width / SCALE + padding * 2} height={label.height / SCALE + padding * 2}
                  role="button" tabIndex={0} aria-label={`Edit measurement ${label.text}`}
                  aria-pressed={selectedKeys.has(`dimension:${wallId}`)}
                  onPointerDown={event => startDimensionDrag(event, wallId)}
                  onDoubleClick={event => {
                    event.stopPropagation();
                    if (!event.shiftKey && !dimensionWasDragged.current) beginDimensionEdit(wallId);
                  }}
                  onKeyDown={event => measurementKeyDown(event, { kind: "dimension", id: wallId }, () => beginDimensionEdit(wallId))}>
                  <title>{dim ? "Drag to reposition. Double-click to edit. Delete removes only this measurement."
                    : "Select and press Delete to remove this measurement."}</title>
                </rect></g>;
              })}
              {(tool === "select" || tool === "dimension") && thicknessLabels.map(label => {
                const id = label.id.slice("plan-thickness-label-".length);
                const dimension = displayPlan.thicknessDimensions!.find(dimension => dimension.id === id)!;
                const wall = displayPlan.walls.find(wall => wall.id === dimension.wallId)!;
                const dim = isWallDegenerate(displayPlan, wall) ? null
                  : thicknessDimensionPosition(displayPlan, dimensionPreview?.measurement === "thickness" && dimensionPreview.id === id
                    ? { ...dimension, offset: dimensionPreview.offset } : dimension);
                const padding = 5 / (SCALE * view.zoom);
                const cursor = !dim ? "pointer" : Math.abs(dim.axis.x) < 0.15 ? "ns-resize" : Math.abs(dim.axis.y) < 0.15 ? "ew-resize"
                  : dim.axis.x * dim.axis.y > 0 ? "nwse-resize" : "nesw-resize";
                return <g key={id} className={`thickness-control angle-control ${selectedKeys.has(`thickness:${id}`) ? "selected" : ""}`} style={{ cursor }}>
                  {dim && <line data-testid={`thickness-line-${id}`} className="dimension-line-target"
                    x1={dim.a.x} y1={dim.a.y} x2={dim.b.x} y2={dim.b.y}
                    onPointerDown={event => startDimensionDrag(event, id, "thickness")} />}
                  <rect data-testid={`thickness-${id}`} className="dimension-hit-target"
                    x={label.x / SCALE - padding} y={label.y / SCALE - padding}
                    width={label.width / SCALE + padding * 2} height={label.height / SCALE + padding * 2}
                    role="button" tabIndex={0} aria-label={`Thickness measurement ${formatLength(wall.thickness, displayPlan)}`}
                    aria-pressed={selectedKeys.has(`thickness:${id}`)}
                    onPointerDown={event => startDimensionDrag(event, id, "thickness")}
                    onDoubleClick={event => {
                      event.stopPropagation();
                      if (!event.shiftKey && !dimensionWasDragged.current) beginDimensionEdit(id, "thickness");
                    }}
                    onKeyDown={event => measurementKeyDown(event, { kind: "thickness", id }, () => beginDimensionEdit(id, "thickness"))}>
                    <title>Drag along the wall to reposition. Double-click to edit wall thickness. Delete removes only this measurement.</title>
                  </rect>
                </g>;
              })}
              {angleLabels.map(label => {
                const angleId = label.id.startsWith("plan-warning-angle-label-")
                  ? label.id.slice("plan-warning-angle-label-".length) : label.id.slice("plan-angle-label-".length);
                const dimension = renderPlan.angleDimensions!.find(angle => angle.id === angleId)!;
                const angle = hasAngleGeometry(renderPlan, dimension) ? anglePosition(renderPlan, dimension) : null;
                const padding = 5 / (SCALE * view.zoom);
                const interactive = tool === "select" && angleId !== ANGLE_PREVIEW_ID;
                return <g key={angleId} className={`angle-control ${selectedKeys.has(`angle:${angleId}`) ? "selected" : ""}`}
                  style={{ pointerEvents: interactive ? undefined : "none" }}>
                  {angle && <polyline data-testid={`angle-arc-${angleId}`} className="angle-arc-target"
                    points={angle.arc.map(point => `${point.x},${point.y}`).join(" ")}
                    style={{ pointerEvents: interactive ? "stroke" : "none" }}
                    onPointerDown={interactive ? event => startAngleDrag(event, angleId) : undefined} />}
                  <rect data-testid={`${angle ? "angle" : "angle-warning"}-${angleId}`} className="dimension-hit-target"
                    x={label.x / SCALE - padding} y={label.y / SCALE - padding}
                    width={label.width / SCALE + padding * 2} height={label.height / SCALE + padding * 2}
                    role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined}
                    aria-label={`Angle measurement ${label.text}`}
                    aria-pressed={interactive ? selectedKeys.has(`angle:${angleId}`) : undefined}
                    onPointerDown={interactive ? event => startAngleDrag(event, angleId) : undefined}
                    onDoubleClick={interactive ? event => {
                      event.stopPropagation();
                      if (!event.shiftKey && !angleWasDragged.current) beginAngleEdit(angleId);
                    } : undefined}
                    onKeyDown={interactive ? event => measurementKeyDown(event, { kind: "angle", id: angleId }, () => beginAngleEdit(angleId)) : undefined}>
                    <title>{angle ? "Drag to reposition. Double-click to edit the angle. Delete removes only this measurement."
                      : "Select and press Delete to remove this measurement."}</title>
                  </rect>
                </g>;
              })}
              {tool === "select" && displayPlan.nodes.map((node, index) => {
                const nodeSelected = selectedNodeIds.has(node.id);
                const selected = nodeSelected || selectedWallNodeIds.has(node.id);
                return <g key={node.id} className={`node-control ${selected ? "selected" : ""} ${nodeSelected ? "node-selected" : ""} ${nodeDragId === node.id ? "dragging" : ""}`}
                  onPointerDown={event => startNodeDrag(event, node.id)}>
                  <circle data-testid={`node-${node.id}`} aria-label={`Wall node ${index + 1}`} role="button" tabIndex={0} aria-pressed={nodeSelected}
                    cx={node.x} cy={node.y} r={100 / view.zoom} className="node-hit-target"
                    onKeyDown={event => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault(); event.stopPropagation();
                        setDrag(null); setEditingDimension(null); setEditError(null);
                        if (event.shiftKey) setSelectedItems(current => toggleSelection(current, { kind: "node", id: node.id }));
                        else setSelection({ kind: "node", id: node.id });
                      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && ["Delete", "Backspace"].includes(event.key)) {
                        event.preventDefault(); event.stopPropagation();
                        if (visibleSelection.length > 1 && selected) removeSelected(); else removeItems([{ kind: "node", id: node.id }]);
                      }
                    }}>
                    <title>Click to select; Delete removes this node. Drag onto another node to combine. Shift locks an axis; Alt bypasses snapping and combining.</title>
                  </circle>
                  <circle cx={node.x} cy={node.y} r={45 / view.zoom} className="node-handle" />
                </g>;
              })}
              {nodeMergeTarget && <circle data-testid="node-merge-target" cx={nodeMergeTarget.x} cy={nodeMergeTarget.y}
                r={150 / view.zoom} className="node-merge-target"><title>Release to combine nodes</title></circle>}
              {drag?.kind === "marquee" && distance(drag.start, drag.current) * SCALE * view.zoom > 3
                && <rect data-testid="selection-marquee" className="selection-marquee"
                  x={Math.min(drag.start.x, drag.current.x)} y={Math.min(drag.start.y, drag.current.y)}
                  width={Math.abs(drag.current.x - drag.start.x)} height={Math.abs(drag.current.y - drag.start.y)} />}
              {activeGuides.length > 0 && <g className="snap-guides" data-testid="snap-guides" aria-hidden="true">
                {activeGuides.map(guide => <g key={guide.id} data-guide-kind={guide.kind}>
                  <line data-testid="snap-guide-line" x1={guide.a.x} y1={guide.a.y} x2={guide.b.x} y2={guide.b.y} />
                  <circle className="snap-guide-source" cx={guide.a.x} cy={guide.a.y} r={2.5 / (SCALE * view.zoom)} />
                  {guide.target && <circle className="snap-guide-target" data-testid="snap-guide-target"
                    cx={guide.target.x} cy={guide.target.y} r={5 / (SCALE * view.zoom)} />}
                </g>)}
              </g>}
            </g>
          </svg>}
          {(editingWall || editingAngle) && editingLabel && tool === "select" && <InlineDimensionEditor key={`${editingDimension!.kind}:${editingDimension!.id}`}
            value={editingAngle ? anglePosition(plan, editingAngle).degrees : editingThickness ? editingWall!.thickness : distance(...wallPoints(plan, editingWall!))}
            formatValue={editingAngle ? formatAngleInput : value => formatLengthInput(value, plan)}
            parseValue={editingAngle ? parseAngle : text => parseLength(text, plan)}
            label={editingAngle ? "Edit angle" : editingThickness ? "Edit thickness" : "Edit dimension"} quantity={editingAngle ? "angle" : "length"}
            tolerance={editingAngle ? 1e-7 : 0.01}
            hint={editingAngle ? "First wall fixed; second wall rotates" : editingThickness ? "Wall centerline stays fixed" : undefined}
            position={{
              x: Math.max(85, Math.min((stage.current?.clientWidth ?? Infinity) - 85,
                (editingLabel.x + editingLabel.width / 2 + view.scrollX) * view.zoom)),
              y: Math.max(22, Math.min((stage.current?.clientHeight ?? Infinity) - 40,
                (editingLabel.y + editingLabel.height / 2 + view.scrollY) * view.zoom)),
            }}
            onApply={value => commit(current => editingAngle
              ? resizeAngle(current, editingAngle.id, value) : editingThickness
                ? setWallThickness(current, editingWall!.id, value) : resizeWall(current, editingWall!.id, value))}
            onClose={() => setEditingDimension(null)} />}
          {drawing && <div className="live-measure" style={{ left: screen(pointer).x + 18, top: screen(pointer).y + 18 }}>
            {tool === "room"
              ? `${formatLength(Math.abs(pointer.x - origin.x), plan)} × ${formatLength(Math.abs(pointer.y - origin.y), plan)}`
              : formatLength(distance(origin, pointer), plan)}
          </div>}
          {plan.walls.length === 0 && notes.length === 0 && tool === "select" && <div className="canvas-welcome">
            <h1>Start your floor plan</h1>
            <p>Draw a room, or connect walls with the Wall tool.</p>
            <button className="primary-button" onClick={() => chooseTool("room")}><Plus size={16} /> Draw your first room</button>
            <button className="text-button" onClick={() => replaceProject(makeProject(createDemoPlan(), []))}>Explore an example instead</button>
          </div>}
          <div className="canvas-controls">
            <div className="control-group"><button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={() => runHistory(false)}><Undo2 size={17} /></button>
              <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={() => runHistory(true)}><Redo2 size={17} /></button></div>
            <div className="control-group zoom-controls"><button aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={16} /></button>
              <span>{Math.round(view.zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => zoom(1.2)}><Plus size={16} /></button>
              <button aria-label="Fit plan" title="Fit plan to view" onClick={fit}><Maximize size={15} /></button></div>
          </div>
          {message && <div className={`toast ${message.error ? "error" : ""}`} role={message.error ? "alert" : "status"}>
            <span>{message.text}</span><button aria-label="Dismiss message" onClick={() => setMessage(null)}><X size={15} /></button>
          </div>}
        </div>
        <footer className="status-bar"><span className="tool-hint">{toolHint}</span>
          <span className="status-units">{tool === "notes" ? "Renovation notes - not measured geometry"
            : <>{unitLabel}<span className="status-separator">|</span>{snap ? `${formatLength(50, plan)} snap` : "Free placement"}</>}</span>
          <button className="icon-button help-button" title="Quick guide" aria-label="Quick guide" onClick={() => setShowHelp(true)}><CircleHelp size={18} /></button>
        </footer>
      </main>

      {tool !== "notes" && !showTextProperties && (showDefaults || tool === "dimension" || hasSelection || feedbackIssues.length > 0 || inputFeedback) && <aside className="floating-inspector" aria-label="Properties">
        {tool === "dimension" && <div className="dimension-modes" role="group" aria-label="Measurement type">
          <button className={`option-row ${measurementType === "length" ? "enabled" : ""}`} aria-pressed={measurementType === "length"}
            onClick={() => { setDrag(null); setMeasurementType("length"); }}><Ruler size={16} /> Length</button>
          <button className={`option-row ${measurementType === "thickness" ? "enabled" : ""}`} aria-pressed={measurementType === "thickness"}
            onClick={() => { setDrag(null); setMeasurementType("thickness"); }}><Ruler size={16} /> Thickness</button>
        </div>}
        {showDefaults ? <>
          <div className="section-heading"><span>{tool === "door" ? "Door" : tool === "window" ? "Window" : tool === "room" ? "Room" : "Wall"}</span><span className="subtle">Defaults</span></div>
          {tool === "door" ? <LengthField label="New door width" value={doorWidth} units={plan} onApply={setDoorWidth} />
            : tool === "window" ? <LengthField label="New window width" value={windowWidth} units={plan} onApply={setWindowWidth} />
            : <LengthField label="New wall thickness" value={thickness} units={plan} onApply={value => {
              if (value < 10 || value > 1000) { setEditError("Wall thickness must be between 10 mm and 1 m."); return false; }
              setThickness(value);
            }} />}
        </> : visibleSelection.length > 1 ? <>
          <div className="section-heading"><span data-testid="selection-count" role="status">{visibleSelection.length} items selected</span></div>
          <p className="helper">Drag to move together; hold Shift to lock an axis. Shift-click adds or removes items. Ctrl/Cmd-click selects a group member. Delete removes the selection; Escape clears it.</p>
          <GroupActions canGroup={canGroup} canUngroup={pickedGroups.length > 0} onChange={changeGrouping} />
          <DeleteButton onDelete={removeSelected}>Delete selected</DeleteButton>
        </> : <Properties plan={propertyPlan} selection={selection} commit={commit}
          onDelete={removeSelected} onAddThickness={addThickness} />}
        {feedbackIssues.length > 0 && <div className="geometry-feedback" data-testid="geometry-feedback" role="status" aria-live="polite">
          <strong>Geometry needs attention</strong>
          <p>Red geometry can still be edited and saved.</p>
          <details><summary>{feedbackIssues.length} {feedbackIssues.length === 1 ? "issue" : "issues"}</summary>
            {feedbackIssues.map(issue => <p key={issue.code}>{issue.message}</p>)}
            <p>Conflicting boundaries are excluded from room areas.</p>
          </details>
        </div>}
        {inputFeedback && <p className="geometry-feedback" data-testid="input-feedback" role="alert">{inputFeedback}</p>}
      </aside>}
    {pendingNew && <div className="modal-backdrop" onClick={() => setPendingNew(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-title" onClick={event => event.stopPropagation()}>
      <button className="modal-close icon-button" aria-label="Close dialog" onClick={() => setPendingNew(false)}><X size={18} /></button>
      <h2 id="new-title">New plan</h2>
      <p>Your new plan will replace the project saved on this device. Download this one first if you want to keep it.</p>
      <button className="secondary-button full" onClick={saveProject}><ArrowDownToLine size={16} /> Download current project</button>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setPendingNew(false)}>Keep working</button>
        <button className="primary-button" autoFocus onClick={() => { replaceProject(makeProject(createEmptyPlan(), [])); setPendingNew(false); }}>Start blank plan</button></div>
    </section></div>}
    {showHelp && <div className="modal-backdrop" onClick={() => setShowHelp(false)}><section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()}>
      <button className="modal-close icon-button" aria-label="Close guide" onClick={() => setShowHelp(false)}><X size={18} /></button>
      <h2 id="help-title">Quick guide</h2>
      <div className="guide-step"><span>1</span><div><strong>Draw the space</strong><p>Use Room (R) for a rectangle or Wall (W) for connected walls. Click to start and click to finish. Esc ends a wall chain. In Select mode, drag empty canvas to select enclosed items. Shift-click toggles items; Shift-drag adds to the selection. Drag selected items to move them together, or press Delete to remove them.</p></div></div>
      <div className="guide-step"><span>2</span><div><strong>Make it measured</strong><p>Double-click a measurement to edit it right on the plan, or select a wall to use the inspector. Click a measurement label and press Delete/Backspace to remove just that measurement, keeping the wall. Enter 4.2 m, 420 cm, or 12' 6". Basic math works too: 20' - 10', (4 m + 20 cm) / 2, or 180 deg - 90 deg. Enter applies; Esc cancels. Length edits keep A fixed and move B; thickness edits keep the centerline fixed. Double-click a wall in Select mode to split it with a new node, or use Add midpoint node in its properties. Drag a circular junction handle to reshape connected walls live. Drop it on another node to combine them. Hold Shift before or during drawing, moving nodes, walls, groups, or panning to lock horizontally or vertically. Alt bypasses grid snapping and combining without disabling the Shift lock.</p></div></div>
      <div className="guide-step"><span>3</span><div><strong>Open up the possibilities</strong><p>Click a wall with Door (D) or Window (N). Use Dimension (M) to choose Length or Thickness, then click a wall. Drag length labels perpendicular to the wall, or thickness labels along it, to make space. Use Text (T) to place a text box anywhere, or Renovation notes (S) for drawing marks and arrows. Done notes returns to the measured plan.</p></div></div>
      <div className="guide-step"><span>4</span><div><strong>Check the corners</strong><p>Use Angle (A): click two walls sharing a junction, then click to place the arc. Choose the inside or outside angle with the pointer. In Select mode, drag the arc or label to adjust its radius. Double-click the label to edit degrees: the first wall stays fixed and the second rotates, keeping its length. Enter applies; Esc cancels.</p></div></div>
      <p className="helper">Ctrl/Cmd+G groups selected items; Ctrl/Cmd+Shift+G ungroups them. Ctrl/Cmd-click edits a group member. Wheel to zoom · H to pan · Ctrl/Cmd+Z to undo · Ctrl/Cmd+S to download. Geometry, notes, and groups share project history.</p>
      <div className="guide-note">A planning aid, not a construction drawing. Verify clearances and site measurements, and consult a qualified professional before structural work.</div>
      <button className="primary-button full" autoFocus onClick={() => setShowHelp(false)}>Got it</button>
    </section></div>}
  </div>;
}
