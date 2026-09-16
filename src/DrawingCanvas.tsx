import { memo, useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, exportToBlob, exportToSvg, getCommonBounds,
} from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { SUPPORTED_NOTE_TYPES } from "./storage";
import { palette } from "./theme";
import { interactionClip, type HitBounds } from "./interactionClip";

export { CaptureUpdateAction, getSceneVersion, getCommonBounds, newElementWith } from "@excalidraw/excalidraw";
export type { AppState as CanvasState, ExcalidrawImperativeAPI as CanvasApi } from "@excalidraw/excalidraw/types";
export type { ExcalidrawElement as CanvasElement } from "@excalidraw/excalidraw/element/types";

const noteTools = new Set(["selection", "freedraw", "text", "arrow", "hand"]);
const canvasKeys = new Set([
  "v", "p", "t", "a", "h", " ", "Enter", "Escape", "Delete", "Backspace", "Tab",
  "Shift", "Control", "Meta", "Alt", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "=", "0",
]);
export const isEditableTarget = (target: EventTarget | null) => target instanceof HTMLElement
  && !!target.closest("input,textarea,select,[contenteditable=true]");

export function textInteractionClip(elements: readonly ExcalidrawElement[], state: AppState) {
  const bounds = (elements: readonly ExcalidrawElement[], padding: number): HitBounds => {
    const [left, top, right, bottom] = getCommonBounds(elements);
    const at = (value: number, scroll: number) => (value + scroll) * state.zoom.value;
    return [at(left, state.scrollX) - padding, at(top, state.scrollY) - padding,
      at(right, state.scrollX) + padding, at(bottom, state.scrollY) + padding];
  };
  const holes = elements.filter(element => element.type === "text").map(element => bounds([element], 4));
  const selected = elements.filter(element => state.selectedElementIds[element.id]);
  if (selected.length) holes.push(bounds(selected, 30));
  return interactionClip(state.width, state.height, holes);
}

export async function exportDrawing(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], format: "svg" | "png") {
  const options = {
    elements, files: api.getFiles(),
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
    exportPadding: 50,
  };
  return format === "svg" ? (await exportToSvg(options)).outerHTML
    : exportToBlob({ ...options, mimeType: "image/png", maxWidthOrHeight: 3200 });
}

type Props = {
  initialElements: readonly ExcalidrawElement[];
  onKeyDown: (event: KeyboardEvent) => boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onReady: (api: ExcalidrawImperativeAPI) => void;
  onChange: (elements: readonly ExcalidrawElement[], state: AppState) => void;
  onUnsupported: (message: string) => void;
};

export default memo(function DrawingCanvas({ initialElements, onKeyDown, onPointerDown, onReady, onChange, onUnsupported }: Props) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const ready = useCallback((instance: ExcalidrawImperativeAPI) => { api.current = instance; onReady(instance); }, [onReady]);
  const changed = useCallback((elements: readonly ExcalidrawElement[], state: AppState) => {
    onChange(elements, state);
    if (state.openDialog || state.openSidebar || state.contextMenu || state.showHyperlinkPopup
      || !noteTools.has(state.activeTool.type)) {
      queueMicrotask(() => {
        api.current?.updateScene({
          appState: { openDialog: null, openSidebar: null, openMenu: null, contextMenu: null, showHyperlinkPopup: false },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        if (!noteTools.has(state.activeTool.type)) api.current?.setActiveTool({ type: "selection" });
      });
    }
  }, [onChange]);
  return <div className="canvas-engine" onPointerDownCapture={onPointerDown}
    onContextMenuCapture={event => {
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }}
    onDropCapture={event => {
      event.preventDefault();
      event.stopPropagation();
      onUnsupported("Use Open project to load a Homedraw plan. Add renovation notes with the Notes tools.");
    }}
    onKeyDownCapture={event => {
      if (isEditableTarget(event.target)) return;
      if (onKeyDown(event.nativeEvent)) {
        event.stopPropagation();
        return;
      }
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const command = event.ctrlKey || event.metaKey;
      if (["F5", "F11", "F12"].includes(key) || command && ["r", "w", "t", "n", "l"].includes(key)) {
        event.stopPropagation();
        return;
      }
      const allowed = command ? ["c", "v", "x", "d", "+", "-", "=", "0"].includes(key)
        || key.startsWith("Arrow") : canvasKeys.has(key);
      if (!allowed) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
    <Excalidraw excalidrawAPI={ready} onChange={changed}
      initialData={{ elements: initialElements, appState: {
        viewBackgroundColor: "#ffffff", currentItemStrokeColor: palette.ink, currentItemFontFamily: 5,
        currentItemStrokeWidth: 2, currentItemStartArrowhead: null, currentItemEndArrowhead: "arrow",
      } }}
      viewModeEnabled={false} zenModeEnabled={false} theme="light"
      handleKeyboardGlobally={false} autoFocus={false} aiEnabled={false} validateEmbeddable={false}
      UIOptions={{ canvasActions: {
        clearCanvas: false, loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false,
        toggleTheme: false, changeViewBackgroundColor: false,
      }, tools: { image: false } }}
      onPaste={data => {
        if (data.files?.length || data.spreadsheet
          || data.elements?.some(element => !SUPPORTED_NOTE_TYPES.has(element.type))) {
          onUnsupported("Notes support text, arrows, and drawing marks. Images, diagrams, and embedded content are not supported.");
          return false;
        }
        return true;
      }}>
      <MainMenu><></></MainMenu>
      <WelcomeScreen><></></WelcomeScreen>
    </Excalidraw>
  </div>;
});
