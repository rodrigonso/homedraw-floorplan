import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Hand, MousePointer2, Pencil, Type } from "lucide-react";
import { CaptureUpdateAction, newElementWith, type CanvasApi } from "./DrawingCanvas";
import { isPlanElement } from "./scene";
import { palette } from "./theme";
import { DeleteButton, GroupActions } from "./SelectionActions";

const tools = [
  { type: "selection", name: "Select notes", key: "V", icon: MousePointer2 },
  { type: "hand", name: "Pan notes", key: "H", icon: Hand },
  { type: "freedraw", name: "Draw note", key: "P", icon: Pencil },
  { type: "text", name: "Text note", key: "T", icon: Type },
  { type: "arrow", name: "Arrow note", key: "A", icon: ArrowUpRight },
] as const;
const colors = [
  { value: palette.ink, name: "Graphite" },
  { value: palette.accent, name: "Violet" },
  { value: palette.warning, name: "Red" },
  { value: "#2f7d55", name: "Green" },
] as const;

export default function NotesControls({ api, onDone, onDelete, onGroup, canGroup = false, canUngroup = false, error }: {
  api: CanvasApi | null; onDone?: () => void; onDelete: () => void; onGroup?: (ungroup: boolean) => void;
  canGroup?: boolean; canUngroup?: boolean; error?: string | null;
}) {
  const [state, setState] = useState({ tool: "freedraw", color: String(palette.ink), selected: 0 });
  useEffect(() => {
    if (!api) return;
    const update = () => {
      const current = api.getAppState();
      const selected = api.getSceneElements().filter(element => current.selectedElementIds[element.id] && !isPlanElement(element));
      const color = selected.length && selected.every(element => element.strokeColor === selected[0].strokeColor)
        ? selected[0].strokeColor : current.currentItemStrokeColor;
      setState(previous => previous.tool === current.activeTool.type && previous.color === color && previous.selected === selected.length
        ? previous : { tool: current.activeTool.type, color, selected: selected.length });
    };
    update();
    return api.onChange(update);
  }, [api]);

  const changeColor = (color: string) => {
    if (!api) return;
    const current = api.getAppState();
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map(element =>
        !element.isDeleted && !isPlanElement(element) && current.selectedElementIds[element.id]
          ? newElementWith(element, { strokeColor: color }) : element),
      appState: { currentItemStrokeColor: color },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };
  return <>
    {onDone && <nav className="tool-toolbar notes-toolbar" aria-label="Notes tools">
      {tools.map(({ type, name, key, icon: Icon }) => <button key={type}
        className={`tool-button ${state.tool === type ? "active" : ""}`} aria-label={name} title={`${name} (${key})`}
        aria-pressed={state.tool === type} disabled={!api} onClick={() => api?.setActiveTool({ type })}>
        <Icon size={19} /><kbd>{key}</kbd>
      </button>)}
      <div className="toolbar-divider" />
      <button className="notes-done" onClick={onDone}><Check size={17} /> Done notes</button>
    </nav>}
    <aside className="floating-inspector notes-inspector" aria-label={onDone ? "Notes properties" : "Text properties"}>
      <div className="section-heading"><span>{onDone ? "Renovation notes" : "Text"}</span>{state.selected > 0 && <span className="subtle">{state.selected} selected</span>}</div>
      <div className="note-colors" role="group" aria-label="Note color">
        {colors.map(color => <button key={color.value} style={{ backgroundColor: color.value }}
          aria-label={`${color.name} notes`} title={color.name} aria-pressed={state.color === color.value}
          className={state.color === color.value ? "selected" : ""} onClick={() => changeColor(color.value)} />)}
      </div>
      <p className="helper">{state.tool === "text"
        ? `Click anywhere to place text. Click away to finish, then use ${onDone ? "Select notes" : "Select"} to move or resize it. Double-click text to edit it.`
        : "Mark changes, add reminders, or point to work areas. Notes are visual annotations, not measured walls, and stay in place when the plan changes."}</p>
      {state.selected > 0 && <DeleteButton onDelete={onDelete}>Delete selected notes</DeleteButton>}
      {onGroup && state.selected > 1 && <GroupActions canGroup={canGroup} canUngroup={canUngroup} onChange={onGroup} />}
      {error && <p className="geometry-feedback" role="alert">{error}</p>}
    </aside>
  </>;
}
