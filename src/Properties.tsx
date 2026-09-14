import { useEffect, useState } from "react";
import { ArrowLeftRight, Ruler, Trash2 } from "lucide-react";
import {
  deleteAngleDimension, deleteOpening, deleteWall, detectRooms, distance, formatArea, formatLength, isWallDegenerate,
  parseAngle, parseLength, parsePosition, renameRoom, resizeAngle, resizeWall, setWallThickness, toggleDimension, updateAngleDimension, updateOpening, wallPoints,
  type Plan,
} from "./model";
import type { Selection } from "./scene";
import { anglePosition, formatAngle, formatAngleInput, hasAngleGeometry } from "./angles";

export type Commit = (change: (plan: Plan) => Plan) => boolean;

export function LengthField({ label, value, units, onApply, disabled = false, position = false }: {
  label: string; value: number; units: Plan["units"]; onApply: (value: number) => boolean | void;
  disabled?: boolean;
  position?: boolean;
}) {
  const display = `${value < 0 ? "-" : ""}${formatLength(Math.abs(value), units)}`;
  return <MeasurementField label={label} value={value} onApply={onApply} disabled={disabled}
    formatted={units === "metric" ? `${Number((value / 1000).toFixed(4))} m` : display}
    resetText={display} parse={text => position ? parsePosition(text, units) : parseLength(text, units)} />;
}

function MeasurementField({ label, value, formatted, resetText = formatted, parse, tolerance = 0.01, onApply, disabled = false }: {
  label: string; value: number; formatted: string; resetText?: string;
  parse: (text: string) => number; tolerance?: number; onApply: (value: number) => boolean | void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    setText(formatted);
    setError("");
    setEdited(false);
  }, [value, formatted]);
  const apply = () => {
    if (!edited) return;
    try {
      const parsed = parse(text);
      setError("");
      if (Math.abs(parsed - value) > tolerance && onApply(parsed) === false) {
        setError("Change not applied. See the error below.");
      } else {
        setEdited(false);
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setError(error.message);
    }
  };
  return <label className="field">
    <span>{label}</span>
    <input aria-label={label} disabled={disabled} value={text} onChange={event => { setText(event.target.value); setEdited(true); }}
      onBlur={apply} onKeyDown={event => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setText(resetText);
          setError("");
          setEdited(false);
        }
      }} aria-invalid={!!error} spellCheck={false} />
    {error && <small className="field-error" role="alert">{error}</small>}
  </label>;
}

export default function Properties({ plan, selection, commit, clear }: {
  plan: Plan; selection: Selection; commit: Commit; clear: () => void;
}) {
  const wall = selection?.kind === "wall" ? plan.walls.find(w => w.id === selection.id) : undefined;
  const opening = selection && ["door", "window"].includes(selection.kind)
    ? plan.openings.find(o => o.id === selection.id) : undefined;
  const room = selection?.kind === "room" ? detectRooms(plan).find(r => r.id === selection.id) : undefined;
  const angle = selection?.kind === "angle" ? plan.angleDimensions?.find(a => a.id === selection.id) : undefined;
  if (angle && !hasAngleGeometry(plan, angle)) return <>
    <div className="section-heading"><span>Angle measurement</span></div>
    <p className="helper geometry-feedback">This angle is undefined while a connected wall is collapsed. Drag its junctions apart to restore the measurement.</p>
    <button className="danger-button" onClick={() => {
      if (commit(p => deleteAngleDimension(p, angle.id))) clear();
    }}><Trash2 size={15} /> Delete angle measurement</button>
  </>;
  if (angle) return <>
    <div className="section-heading"><span>Angle measurement</span></div>
    <div className="area-card"><span>Measured angle</span><strong data-testid="angle-value">{formatAngle(anglePosition(plan, angle).degrees)}</strong>
      <small>Between wall centerlines</small></div>
    <MeasurementField key={angle.id} label="Angle" value={anglePosition(plan, angle).degrees}
      formatted={formatAngleInput(anglePosition(plan, angle).degrees)} parse={parseAngle} tolerance={1e-7}
      onApply={degrees => commit(p => resizeAngle(p, angle.id, degrees))} />
    <LengthField label="Angle arc radius" value={angle.radius} units={plan.units}
      onApply={radius => commit(p => updateAngleDimension(p, angle.id, { radius }))} />
    <button className="secondary-button full" onClick={() =>
      commit(p => updateAngleDimension(p, angle.id, { clockwise: !angle.clockwise }))}>
      <ArrowLeftRight size={16} /> Measure other side
    </button>
    <details className="property-help"><summary>How angle edits work</summary><p>The first wall and shared corner stay fixed; the second wall rotates without changing its length. Connected walls follow. Double-click the label to edit, or drag the arc to reposition it.</p></details>
    <button className="danger-button" onClick={() => {
      if (commit(p => deleteAngleDimension(p, angle.id))) clear();
    }}><Trash2 size={15} /> Delete angle measurement</button>
  </>;
  if (wall) {
    const [a, b] = wallPoints(plan, wall);
    return <>
      <div className="section-heading"><span>Wall</span></div>
      <div className="wall-diagram"><span>A</span><div /><span>B</span></div>
      <LengthField label="Wall length" value={distance(a, b)} units={plan.units} disabled={isWallDegenerate(plan, wall)}
        onApply={value => commit(p => resizeWall(p, wall.id, value))} />
      {isWallDegenerate(plan, wall) && <p className="helper geometry-feedback">Drag either junction apart to give this wall a direction again.</p>}
      <LengthField label="Wall thickness" value={wall.thickness} units={plan.units}
        onApply={value => commit(p => setWallThickness(p, wall.id, value))} />
      <p className="helper">A stays fixed. B and connected walls follow.</p>
      <button className={`option-row ${wall.dimension ? "enabled" : ""}`}
        aria-pressed={wall.dimension}
        onClick={() => commit(p => toggleDimension(p, wall.id))}>
        <Ruler size={16} /> Attached dimension <span className="switch" />
      </button>
      <button className="danger-button" onClick={() => {
        if (commit(p => deleteWall(p, wall.id))) clear();
      }}><Trash2 size={15} /> Delete wall</button>
      <details className="property-help"><summary>About this wall</summary><p>Length uses the wall centerline. Deleting a wall also removes its openings and angle measurements.</p></details>
    </>;
  }
  if (opening) return <>
    <div className="section-heading"><span>{opening.kind === "door" ? "Door" : "Window"}</span></div>
    <LengthField label="Opening width" value={opening.width} units={plan.units}
      onApply={value => commit(p => updateOpening(p, opening.id, { width: value }))} />
    <LengthField label="Position from wall start" value={opening.offset} units={plan.units} position
      onApply={value => commit(p => updateOpening(p, opening.id, { offset: value }))} />
    <p className="helper">Position is measured to the opening's center.</p>
    {opening.kind === "door" && <button className="secondary-button full" onClick={() =>
      commit(p => updateOpening(p, opening.id, { flip: !opening.flip }))}>
      <ArrowLeftRight size={16} /> Flip door swing
    </button>}
    <button className="danger-button" onClick={() => {
      if (commit(p => deleteOpening(p, opening.id))) clear();
    }}><Trash2 size={15} /> Delete {opening.kind}</button>
  </>;
  if (room) return <>
    <div className="section-heading"><span>Room</span></div>
    <label className="field"><span>Room name</span>
      <input key={room.id + room.name} aria-label="Room name" defaultValue={room.name} maxLength={60}
        onBlur={event => {
          if (event.target.value !== room.name && !commit(p => renameRoom(p, room.id, event.target.value))) {
            event.target.value = room.name;
          }
        }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    </label>
    <div className="area-card"><span>Enclosed area</span><strong>{formatArea(room.area, plan.units)}</strong>
      <small>Measured to wall centerlines</small></div>
    <p className="helper">Select a boundary wall to change the room's shape.</p>
  </>;
  return null;
}
