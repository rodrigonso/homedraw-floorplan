import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  CaptureUpdateAction, Excalidraw, MainMenu, exportToBlob, exportToSvg, getSceneVersion,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, DoorOpen, DraftingCompass, Grid2X2,
  Hand, House, Magnet, Maximize, Menu, Minus, MousePointer2, PanelLeftClose, Pencil,
  Plus, Redo2, Ruler, Save, Scan, Settings2, Square, Undo2, X,
} from "lucide-react";
import {
  addAngleDimension, addOpening, addRoom, addWall, angleVertex, createDemoPlan, createEmptyPlan, deleteAngleDimension, deleteOpening, deleteWall,
  detectRooms, distance, formatArea, formatLength, getGeometryIssues, moveNode, moveWall, parseAngle, parseLength, resizeAngle, resizeWall, setDimensionOffset, snapPoint, toggleDimension, updateAngleDimension, wallPoints,
  type Plan, type Point,
} from "./model";
import { createPlanRenderer, hitTest, isPlanElement, nearestWall, PAPER, planToElements, SCALE, type Selection } from "./scene";
import { downloadFile, errorMessage, loadInitialProject, makeProject, parseProject, STORAGE_KEY, SUPPORTED_SKETCH_TYPES } from "./storage";
import Properties, { LengthField } from "./Properties";
import InlineDimensionEditor from "./InlineDimensionEditor";
import { dimensionPosition, draggedDimensionOffset } from "./dimensions";
import { angleDimensionAt, anglePosition, formatAngleInput, hasAngleGeometry } from "./angles";
import { createFrameScheduler } from "./frameScheduler";
import { geometryHighlights, openingPoints } from "./geometryFeedback";
import EditorPopover from "./EditorPopover";

type Tool = "select" | "wall" | "room" | "door" | "window" | "dimension" | "angle" | "sketch" | "hand";
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
  select: "Drag a corner to reshape connected walls. Drag walls to move them. Double-click measurements to edit.",
  wall: "Click a start point, then an endpoint. Keep clicking to connect walls. Esc to finish.",
  room: "Click two opposite corners to draw a measured room.",
  door: "Click a wall to place a door. Select it to change its width or swing.",
  window: "Click a wall to place a window. Select it to adjust its position.",
  dimension: "Click a wall to add or remove a dimension. Drag its label or line to reposition it.",
  angle: "Click the first wall, then a connected wall, then click to place the angle measurement. Esc cancels.",
  sketch: "Add ideas with Excalidraw. Sketches are visual notes, not measured geometry.",
  hand: "Drag to pan. Use the mouse wheel to zoom.",
};
type GeometryDrag = { kind: "wall" | "node" | "angle"; id: string; start: Point; current: Point; preview: Plan; error: string | null };
type Drag =
  | { kind: "pan"; client: Point; scrollX: number; scrollY: number }
  | { kind: "dimension"; id: string; start: Point; axis: Point; initialOffset: number; offset: number }
  | GeometryDrag;
const HISTORY_LIMIT = 100;
const ANGLE_PREVIEW_ID = "preview:angle";
const isGeometryDrag = (movement: Drag | null): movement is GeometryDrag =>
  movement?.kind === "wall" || movement?.kind === "node" || movement?.kind === "angle";

export default function App() {
  const [initial] = useState(loadInitialProject);
  const [plan, setPlan] = useState(initial.project.plan);
  const planRef = useRef(plan);
  const [sketches, setSketches] = useState<readonly ExcalidrawElement[]>(initial.project.sketches);
  const sketchRef = useRef(sketches);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [editingDimension, setEditingDimension] = useState<{ kind: "wall" | "angle"; id: string } | null>(null);
  const [origin, setOrigin] = useState<Point | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [angleDraft, setAngleDraft] = useState<{ wallA: string; wallB?: string } | null>(null);
  const [previewFrame] = useState(createFrameScheduler);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = useCallback((next: Drag | null) => {
    previewFrame.cancel();
    dragRef.current = next;
    setDragState(next);
  }, [previewFrame]);
  useEffect(() => previewFrame.cancel, [previewFrame]);
  const dimensionWasDragged = useRef(false);
  const angleWasDragged = useRef(false);
  const [view, setView] = useState({ scrollX: 0, scrollY: 0, zoom: 1 });
  const [snap, setSnap] = useState(true);
  const [orthogonal, setOrthogonal] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showDimensions, setShowDimensions] = useState(true);
  const [thickness, setThickness] = useState(150);
  const [doorWidth, setDoorWidth] = useState(900);
  const [windowWidth, setWindowWidth] = useState(1200);
  const [past, setPast] = useState<Plan[]>([]);
  const [future, setFuture] = useState<Plan[]>([]);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(
    initial.error ? { text: initial.error, error: true } : null,
  );
  const [editError, setEditError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(initial.error ? "error" : "saved");
  const [savedSnapshot, setSavedSnapshot] = useState<{ plan: Plan; sketches: readonly ExcalidrawElement[] } | null>(null);
  const [savePaused, setSavePaused] = useState(!!initial.error);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingNew, setPendingNew] = useState(false);
  const [exporting, setExporting] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialized = useRef<ExcalidrawImperativeAPI | null>(null);
  const geometryDrag = isGeometryDrag(drag) ? drag : null;
  const displayPlan = geometryDrag?.preview ?? plan;
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
  const dimensionPreview = drag?.kind === "dimension" ? drag : undefined;
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
    .filter(element => element.id.startsWith("plan-dim-label-")), [geometry]);
  const angleLabels = useMemo(() => geometry.filter(element => element.type === "text")
    .filter(element => element.id.startsWith("plan-angle-label-")), [geometry]);
  const [initialElements] = useState(() => [...geometry, ...initial.project.sketches]);
  const geometryRef = useRef(geometry);
  const apiRef = useRef(api);
  const rooms = useMemo(() => detectRooms(displayPlan, geometryIssues), [displayPlan, geometryIssues]);

  const notify = useCallback((text: string, error = false) => setMessage({ text, error }), []);
  const commit = useCallback((change: (current: Plan) => Plan) => {
    previewFrame.cancel();
    try {
      const current = planRef.current;
      const next = change(current);
      setEditError(null);
      if (next === current) return true;
      setPast(history => [...history.slice(-(HISTORY_LIMIT - 1)), current]);
      setFuture([]);
      planRef.current = next;
      setPlan(next);
      setAngleDraft(null);
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setEditError(error.message);
      return false;
    }
  }, [previewFrame]);

  const chooseTool = useCallback((next: Tool) => {
    setTool(next);
    setOrigin(null);
    setDrag(null);
    setPointer(null);
    setEditingDimension(null);
    setAngleDraft(null);
    setEditError(null);
  }, [setDrag]);

  const undo = useCallback(() => {
    const previous = past.at(-1);
    if (!previous) return;
    const current = planRef.current;
    setFuture(next => [current, ...next]);
    setPast(previous => previous.slice(0, -1));
    planRef.current = previous;
    setPlan(previous);
    setSelection(null);
    setOrigin(null);
    setEditingDimension(null);
    setDrag(null);
    setAngleDraft(null);
    setEditError(null);
  }, [past, setDrag]);
  const redo = useCallback(() => {
    const next = future[0];
    if (!next) return;
    const current = planRef.current;
    setPast(previous => [...previous, current]);
    setFuture(next => next.slice(1));
    planRef.current = next;
    setPlan(next);
    setSelection(null);
    setOrigin(null);
    setEditingDimension(null);
    setDrag(null);
    setAngleDraft(null);
    setEditError(null);
  }, [future, setDrag]);

  useEffect(() => {
    if (!api) return;
    apiRef.current = api;
    geometryRef.current = geometry;
    api.updateScene({ elements: [...geometry, ...sketchRef.current], captureUpdate: CaptureUpdateAction.NEVER });
    if (initialized.current !== api) {
      initialized.current = api;
      requestAnimationFrame(() => api.scrollToContent([...geometry, ...sketchRef.current], {
        fitToViewport: true, viewportZoomFactor: 0.72, maxZoom: 1.1, animate: false,
      }));
    }
  }, [api, geometry]);

  useEffect(() => {
    if (!api) return;
    api.setActiveTool({ type: tool === "sketch" ? "freedraw" : "selection" });
  }, [api, tool]);

  useEffect(() => {
    if (savePaused) return;
    setSaveState("saving");
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(makeProject(plan, sketches)));
        setSavedSnapshot({ plan, sketches });
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        notify(`Could not save on this device: ${errorMessage(error)} Download your project to keep your work.`, true);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [plan, sketches, savePaused, notify]);

  // Flush the debounce when leaving so the latest small edits are not lost.
  useEffect(() => {
    const flush = () => {
      if (savePaused) return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(makeProject(planRef.current, sketchRef.current)));
        setSavedSnapshot({ plan: planRef.current, sketches: sketchRef.current });
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

  const onSceneChange = useCallback((elements: readonly ExcalidrawElement[], state: AppState) => {
    setView(current => current.scrollX === state.scrollX && current.scrollY === state.scrollY
      && current.zoom === state.zoom.value ? current
      : { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value });
    const unsupported = elements.some(e => !isPlanElement(e) && !e.isDeleted && !SUPPORTED_SKETCH_TYPES.has(e.type));
    const notes = elements.filter(e => !isPlanElement(e) && !e.isDeleted && SUPPORTED_SKETCH_TYPES.has(e.type));
    if (unsupported) notify("The sketch layer supports shapes, text, and freehand strokes, not images, frames, or embedded content.", true);
    // Excalidraw can unlock shapes; measured geometry is always owned by the plan.
    const measured = elements.filter(e => isPlanElement(e) && !e.isDeleted);
    if (apiRef.current && initialized.current === apiRef.current
      && (unsupported || measured.length !== geometryRef.current.length || measured.some((element, i) => {
        const source = geometryRef.current[i];
        return !source || element.id !== source.id || !element.locked
          || element.x !== source.x || element.y !== source.y || element.width !== source.width
          || element.height !== source.height || element.angle !== source.angle;
      }))) {
      queueMicrotask(() => apiRef.current?.updateScene({
        elements: [...geometryRef.current, ...sketchRef.current], captureUpdate: CaptureUpdateAction.NEVER,
      }));
    }
    if (getSceneVersion(notes) !== getSceneVersion(sketchRef.current)
      || notes.map(e => e.id).join() !== sketchRef.current.map(e => e.id).join()) {
      sketchRef.current = notes;
      setSketches(notes);
    }
  }, [notify]);

  const saveProject = useCallback(() => {
    const current = planRef.current;
    downloadFile(JSON.stringify(makeProject(current, sketchRef.current), null, 2), "application/json",
      `${current.name.replace(/[<>:"/\\|?*]/g, "-") || "My floor plan"}.homedraw.json`);
    notify("Project downloaded, including your sketch layer.");
  }, [notify]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.closest("input,textarea,select,[contenteditable=true]")
        || showHelp || pendingNew)) return;
      if (event.key === "Escape") {
        chooseTool("select");
        setSelection(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveProject();
        return;
      }
      if (tool === "sketch") return;
      if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.shiftKey || event.key.toLowerCase() === "y") redo(); else undo();
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const shortcut = tools.find(t => t.key.toLowerCase() === event.key.toLowerCase());
        if (shortcut) { event.preventDefault(); chooseTool(shortcut.id); }
        if (event.key.toLowerCase() === "h") chooseTool("hand");
        if (event.key.toLowerCase() === "s") chooseTool("sketch");
        if (["Delete", "Backspace"].includes(event.key) && selection) {
          event.preventDefault();
          if (selection.kind === "wall") commit(p => deleteWall(p, selection.id));
          else if (selection.kind === "angle") commit(p => deleteAngleDimension(p, selection.id));
          else if (selection.kind !== "room") commit(p => deleteOpening(p, selection.id));
          setSelection(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseTool, commit, pendingNew, redo, saveProject, selection, showHelp, tool, undo]);

  const fit = () => api?.scrollToContent([...geometryRef.current, ...sketchRef.current], {
    fitToViewport: true, viewportZoomFactor: 0.72, maxZoom: 1.5, animate: false,
  });
  const zoom = (factor: number, at?: Point) => {
    if (!api || !stage.current) return;
    const state = api.getAppState();
    const next = Math.min(3, Math.max(0.2, state.zoom.value * factor));
    const center = at ?? { x: stage.current.clientWidth / 2, y: stage.current.clientHeight / 2 };
    api.updateScene({ appState: {
      zoom: { value: next as AppState["zoom"]["value"] },
      scrollX: state.scrollX + center.x / next - center.x / state.zoom.value,
      scrollY: state.scrollY + center.y / next - center.y / state.zoom.value,
    }, captureUpdate: CaptureUpdateAction.NEVER });
  };
  const toWorld = (event: { clientX: number; clientY: number }): Point => {
    const bounds = stage.current!.getBoundingClientRect();
    const state = api!.getAppState();
    return {
      x: ((event.clientX - bounds.left) / state.zoom.value - state.scrollX) / SCALE,
      y: ((event.clientY - bounds.top) / state.zoom.value - state.scrollY) / SCALE,
    };
  };
  const snapped = (point: Point, altKey: boolean, shiftKey: boolean) => snapPoint(
    plan, point, snap && !altKey ? 50 : 0, snap && !altKey ? 12 / (SCALE * view.zoom) : 0,
    tool === "wall" ? origin ?? undefined : undefined,
    tool === "wall" && (orthogonal !== shiftKey),
  );
  const draftPoint = (point: Point, altKey: boolean, shiftKey: boolean) => {
    try {
      const next = snapped(point, altKey, shiftKey);
      setEditError(null);
      return next;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setEditError(error.message);
      return null;
    }
  };
  const screen = (point: Point) => ({
    x: (point.x * SCALE + view.scrollX) * view.zoom,
    y: (point.y * SCALE + view.scrollY) * view.zoom,
  });
  const deltaFor = (movement: GeometryDrag) => {
    const grid = snap ? 50 : 1;
    return {
      x: Math.round((movement.current.x - movement.start.x) / grid) * grid,
      y: Math.round((movement.current.y - movement.start.y) / grid) * grid,
    };
  };
  const geometryDragAt = (movement: GeometryDrag, current: Point, altKey: boolean, shiftKey: boolean): GeometryDrag => {
    const next = { ...movement, current };
    if (distance(movement.start, current) * SCALE * view.zoom <= 3) {
      return { ...next, preview: plan, error: null };
    }
    try {
      if (movement.kind === "angle") {
        const angle = plan.angleDimensions!.find(angle => angle.id === movement.id)!;
        const { axis } = anglePosition(plan, angle);
        const offset = draggedDimensionOffset(angle.radius, axis, movement.start, current);
        const radius = Math.abs(offset - angle.radius) * SCALE * view.zoom <= 3 ? angle.radius : Math.max(100, offset);
        if (radius === movement.preview.angleDimensions!.find(angle => angle.id === movement.id)!.radius) {
          return { ...next, error: null };
        }
        return { ...next, preview: updateAngleDimension(plan, angle.id, { radius }), error: null };
      }
      if (movement.kind === "node") {
        const node = plan.nodes.find(node => node.id === movement.id)!;
        const target = { x: node.x + current.x - movement.start.x, y: node.y + current.y - movement.start.y };
        const position = snapPoint(nodeSnapPlan, target, snap && !altKey ? 50 : 0,
          snap && !altKey ? 10 / (SCALE * view.zoom) : 0, shiftKey ? node : undefined, shiftKey);
        const previous = movement.preview.nodes.find(node => node.id === movement.id)!;
        if (position.x === previous.x && position.y === previous.y) return { ...next, error: null };
        return { ...next, preview: moveNode(plan, movement.id, position), error: null };
      }
      const delta = deltaFor(next);
      if (delta.x === 0 && delta.y === 0) return { ...next, preview: plan, error: null };
      const wall = plan.walls.find(wall => wall.id === movement.id)!;
      const start = plan.nodes.find(node => node.id === wall.a)!;
      const previous = movement.preview.nodes.find(node => node.id === wall.a)!;
      if (start.x + delta.x === previous.x && start.y + delta.y === previous.y) return { ...next, error: null };
      return { ...next, preview: moveWall(plan, movement.id, delta), error: null };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Only malformed or out-of-range input is blocked; spatial conflicts remain editable.
      return { ...next, error: error.message };
    }
  };
  const startNodeDrag = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    if (!api || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.ownerSVGElement!;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    setEditingDimension(null);
    setEditError(null);
    const connected = plan.walls.filter(wall => wall.a === nodeId || wall.b === nodeId);
    const wall = connected.find(wall => selection?.kind === "wall" && wall.id === selection.id) ?? connected[0];
    setSelection({ kind: "wall", id: wall.id });
    const start = toWorld(event);
    setDrag({ kind: "node", id: nodeId, start, current: start, preview: plan, error: null });
  };
  const startDimensionDrag = (event: ReactPointerEvent<SVGElement>, wallId: string) => {
    if (event.button !== 0 || !api) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setEditingDimension(null);
    setEditError(null);
    setSelection({ kind: "wall", id: wallId });
    const wall = plan.walls.find(w => w.id === wallId)!;
    const { axis, offset } = dimensionPosition(plan, wall);
    dimensionWasDragged.current = false;
    setDrag({ kind: "dimension", id: wallId, start: toWorld(event), axis, initialOffset: offset, offset });
  };
  const startAngleDrag = (event: ReactPointerEvent<SVGElement>, angleId: string) => {
    if (!api || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.ownerSVGElement!;
    canvas.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    setEditingDimension(null);
    setEditError(null);
    setSelection({ kind: "angle", id: angleId });
    angleWasDragged.current = false;
    const start = toWorld(event);
    setDrag({ kind: "angle", id: angleId, start, current: start, preview: plan, error: null });
  };
  const dimensionOffsetAt = (movement: Extract<Drag, { kind: "dimension" }>, point: Point) => {
    const offset = draggedDimensionOffset(movement.initialOffset, movement.axis, movement.start, point);
    return Math.abs(offset - movement.initialOffset) * SCALE * view.zoom > 3 ? offset : movement.initialOffset;
  };
  const finishDimensionDrag = (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    previewFrame.cancel();
    const movement = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (movement?.kind !== "dimension") return;
    const offset = dimensionOffsetAt(movement, toWorld(event));
    dimensionWasDragged.current = offset !== movement.initialOffset;
    if (dimensionWasDragged.current) commit(current => setDimensionOffset(current, movement.id, offset));
    setDrag(null);
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!api || (event.button !== 0 && event.button !== 1)) return;
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
      const point = toWorld(event);
      const hit = hitTest(plan, point, 12 / (SCALE * view.zoom), showDimensions);
      setSelection(hit);
      if (hit?.kind === "wall" && nearestWall(plan, point, 12 / (SCALE * view.zoom))?.wall.id === hit.id) {
        setEditingDimension(null);
        setDrag({ kind: "wall", id: hit.id, start: point, current: point, preview: plan, error: null });
      }
    }
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!api) return;
    if (!dragRef.current && !["wall", "room", "angle"].includes(tool)) return;
    const { clientX, clientY, altKey, shiftKey } = event;
    previewFrame.schedule(() => {
      const movement = dragRef.current;
      if (movement?.kind === "pan") {
        api.updateScene({ appState: {
          scrollX: movement.scrollX + (clientX - movement.client.x) / view.zoom,
          scrollY: movement.scrollY + (clientY - movement.client.y) / view.zoom,
        }, captureUpdate: CaptureUpdateAction.NEVER });
        return;
      }
      const point = toWorld({ clientX, clientY });
      if (movement?.kind === "dimension") {
        const offset = dimensionOffsetAt(movement, point);
        if (offset !== movement.offset) setDrag({ ...movement, offset });
      } else if (isGeometryDrag(movement)) {
        const next = geometryDragAt(movement, point, altKey, shiftKey);
        if (next.preview !== movement.preview || next.error !== movement.error) setDrag(next);
      } else {
        const next = tool === "angle" ? point : draftPoint(point, altKey, shiftKey) ?? point;
        setPointer(previous => previous?.x === next.x && previous.y === next.y ? previous : next);
      }
    });
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!api) return;
    previewFrame.cancel();
    const movement = dragRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (movement) {
      if (isGeometryDrag(movement)) {
        const final = geometryDragAt(movement, toWorld(event), event.altKey, event.shiftKey);
        if (movement.kind === "angle") angleWasDragged.current = final.preview !== plan || !!final.error;
        if (final.error) setEditError(final.error);
        else if (final.preview !== plan) commit(() => final.preview);
      } else if (movement.kind === "pan") {
        api.updateScene({ appState: {
          scrollX: movement.scrollX + (event.clientX - movement.client.x) / view.zoom,
          scrollY: movement.scrollY + (event.clientY - movement.client.y) / view.zoom,
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
    const point = draftPoint(raw, event.altKey, event.shiftKey);
    if (!point) return;
    if (tool === "wall" || tool === "room") {
      if (!origin) { setOrigin(point); setPointer(point); return; }
      const joinsExisting = plan.nodes.some(node => distance(node, point) < 1);
      const success = commit(p => tool === "room" ? addRoom(p, origin, point, thickness) : addWall(p, origin, point, thickness));
      if (success) {
        setOrigin(tool === "room" || joinsExisting ? null : point);
        setSelection(null);
      }
    } else {
      const hit = nearestWall(plan, raw, 18 / (SCALE * view.zoom));
      if (!hit) { setEditError("Click directly on a wall to place an opening or dimension."); return; }
      if (tool === "dimension") {
        setShowDimensions(true);
        commit(p => toggleDimension(p, hit.wall.id));
        setSelection({ kind: "wall", id: hit.wall.id });
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
    planRef.current = next.plan;
    sketchRef.current = next.sketches;
    setPlan(next.plan);
    setSketches(next.sketches);
    setPast([]);
    setFuture([]);
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
      if ((plan.walls.length || sketches.length) && !window.confirm("Open this project? Download the current project first if you want to keep it.")) return;
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
      const options = {
        elements: [...planToElements(planRef.current, showDimensions), ...sketchRef.current], files: api.getFiles(),
        appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: PAPER, exportWithDarkMode: false },
        exportPadding: 50,
      };
      const content = format === "svg"
        ? (await exportToSvg(options)).outerHTML
        : await exportToBlob({ ...options, mimeType: "image/png", maxWidthOrHeight: 3200 });
      downloadFile(content, format === "svg" ? "image/svg+xml" : "image/png", `${plan.name}.${format}`);
      notify(`${format.toUpperCase()} exported. Use the labeled dimensions; the image is not print-to-scale.`);
    } catch (error) {
      notify(`Export failed: ${errorMessage(error)}`, true);
    } finally {
      setExporting(false);
    }
  };

  const selectedWall = selection?.kind === "wall" ? displayPlan.walls.find(w => w.id === selection.id) : undefined;
  const editingWall = editingDimension?.kind === "wall" ? plan.walls.find(wall => wall.id === editingDimension.id) : undefined;
  const editingAngle = editingDimension?.kind === "angle"
    ? plan.angleDimensions?.find(angle => angle.id === editingDimension.id && hasAngleGeometry(plan, angle)) : undefined;
  const editingLabel = editingDimension?.kind === "angle"
    ? angleLabels.find(label => label.id === `plan-angle-label-${editingDimension.id}`)
    : dimensionLabels.find(label => label.id === `plan-dim-label-${editingDimension?.id}`);
  const beginDimensionEdit = (wallId: string) => {
    chooseTool("select");
    setSelection({ kind: "wall", id: wallId });
    setEditingDimension({ kind: "wall", id: wallId });
  };
  const beginAngleEdit = (angleId: string) => {
    chooseTool("select");
    setSelection({ kind: "angle", id: angleId });
    setEditingDimension({ kind: "angle", id: angleId });
  };
  const selectedOpening = selection && ["door", "window"].includes(selection.kind) ? displayPlan.openings.find(o => o.id === selection.id) : undefined;
  const selectedRoom = selection?.kind === "room" ? rooms.find(r => r.id === selection.id) : undefined;
  const drawing = !!origin && !!pointer && (tool === "wall" || tool === "room");
  const toolHint = tool === "angle" && angleDraft
    ? angleDraft.wallB
      ? "Move inside or outside the corner to choose the measured angle, then click to place its arc. Esc cancels."
      : "Click a different wall sharing a junction with the highlighted wall. Esc cancels."
    : hints[tool];
  const unitLabel = plan.units === "metric" ? "Meters" : "Feet & inches";
  const displayedSaveState = savePaused || saveState === "error" ? "error"
    : savedSnapshot?.plan === plan && savedSnapshot.sketches === sketches ? "saved" : "saving";
  const saveLabel = displayedSaveState === "saved" ? "Saved on this device"
    : displayedSaveState === "saving" ? "Saving..." : "Not saved locally";
  const showDefaults = ["wall", "room", "door", "window"].includes(tool);
  const hasSelection = !!(selectedWall || selectedOpening || selectedRoom
    || selection?.kind === "angle" && displayPlan.angleDimensions?.some(angle => angle.id === selection.id));
  const inputFeedback = geometryDrag?.error ?? drawingFeedback?.error ?? editError;
  const editor = useMemo(() => <Excalidraw excalidrawAPI={setApi} onChange={onSceneChange}
    initialData={{ elements: initialElements, appState: { viewBackgroundColor: PAPER, currentItemStrokeColor: "#59664f", currentItemFontFamily: 5 } }}
    viewModeEnabled={tool !== "sketch"} zenModeEnabled={tool !== "sketch"} theme="light"
    handleKeyboardGlobally={false} autoFocus={false} aiEnabled={false}
    UIOptions={{ canvasActions: { clearCanvas: false, loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, changeViewBackgroundColor: false }, tools: { image: false } }}
    onPaste={(data) => {
      if (data.files?.length || data.elements?.some(e => ["image", "embeddable", "iframe", "frame", "magicframe"].includes(e.type))) {
        notify("The sketch layer supports shapes, text, and freehand strokes, not images or embedded content.", true);
        return false;
      }
      return true;
    }}>
    <MainMenu><MainMenu.DefaultItems.Help /></MainMenu>
  </Excalidraw>, [initialElements, onSceneChange, tool, notify]);

  return <div className={`app ${tool === "sketch" ? "is-sketch" : ""}`}>
    <header className="app-header">
      <div className="project-controls">
        <EditorPopover label="Project menu" trigger={<Menu size={18} />} className="project-menu">
          <div className="menu-heading">Homedraw</div>
          <button data-close-popover onClick={() => fileInput.current?.click()}><ArrowUpFromLine size={16} /> Open project</button>
          <button data-close-popover onClick={saveProject}><Save size={16} /> Save a copy <kbd>Ctrl+S</kbd></button>
          <button data-close-popover onClick={() => setPendingNew(true)}><Plus size={16} /> New plan</button>
          <div className="sidebar-divider" />
          <button data-close-popover onClick={() => setShowHelp(true)}><CircleHelp size={16} /> Quick guide & shortcuts</button>
          <a href="https://excalidraw.com" target="_blank" rel="noreferrer" className="powered-by">Built with Excalidraw</a>
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
          <div className="plan-summary"><div><span>Enclosed area</span><strong>{formatArea(rooms.reduce((sum, r) => sum + r.area, 0), plan.units)}</strong></div>
            <div><span>Rooms</span><strong>{rooms.length}</strong></div>
          </div>
          <p className="summary-meta">{plan.walls.length} walls · {plan.openings.filter(o => o.kind === "door").length} doors · {plan.openings.filter(o => o.kind === "window").length} windows</p>
          <div className="sidebar-divider" />
          <div className="room-list">{rooms.length ? rooms.map((room, i) =>
            <button key={room.id} data-close-popover className={selection?.id === room.id ? "selected" : ""} onClick={() => {
              setSelection({ kind: "room", id: room.id }); chooseTool("select");
            }}><span className={`room-dot color-${i % 4}`} /><span>{room.name}<small>{formatArea(room.area, plan.units)}</small></span><ChevronDown size={13} /></button>,
          ) : <p className="helper">Draw a closed wall boundary to create a room.</p>}</div>
          <p className="helper">Areas and dimensions use wall centerlines. Verify measurements on site.</p>
        </EditorPopover>
        <EditorPopover label="Drawing settings" trigger={<Settings2 size={18} />} className="settings-menu">
          <div className="menu-heading">Drawing settings</div>
          <label className="field"><span>Measurement units</span><select aria-label="Measurement units" value={plan.units}
            onChange={event => commit(p => ({ ...p, units: event.target.value === "metric" ? "metric" : "imperial" }))}>
            <option value="metric">Metric (m / cm / mm)</option><option value="imperial">Imperial (ft / in)</option>
          </select></label>
          <button className={`option-row ${snap ? "enabled" : ""}`} aria-pressed={snap} onClick={() => setSnap(!snap)}><Magnet size={16} /> Snap to geometry <span className="switch" /></button>
          <button className={`option-row ${orthogonal ? "enabled" : ""}`} aria-pressed={orthogonal} onClick={() => setOrthogonal(!orthogonal)}><Scan size={16} /> Straight walls <span className="switch" /></button>
          <p className="helper">Shift toggles straight walls. Alt bypasses snapping.</p>
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

    <nav className="tool-toolbar" aria-label="Drawing tools">
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
      <button className={`tool-button ${tool === "sketch" ? "active" : ""}`} onClick={() => chooseTool("sketch")}
        aria-label="Sketch & annotate" title="Sketch & annotate (S)" aria-pressed={tool === "sketch"}><Pencil size={19} /><kbd>S</kbd></button>
    </nav>

    <div className="workspace">
      <main className="drawing-area">
        <div className={`canvas-stage ${tool === "sketch" ? "sketch-mode" : "draft-mode"}`} ref={stage}>
          {editor}
          {showGrid && tool !== "sketch" && <div className="grid-layer" style={{
            backgroundSize: `${50 * SCALE * view.zoom}px ${50 * SCALE * view.zoom}px`,
            backgroundPosition: `${view.scrollX * view.zoom}px ${view.scrollY * view.zoom}px`,
            opacity: view.zoom < 0.5 ? 0.22 : 0.45,
          }} />}
          {tool !== "sketch" && <svg className={`interaction-layer tool-${tool}`} aria-label="Floor plan canvas" data-testid="draft-canvas" tabIndex={-1}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerCancel={() => { setDrag(null); setOrigin(null); setAngleDraft(null); }}
            onLostPointerCapture={() => setDrag(null)}
            onPointerLeave={() => { if (!dragRef.current && !origin && !angleDraft) { previewFrame.cancel(); setPointer(null); } }}
            onContextMenu={event => { event.preventDefault(); previewFrame.cancel(); setOrigin(null); setAngleDraft(null); }}
            onWheel={event => {
              event.preventDefault();
              const rect = stage.current!.getBoundingClientRect();
              zoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top });
            }}>
            <g transform={`translate(${view.scrollX * view.zoom}, ${view.scrollY * view.zoom}) scale(${SCALE * view.zoom})`}>
              {selectedRoom && <polygon points={selectedRoom.points.map(p => `${p.x},${p.y}`).join(" ")} className="selected-room" />}
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
                const wallId = label.id.slice("plan-dim-label-".length);
                const padding = 5 / (SCALE * view.zoom);
                const wall = displayPlan.walls.find(w => w.id === wallId)!;
                const dim = dimensionPosition(displayPlan, dimensionPreview?.id === wallId
                  ? { ...wall, dimensionOffset: dimensionPreview.offset } : wall);
                const cursor = Math.abs(dim.axis.x) < 0.15 ? "ns-resize" : Math.abs(dim.axis.y) < 0.15 ? "ew-resize"
                  : dim.axis.x * dim.axis.y > 0 ? "nwse-resize" : "nesw-resize";
                return <g key={wallId} style={{ cursor }} className={drag?.kind === "dimension" && drag.id === wallId ? "dimension-dragging" : ""}>
                  <line data-testid={`dimension-line-${wallId}`} className="dimension-line-target"
                    x1={dim.a.x} y1={dim.a.y} x2={dim.b.x} y2={dim.b.y}
                    onPointerDown={event => startDimensionDrag(event, wallId)}
                    onPointerUp={finishDimensionDrag}>
                    <title>Drag to move this measurement inward or outward</title>
                  </line>
                  <rect data-testid={`dimension-${wallId}`} className="dimension-hit-target"
                  x={label.x / SCALE - padding} y={label.y / SCALE - padding}
                  width={label.width / SCALE + padding * 2} height={label.height / SCALE + padding * 2}
                  role="button" tabIndex={0} aria-label={`Edit measurement ${label.text}`}
                  onPointerDown={event => startDimensionDrag(event, wallId)}
                  onPointerUp={finishDimensionDrag}
                  onDoubleClick={event => {
                    event.stopPropagation();
                    if (!dimensionWasDragged.current) beginDimensionEdit(wallId);
                  }}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault(); event.stopPropagation(); beginDimensionEdit(wallId);
                    }
                  }}>
                  <title>Drag inward or outward to reposition. Double-click to edit the value.</title>
                </rect></g>;
              })}
              {angleLabels.map(label => {
                const angleId = label.id.slice("plan-angle-label-".length);
                const dimension = renderPlan.angleDimensions!.find(angle => angle.id === angleId)!;
                const angle = anglePosition(renderPlan, dimension);
                const padding = 5 / (SCALE * view.zoom);
                const interactive = tool === "select" && angleId !== ANGLE_PREVIEW_ID;
                return <g key={angleId} className={`angle-control ${selection?.kind === "angle" && selection.id === angleId ? "selected" : ""}`}
                  style={{ pointerEvents: interactive ? undefined : "none" }}>
                  <polyline data-testid={`angle-arc-${angleId}`} className="angle-arc-target"
                    points={angle.arc.map(point => `${point.x},${point.y}`).join(" ")}
                    style={{ pointerEvents: interactive ? "stroke" : "none" }}
                    onPointerDown={interactive ? event => startAngleDrag(event, angleId) : undefined} />
                  <rect data-testid={`angle-${angleId}`} className="dimension-hit-target"
                    x={label.x / SCALE - padding} y={label.y / SCALE - padding}
                    width={label.width / SCALE + padding * 2} height={label.height / SCALE + padding * 2}
                    role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined}
                    aria-label={`Angle measurement ${label.text}`}
                    onPointerDown={interactive ? event => startAngleDrag(event, angleId) : undefined}
                    onDoubleClick={interactive ? event => {
                      event.stopPropagation();
                      if (!angleWasDragged.current) beginAngleEdit(angleId);
                    } : undefined}
                    onKeyDown={event => {
                      if (interactive && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault(); event.stopPropagation();
                        beginAngleEdit(angleId);
                      }
                    }}>
                    <title>Drag inward or outward to reposition. Double-click to edit the angle.</title>
                  </rect>
                </g>;
              })}
              {tool === "select" && displayPlan.nodes.map(node => {
                const selected = selectedWall?.a === node.id || selectedWall?.b === node.id;
                return <g key={node.id} className={`node-control ${selected ? "selected" : ""} ${nodeDragId === node.id ? "dragging" : ""}`}
                  onPointerDown={event => startNodeDrag(event, node.id)}>
                  <circle data-testid={`node-${node.id}`} aria-label="Drag wall junction"
                    cx={node.x} cy={node.y} r={100 / view.zoom} className="node-hit-target">
                    <title>Drag this junction to reshape connected walls. Shift locks an axis; Alt bypasses snapping.</title>
                  </circle>
                  <circle cx={node.x} cy={node.y} r={45 / view.zoom} className="node-handle" />
                </g>;
              })}
            </g>
          </svg>}
          {(editingWall || editingAngle) && editingLabel && tool === "select" && <InlineDimensionEditor key={editingWall?.id ?? editingAngle!.id}
            value={editingAngle ? anglePosition(plan, editingAngle).degrees : distance(...wallPoints(plan, editingWall!))}
            formatValue={editingAngle ? formatAngleInput : value => plan.units === "metric"
              ? `${Number((value / 1000).toFixed(4))} m` : formatLength(value, plan.units)}
            parseValue={editingAngle ? parseAngle : text => parseLength(text, plan.units)}
            label={editingAngle ? "Edit angle" : "Edit dimension"} quantity={editingAngle ? "angle" : "length"}
            tolerance={editingAngle ? 1e-7 : 0.01}
            hint={editingAngle ? "First wall fixed; second wall rotates" : undefined}
            position={{
              x: Math.max(85, Math.min((stage.current?.clientWidth ?? Infinity) - 85,
                (editingLabel.x + editingLabel.width / 2 + view.scrollX) * view.zoom)),
              y: Math.max(22, Math.min((stage.current?.clientHeight ?? Infinity) - 40,
                (editingLabel.y + editingLabel.height / 2 + view.scrollY) * view.zoom)),
            }}
            onApply={value => commit(current => editingAngle
              ? resizeAngle(current, editingAngle.id, value) : resizeWall(current, editingWall!.id, value))}
            onClose={() => setEditingDimension(null)} />}
          {drawing && <div className="live-measure" style={{ left: screen(pointer).x + 18, top: screen(pointer).y + 18 }}>
            {tool === "room"
              ? `${formatLength(Math.abs(pointer.x - origin.x), plan.units)} × ${formatLength(Math.abs(pointer.y - origin.y), plan.units)}`
              : formatLength(distance(origin, pointer), plan.units)}
          </div>}
          {plan.walls.length === 0 && tool === "select" && <div className="canvas-welcome">
            <h1>Start your floor plan</h1>
            <p>Draw a room, or connect walls with the Wall tool.</p>
            <button className="primary-button" onClick={() => chooseTool("room")}><Plus size={16} /> Draw your first room</button>
            <button className="text-button" onClick={() => replaceProject(makeProject(createDemoPlan(), []))}>Explore an example instead</button>
          </div>}
          {tool === "sketch" && <button className="exit-sketch primary-button" onClick={() => chooseTool("select")}><Check size={16} /> Done sketching</button>}
          {tool !== "sketch" && <div className="canvas-controls">
            <div className="control-group"><button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}><Undo2 size={17} /></button>
              <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!future.length} onClick={redo}><Redo2 size={17} /></button></div>
            <div className="control-group zoom-controls"><button aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={16} /></button>
              <span>{Math.round(view.zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => zoom(1.2)}><Plus size={16} /></button>
              <button aria-label="Fit plan" title="Fit plan to view" onClick={fit}><Maximize size={15} /></button></div>
          </div>}
          {message && <div className={`toast ${message.error ? "error" : ""}`} role={message.error ? "alert" : "status"}>
            <span>{message.text}</span><button aria-label="Dismiss message" onClick={() => setMessage(null)}><X size={15} /></button>
          </div>}
        </div>
        <footer className="status-bar"><span className="tool-hint">{toolHint}</span>
          <span className="status-units">{unitLabel}<span className="status-separator">|</span>{snap ? "50 mm snap" : "Free placement"}</span>
          <button className="icon-button help-button" title="Quick guide" aria-label="Quick guide" onClick={() => setShowHelp(true)}><CircleHelp size={18} /></button>
        </footer>
      </main>

      {(showDefaults || hasSelection || feedbackIssues.length > 0 || inputFeedback) && <aside className="floating-inspector" aria-label="Properties">
        {showDefaults ? <>
          <div className="section-heading"><span>{tool === "door" ? "Door" : tool === "window" ? "Window" : tool === "room" ? "Room" : "Wall"}</span><span className="subtle">Defaults</span></div>
          {tool === "door" ? <LengthField label="New door width" value={doorWidth} units={plan.units} onApply={setDoorWidth} />
            : tool === "window" ? <LengthField label="New window width" value={windowWidth} units={plan.units} onApply={setWindowWidth} />
            : <LengthField label="New wall thickness" value={thickness} units={plan.units} onApply={value => {
              if (value < 10 || value > 1000) { setEditError("Wall thickness must be between 10 mm and 1 m."); return false; }
              setThickness(value);
            }} />}
        </> : <Properties plan={displayPlan} selection={selection} commit={commit} clear={() => setSelection(null)} />}
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
    </div>
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
      <div className="guide-step"><span>1</span><div><strong>Draw the space</strong><p>Use Room (R) for a rectangle or Wall (W) for connected walls. Click to start and click to finish. Esc ends a wall chain.</p></div></div>
      <div className="guide-step"><span>2</span><div><strong>Make it measured</strong><p>Double-click a measurement to edit it right on the plan, or select a wall to use the inspector. Enter 4.2 m, 420 cm, or 12' 6". Enter applies; Esc cancels. A stays fixed; B moves. In Select mode, drag a circular junction handle to reshape connected walls live. Shift locks an axis; Alt bypasses snapping.</p></div></div>
      <div className="guide-step"><span>3</span><div><strong>Open up the possibilities</strong><p>Click a wall with Door (D) or Window (N). Add measurements with Dimension (M); drag their labels or lines inward or outward to make space. Add ideas with Sketch (S).</p></div></div>
      <div className="guide-step"><span>4</span><div><strong>Check the corners</strong><p>Use Angle (A): click two walls sharing a junction, then click to place the arc. Choose the inside or outside angle with the pointer. In Select mode, drag the arc or label to adjust its radius. Double-click the label to edit degrees: the first wall stays fixed and the second rotates, keeping its length. Enter applies; Esc cancels.</p></div></div>
      <p className="helper">Wheel to zoom · H to pan · Ctrl/Cmd+Z to undo · Ctrl/Cmd+S to download. Sketch mode has Excalidraw's own undo history. Sketches do not follow wall edits.</p>
      <div className="guide-note">A planning aid, not a construction drawing. Verify clearances and site measurements, and consult a qualified professional before structural work.</div>
      <button className="primary-button full" autoFocus onClick={() => setShowHelp(false)}>Got it</button>
    </section></div>}
  </div>;
}
