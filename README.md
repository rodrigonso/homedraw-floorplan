# Homedraw

A local-first, 2D floor-plan sketchbook for DIY renovation planning. Built with React, TypeScript, Vite, and the actual Excalidraw editor, with a separate millimeter-based geometry model.

## Run

Requires Node.js 22.12+ (Node.js 24 recommended).

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173`. Fonts are copied from the installed Excalidraw package and served locally; no account or backend is required. This project uses `package-lock.json`; the pre-existing `yarn.lock` is not used.

```sh
npm run build
npm run preview
npm test
npx playwright install chromium
npm run test:e2e
```

## Editor layout

The canvas fills the window, with an Excalidraw-style floating tool strip and compact zoom and undo controls. Hover a tool for its name and shortcut. Properties appear only for the current selection or drawing tool; opening them does not shift the canvas.

- **Project menu (top left):** open a project, save a copy, start a new plan, or read the quick guide. Edit the project name beside the menu; the adjacent status icon indicates local saving.
- **Plan details (house icon):** room list, enclosed areas, and object counts. Select a room here or directly on the canvas.
- **Drawing settings (sliders icon):** measurement system, preferred length units, snapping, straight walls, dimensions, and the optional dot grid. Snapping stays enabled even when the grid is hidden.
- **Export (top right):** editable project, SVG, or PNG.

On small screens, the tool strip sits below the project controls and properties use a compact, scrollable panel near the bottom. Sketch mode shows Excalidraw's native controls; Done sketching returns to the floor-plan tools.

The violet accent palette is defined in `src/theme.ts` and shared by UI controls, Excalidraw's native controls, canvas highlights, measurements, and image exports. Room fills use a soft accent tint, and area values use the matching accent text color. Warning geometry stays red, and saved sketch colors are preserved.

## The measured-room workflow

- **Room (R):** click two opposite corners to create a rectangular room.
- **Wall (W):** click a start point and successive endpoints to draw connected walls. Escape finishes the chain. Endpoints snap to existing corners, wall centerlines, and a 50 mm grid. Hold Shift to force horizontal or vertical drawing, even when **Straight walls** is off. Shift never disables that setting. Alt bypasses grid and geometry snapping.
- **Select (V):** double-click a dimension label to edit its length directly on the canvas. Enter or clicking away applies the change; Escape cancels. Malformed numeric input stays editable and displays an inline error. You can also select a wall to edit its length or thickness in the inspector. Drag a wall to preview the actual layout live: connected walls, corners, attached openings, dimensions, and room areas all update as you move. Release to save the move as one undo step; Escape cancels. Spatial conflicts are highlighted in red rather than blocking the edit or snapping back.
- **Box selection:** in Select mode, drag empty canvas (including room interiors) to select fully enclosed walls, nodes, openings, and visible angle and thickness measurements in either direction. Wall selections include their endpoints and attached annotations without counting them twice. Shift-drag adds to the selection; Shift-click toggles individual items. Ctrl/Cmd+A selects the plan's walls; text fields and Sketch mode retain their own shortcuts. Drag a selected item or the space inside the selection bounds to move the selection together. Shared nodes move only once; other connected walls follow. Hold Alt for free group movement, or Shift during a drag to lock an axis. Group moves do not combine nodes. Delete/Backspace or **Delete selected** removes the selection and dependent annotations without a dialog. Movement and deletion each save as one undo step; selecting alone does not change the project or history. Escape cancels a marquee and restores the previous selection; otherwise it clears selection and cancels any movement. Sketch mode retains Excalidraw's native selection.
- **Junctions:** in Select mode, drag a circular endpoint/corner handle to move just that node. All walls sharing the junction follow live; their other endpoints stay fixed. Nodes snap to the 50 mm grid and nonmoving geometry. Hold Alt for free placement or Shift before or during a drag to constrain movement horizontally/vertically from the starting position. Release saves one undo step; Escape cancels.
- **Shift constraints:** holding Shift constrains new wall endpoints, node moves, wall moves, group geometry moves, and panning to the nearest horizontal or vertical axis. Pressing or releasing Shift updates the preview immediately, even without moving the pointer; release coordinates and modifiers determine the final edit. It works with grid/geometry snapping disabled, and Shift+Alt keeps the axis lock without quantizing the distance. Shift-click still toggles selection, while Shift-dragging an item moves it rather than toggling it; Shift-dragging empty canvas still adds a selection box. Rooms already have right-angle corners. Doors/windows stay on their host walls, length dimensions stay perpendicular to their walls, and angle labels stay on their radial axes rather than changing measured angles. Sketch mode keeps Excalidraw's native Shift behavior.
- **Combine nodes:** with snapping enabled, drag a node onto another node. A violet ring highlights the snapped target. Release to combine them into one shared junction at the target's exact position; all attached walls follow, and the surviving node stays selected. Hold Alt or turn off **Snap to geometry** to keep nodes separate. Shift only allows combining with a target on the constrained axis. Openings and dimensions remain attached to surviving walls, angle vertices follow the combined junction, and surviving enclosed room names are retained. Walls directly between the two nodes disappear, along with their openings and dependent or ambiguous angle measurements. Duplicate walls remain editable with red warnings rather than silently losing their settings or openings. Combining applies without a dialog, saves with the project, and is one undo step together with the drag. Escape or canceling the drag leaves both nodes unchanged. Dropping on a wall interior does not split it; other overlaps, crossings, collapsed walls, and openings that no longer fit remain editable with red highlights.
- **Split a wall:** in Select mode, double-click a solid wall to insert a node on its centerline. The position snaps to 50 mm increments along the wall from endpoint A; hold Alt to bypass this snapping. Alternatively, select the wall and use **Add midpoint node** in its properties. The two segments share the new draggable node and inherit thickness, dimension visibility, and dimension offset. Existing angle measurements stay at their original corners, and enclosed room names and areas are retained. Openings keep their size, swing, and world position, attached to the segment containing their center; an opening straddling the new node remains intact and is highlighted as an overhang. Insertion does not merge unrelated coincident junctions. Each split is one undo step and is saved with the project.
- **Select and delete nodes:** click a junction to select it independently of its walls, then press Delete/Backspace or use **Delete node** in properties. Keyboard users can focus a node and press Enter/Space to select it. A node connecting two different neighboring endpoints is removed by joining its walls into one straight wall; the remaining endpoints stay fixed. Openings project onto that wall, keeping their widths, and door hinge/swing orientation is preserved when a host wall reverses. The joined wall keeps the first wall's thickness and dimension offset and shows a dimension if either segment did. Angles at the deleted node or made ambiguous by the join are removed; other attached angles follow the joined wall. Surviving enclosed rooms retain their names. Endpoints, branches, or duplicate-neighbor nodes remove their attached walls instead, including their openings and angle annotations. Deletions apply immediately without confirmation dialogs; node properties explain the impact. Deletion is one undo step, and deleting during a drag discards the uncommitted preview.
- **Door (D) / Window (N):** click a wall to insert an opening. Select an opening to edit its width and center position. Doors support reversing the swing side.
- **Dimension (M):** choose **Length** to toggle a wall's attached length dimension. In Select or Dimension mode, drag its label or dimension line perpendicular to the wall to adjust the spacing or move it to the other side. Extension lines follow while the measured length stays unchanged. Release to save the position, or Escape to cancel. Placement supports undo/redo and is preserved in project files and image exports. Dimensions remain attached when walls move or resize.
- **Thickness measurements:** choose **Dimension (M) > Thickness** and click a wall, or select a wall and use **Add thickness measurement**. CAD-style ticks measure face-to-face, with the value outside the narrow span for readability. Double-click the label (or focus it and press Enter) to edit wall thickness; both faces move equally while the centerline and nodes stay fixed. Drag the label or measurement line along the wall to reposition it, or enter an exact **Offset from wall end** in properties. Offsets run along A-to-B from endpoint B: positive values place the measurement beyond B, negative values place it before B. Shift retains this wall-local drag axis. Multiple callouts can share a wall; splitting and joining walls retain their stations, projecting onto the joined wall when necessary. Callouts follow host moves and resizes, support box/group selection, and save/export with the project. Delete removes only the selected callout; deleting its host also removes its callouts. Edits and drags are individually undoable, Escape cancels, and the **Dimensions** setting controls visibility.
- **Angle (A):** click two different walls sharing a junction, then click to place an angular measurement. A live arc previews the angle in degrees; move inside or outside the corner to choose the smaller or reflex angle. In Select mode, double-click its label to edit the angle inline, or use the Angle field in the inspector. Enter or clicking away applies; Escape cancels. The first wall selected during placement and the shared corner stay fixed; the second wall rotates without changing its length. Walls sharing its far endpoint follow. Wall crossings and openings that no longer fit are allowed and highlighted in red; malformed degree values still show inline errors. Drag the arc or label radially to reposition it, or enter an exact arc radius in the inspector. "Measure other side" switches the measured sector. Each applied edit, placement, or completed drag is one undo step. Select an angle and press Delete (or use the inspector) to remove it. Angles follow connected wall/node edits and wall splits, and are removed when a referenced wall is deleted. If a connected wall collapses, the angle is retained but marked unavailable until its junctions are moved apart. The Dimensions display toggle includes angles; edits do not establish persistent angle constraints.
- **Rooms:** closed boundaries are detected automatically. Select a room on the canvas or in Plan details to name it and see its area.
- **Sketch (S):** use Excalidraw's freehand, text, and shape tools for ideas and annotations on the same canvas. Done sketching or Escape returns to drafting.
- **Navigate:** mouse wheel zooms around the pointer; H selects the pan tool. Middle-button dragging also pans. Fit plan centers the drawing.
- **Undo/redo:** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, or the canvas controls. Sketch mode has Excalidraw's separate native history.

Choose **Drawing settings > Length units** to display metric lengths in **meters or centimeters**, or imperial lengths in **feet and inches or inches only**. This choice applies to dimension labels, thickness measurements, properties, inline editors, drawing previews, and image exports. Bare input uses the selected unit: `20 - 10` means 10 cm in centimeters mode or 10 inches in inches mode. Explicit units such as `4.2 m`, `420 cm`, `4200 mm`, `12' 6"`, and `6 1/2"` always override that default.

Each project remembers a separate length preference for metric and imperial, including when switching systems, reloading, or importing/exporting a project. Older projects default to meters and feet/inches. Changing units never resizes geometry; the model and 50 mm snap grid remain in millimeters. Room areas stay in square meters or square feet, regardless of the selected length unit.

Angle fields always use degrees, regardless of measurement units. Enter `90`, `112.5 deg`, or a value with a degree symbol. Values must be greater than 0 and less than 360.

All measurement editors, both inline and in properties, accept `+`, `-`, `*`, `/`, and parentheses. For example, `20' - 10'` gives `10'`, `4 m + 20 cm` gives `4.2 m`, `(150 mm + 50 mm) / 2` gives `100 mm`, and `180 deg - 90 deg` gives `90` degrees. Multiplication and division run before addition and subtraction. Bare additive values use the field's default units; bare multipliers and divisors are unitless. Keep units on individual measurements inside parentheses, and use parentheses around fractional divisors: `6 ft / (1/2)`. Feet/inches and mixed fractions such as `12' 6 1/2"` still work. Applying an expression stores the calculated measurement, not a persistent formula. Invalid expressions, division by zero, and results outside the field's normal limits remain errors; signed offset fields still allow zero and negative results.

## Saving and export

One current project is automatically saved in this browser's local storage. Export an **editable project** (`.homedraw.json`) to keep separate renovation options, transfer a drawing, or back up your work. Ctrl/Cmd+S downloads a project. Opening a file or starting a new plan replaces the current local project after confirmation.

Project files preserve the geometry, units, room names, length, thickness and angular dimensions, and sketch layer. Doors may include an optional `hingeAtEnd` flag to retain their hinge side after wall joins; older projects without it retain their original door behavior. SVG and PNG exports include visible committed dimensions and sketches, but **are not print-to-scale**. Images, frames, and embedded content are not supported in the sketch layer.

If storage is full or unavailable, the app displays an error instead of claiming the project is saved. Malformed saved data is not automatically overwritten; explicitly open a well-formed project or start a new plan to resume autosaving. Layouts with geometry warnings are saved and loaded normally, including project imports and undo/redo.

## Geometry feedback

Crossing or overlapping walls, coincident junctions, walls shorter than 1 mm, and overlapping or overhanging openings are allowed. Red overlays identify affected geometry while drawing and editing and remain after release. A compact warning in the contextual properties panel expands to explain the issues, without a bottom-of-canvas geometry toast. The warnings clear as the layout is repaired and are included in image exports. Crossings are not automatically joined at their interior intersection.

Collapsed walls use red junction markers instead of undefined outlines. Drag their endpoints apart to restore their direction before editing a length or placing an angle. Attached openings and angle measurements are retained. Room areas exclude conflicted boundaries rather than presenting them as valid enclosed rooms; unrelated valid rooms remain available.

Project structure is still checked strictly: missing references, duplicate identifiers, non-finite values, unsupported fields, coordinate limits, and invalid scalar inputs cannot be saved as geometry. Numeric/input errors appear inline or in the properties panel; storage, import, and export failures retain their separate notifications.

## Architecture and scope

`src/model.ts` is the source of truth: shared wall endpoints, wall thicknesses, attached openings, planar room detection, unit parsing, and import validation. `src/scene.ts` converts the exact geometry into locked, hand-drawn Excalidraw elements. Drafting interactions operate on the domain model, never on approximate rendered strokes.

Connected walls render with mitered corners and continuous outlines, including T-junctions and walls of different thicknesses. `src/wallGeometry.ts` joins the wall footprints and uses polygon union to remove internal seams in both the canvas and exported drawings. Very acute or short joins are beveled to avoid oversized spikes.

Wall outlines use `clipper-lib` with integer clipping on a 0.000001 mm rendering grid to keep nearly collinear miter edges numerically stable during node movement. Filled junction lobes are normalized before merging, and a 0.000002 mm expand/contract pass closes rounding cracks without leaving internal seams. Only the rendered outlines are adjusted; saved wall coordinates, fills, and measurements retain their original precision.

Live previews process the latest pointer position once per animation frame and skip equivalent snapped positions. Release always uses the final pointer event, while cancellation discards pending previews. A per-editor scene cache converts only changed shapes and preserves unchanged Excalidraw element objects, versions, and ordering metadata so their canvas caches remain reusable. Wall fills have stable wall/junction identities; removed shapes are evicted, font loading refreshes text measurements, and exports render the committed plan independently.

This is an **Excalidraw-based prototype, not a maintained fork of the entire upstream repository**. Keeping the renderer behind an adapter allows the floor-plan model to evolve independently.

Wall lengths, angles, and room areas use **wall centerlines**, not finished interior faces. Thickness dimensions measure between the two wall faces. Changing a wall's length keeps endpoint A fixed and moves B along the existing direction; neighboring walls follow their shared nodes. This is not a general CAD constraint solver, and neighboring right angles are not automatically preserved. Room names follow their boundary node identities; explicit wall splits retain enclosed room names, while other topology changes may create newly named rooms. Sketch annotations remain at their canvas coordinates rather than attaching to walls.

The current scope is a single 2D floor with geometric room detection, not nested room holes, multiple stories, 3D, furniture libraries, demolition layers, structural analysis, or construction documentation. Red geometry feedback is advisory, not a construction-safety assessment.

**This is a planning aid, not engineering or permit documentation. Verify measurements and clearances on site, and consult qualified professionals before structural work.**

Excalidraw is used under its MIT license. See the installed package and [upstream repository](https://github.com/excalidraw/excalidraw) for its license and attribution.
