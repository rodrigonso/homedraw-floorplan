import { useEffect, useState } from "react";
import { ArrowLeftRight, CirclePlus, Ruler } from "lucide-react";
import {
  detectRooms, distance, formatArea, formatLength, formatLengthInput, getNodeDeletionInfo, isWallDegenerate,
  parseAngle, parseLength, parsePosition, renameRoom, resizeAngle, resizeWall, setDimensionOffset, setWallThickness, splitWall, toggleDimension, updateAngleDimension, updateOpening, updateThicknessDimension, wallPoints,
  type MeasurementSettings, type Plan,
} from "./model";
import type { Selection } from "./scene";
import { anglePosition, formatAngle, formatAngleInput, hasAngleGeometry } from "./angles";
import { dimensionPosition } from "./dimensions";
import { DeleteButton } from "./SelectionActions";

type Commit = (change: (plan: Plan) => Plan) => boolean;

export function LengthField({ label, value, units, onApply, disabled = false, position = false }: {
  label: string; value: number; units: MeasurementSettings; onApply: (value: number) => boolean | void;
  disabled?: boolean;
  position?: boolean;
}) {
  const display = `${value < 0 ? "-" : ""}${formatLength(Math.abs(value), units)}`;
  return <MeasurementField label={label} value={value} onApply={onApply} disabled={disabled}
    formatted={formatLengthInput(value, units)}
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
        if (Math.abs(parsed - value) <= tolerance) setText(formatted);
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

export default function Properties({ plan, selection, commit, onDelete, onAddThickness }: {
  plan: Plan; selection: Selection; commit: Commit; onDelete: () => void;
  onAddThickness: (wallId: string) => void;
}) {
  const node = selection?.kind === "node" ? plan.nodes.find(node => node.id === selection.id) : undefined;
  const wall = selection?.kind === "wall" ? plan.walls.find(w => w.id === selection.id) : undefined;
  const opening = selection && ["door", "window"].includes(selection.kind)
    ? plan.openings.find(o => o.id === selection.id) : undefined;
  const room = selection?.kind === "room" ? detectRooms(plan).find(r => r.id === selection.id) : undefined;
  const angle = selection?.kind === "angle" ? plan.angleDimensions?.find(a => a.id === selection.id) : undefined;
  const thickness = selection?.kind === "thickness" ? plan.thicknessDimensions?.find(dimension => dimension.id === selection.id) : undefined;
  const length = selection?.kind === "dimension" ? plan.walls.find(wall => wall.id === selection.id && wall.dimension) : undefined;
  if (length) {
    const collapsed = isWallDegenerate(plan, length);
    return <>
      <div className="section-heading"><span>Length measurement</span></div>
      <LengthField label="Wall length" value={distance(...wallPoints(plan, length))} units={plan} disabled={collapsed}
        onApply={value => commit(p => resizeWall(p, length.id, value))} />
      {!collapsed && <LengthField label="Measurement offset" value={dimensionPosition(plan, length).offset} units={plan} position
        onApply={offset => commit(p => setDimensionOffset(p, length.id, offset))} />}
      <p className="helper">Drag the label to reposition it; double-click to edit the wall length. Delete removes only the measurement, not the wall or its openings.</p>
      {collapsed && <p className="helper geometry-feedback">Move the junctions apart to restore this measurement's direction.</p>}
      <DeleteButton onDelete={onDelete}>Delete measurement</DeleteButton>
    </>;
  }
  if (thickness) {
    const host = plan.walls.find(wall => wall.id === thickness.wallId)!;
    const collapsed = isWallDegenerate(plan, host);
    return <>
      <div className="section-heading"><span>Thickness measurement</span></div>
      <LengthField label="Wall thickness" value={host.thickness} units={plan}
        onApply={value => commit(p => setWallThickness(p, host.id, value))} />
      <LengthField label="Offset from wall end" value={thickness.offset} units={plan} position disabled={collapsed}
        onApply={offset => commit(p => updateThicknessDimension(p, thickness.id, { offset }))} />
      <p className="helper">Measures the two wall faces. Thickness changes equally on either side of the centerline. Drag the label along the wall to reposition it; negative offsets place it before endpoint B.</p>
      {collapsed && <p className="helper geometry-feedback">Move the junctions apart to restore this measurement's direction.</p>}
      <DeleteButton onDelete={onDelete}>Delete thickness measurement</DeleteButton>
    </>;
  }
  if (node) {
    const info = getNodeDeletionInfo(plan, node.id);
    return <>
      <div className="section-heading"><span>Node</span><span className="subtle">{info.wallCount} connected {info.wallCount === 1 ? "wall" : "walls"}</span></div>
      <p className="helper">Drag to reshape walls; drop on another node to combine them. Shift locks an axis; Alt keeps nodes separate. Delete or Backspace removes this node.</p>
      <p className="helper">{info.joinsWalls
        ? "Deleting this node joins its two walls. Openings follow the joined wall."
        : "Deleting this node removes its attached walls and their openings."}</p>
      {info.removedAngles > 0 && <p className="helper">{info.removedAngles} attached angle {info.removedAngles === 1 ? "measurement will" : "measurements will"} be removed.</p>}
      {info.removedThickness > 0 && <p className="helper">{info.removedThickness} thickness {info.removedThickness === 1 ? "measurement will" : "measurements will"} be removed.</p>}
      {info.changesStyle && <p className="helper">The joined wall keeps the first wall's thickness and dimension position.</p>}
      <DeleteButton onDelete={onDelete}>Delete node</DeleteButton>
    </>;
  }
  if (angle && !hasAngleGeometry(plan, angle)) return <>
    <div className="section-heading"><span>Angle measurement</span></div>
    <p className="helper geometry-feedback">This angle is undefined while a connected wall is collapsed. Drag its junctions apart to restore the measurement.</p>
    <DeleteButton onDelete={onDelete}>Delete angle measurement</DeleteButton>
  </>;
  if (angle) return <>
    <div className="section-heading"><span>Angle measurement</span></div>
    <div className="area-card"><span>Measured angle</span><strong data-testid="angle-value">{formatAngle(anglePosition(plan, angle).degrees)}</strong>
      <small>Between wall centerlines</small></div>
    <MeasurementField key={angle.id} label="Angle" value={anglePosition(plan, angle).degrees}
      formatted={formatAngleInput(anglePosition(plan, angle).degrees)} parse={parseAngle} tolerance={1e-7}
      onApply={degrees => commit(p => resizeAngle(p, angle.id, degrees))} />
    <LengthField label="Angle arc radius" value={angle.radius} units={plan}
      onApply={radius => commit(p => updateAngleDimension(p, angle.id, { radius }))} />
    <button className="secondary-button full" onClick={() =>
      commit(p => updateAngleDimension(p, angle.id, { clockwise: !angle.clockwise }))}>
      <ArrowLeftRight size={16} /> Measure other side
    </button>
    <details className="property-help"><summary>How angle edits work</summary><p>The first wall and shared corner stay fixed; the second wall rotates without changing its length. Connected walls follow. Double-click the label to edit, or drag the arc to reposition it.</p></details>
    <DeleteButton onDelete={onDelete}>Delete angle measurement</DeleteButton>
  </>;
  if (wall) {
    const [a, b] = wallPoints(plan, wall);
    const collapsed = isWallDegenerate(plan, wall);
    return <>
      <div className="section-heading"><span>Wall</span></div>
      <div className="wall-diagram"><span>A</span><div /><span>B</span></div>
      <LengthField label="Wall length" value={distance(a, b)} units={plan} disabled={collapsed}
        onApply={value => commit(p => resizeWall(p, wall.id, value))} />
      {collapsed && <p className="helper geometry-feedback">Drag either junction apart to give this wall a direction again.</p>}
      <LengthField label="Wall thickness" value={wall.thickness} units={plan}
        onApply={value => commit(p => setWallThickness(p, wall.id, value))} />
      <p className="helper">Length edits keep A fixed; B and connected walls follow. Thickness changes equally on both sides of the centerline.</p>
      <button className={`option-row ${wall.dimension ? "enabled" : ""}`}
        aria-pressed={wall.dimension}
        onClick={() => commit(p => toggleDimension(p, wall.id))}>
        <Ruler size={16} /> Attached dimension <span className="switch" />
      </button>
      <button className="secondary-button full" disabled={collapsed} onClick={() => onAddThickness(wall.id)}>
        <ArrowLeftRight size={16} /> Add thickness measurement
      </button>
      <button className="secondary-button full" disabled={collapsed}
        onClick={() => commit(p => splitWall(p, wall.id, distance(...wallPoints(p, wall)) / 2))}>
        <CirclePlus size={16} /> Add midpoint node
      </button>
      <DeleteButton onDelete={onDelete}>Delete wall</DeleteButton>
      <details className="property-help"><summary>About this wall</summary><p>Double-click a wall in Select mode to add a node at that position. Length uses the wall centerline. Deleting a wall also removes its openings, angles, and thickness measurements.</p></details>
    </>;
  }
  if (opening) return <>
    <div className="section-heading"><span>{opening.kind === "door" ? "Door" : "Window"}</span></div>
    <LengthField label="Opening width" value={opening.width} units={plan}
      onApply={value => commit(p => updateOpening(p, opening.id, { width: value }))} />
    <LengthField label="Position from wall start" value={opening.offset} units={plan} position
      onApply={value => commit(p => updateOpening(p, opening.id, { offset: value }))} />
    <p className="helper">Position is measured to the opening's center.</p>
    {opening.kind === "door" && <button className="secondary-button full" onClick={() =>
      commit(p => updateOpening(p, opening.id, { flip: !opening.flip }))}>
      <ArrowLeftRight size={16} /> Flip door swing
    </button>}
    <DeleteButton onDelete={onDelete}>Delete {opening.kind}</DeleteButton>
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
    <div className="area-card room-area"><span>Enclosed area</span><strong className="area-value">{formatArea(room.area, plan.units)}</strong>
      <small>Measured to wall centerlines</small></div>
    <p className="helper">Select a boundary wall to change the room's shape.</p>
  </>;
  return null;
}
