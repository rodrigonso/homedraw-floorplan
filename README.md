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
- **Drawing settings (sliders icon):** measurement units, snapping, straight walls, dimensions, and the optional dot grid. Snapping stays enabled even when the grid is hidden.
- **Export (top right):** editable project, SVG, or PNG.

On small screens, the tool strip sits below the project controls and properties use a compact, scrollable panel near the bottom. Sketch mode shows Excalidraw's native controls; Done sketching returns to the floor-plan tools.

## The measured-room workflow

- **Room (R):** click two opposite corners to create a rectangular room.
- **Wall (W):** click a start point and successive endpoints to draw connected walls. Escape finishes the chain. Endpoints snap to existing corners, wall centerlines, and a 50 mm grid. Shift toggles orthogonal drawing; Alt bypasses snapping.
- **Select (V):** double-click a dimension label to edit its length directly on the canvas. Enter or clicking away applies the change; Escape cancels. Malformed numeric input stays editable and displays an inline error. You can also select a wall to edit its length or thickness in the inspector. Drag a wall to preview the actual layout live: connected walls, corners, attached openings, dimensions, and room areas all update as you move. Release to save the move as one undo step; Escape cancels. Spatial conflicts are highlighted in red rather than blocking the edit or snapping back.
- **Junctions:** in Select mode, drag a circular endpoint/corner handle to move just that node. All walls sharing the junction follow live; their other endpoints stay fixed. Nodes snap to the 50 mm grid and nonmoving geometry. Hold Alt for free placement or Shift to constrain movement horizontally/vertically from the starting position. Release saves one undo step; Escape cancels. Nodes are not automatically merged or walls split when dropped on other geometry: overlapping nodes, crossings, collapsed walls, and openings that no longer fit remain editable, with red highlights.
- **Door (D) / Window (N):** click a wall to insert an opening. Select an opening to edit its width and center position. Doors support reversing the swing side.
- **Dimension (M):** click a wall to toggle its attached dimension. In Select or Dimension mode, drag a measurement's label or dimension line inward or outward, perpendicular to its wall, to adjust the spacing or move it to the other side. Extension lines follow the drag while the measured length stays unchanged. Release to save the position, or Escape to cancel. Placement supports undo/redo and is preserved in project files and image exports. Dimensions remain attached when walls move or resize.
- **Angle (A):** click two different walls sharing a junction, then click to place an angular measurement. A live arc previews the angle in degrees; move inside or outside the corner to choose the smaller or reflex angle. In Select mode, double-click its label to edit the angle inline, or use the Angle field in the inspector. Enter or clicking away applies; Escape cancels. The first wall selected during placement and the shared corner stay fixed; the second wall rotates without changing its length. Walls sharing its far endpoint follow. Wall crossings and openings that no longer fit are allowed and highlighted in red; malformed degree values still show inline errors. Drag the arc or label radially to reposition it, or enter an exact arc radius in the inspector. "Measure other side" switches the measured sector. Each applied edit, placement, or completed drag is one undo step. Select an angle and press Delete (or use the inspector) to remove it. Angles follow connected wall/node edits and wall splits, and are removed when a referenced wall is deleted. If a connected wall collapses, the angle is retained but marked unavailable until its junctions are moved apart. The Dimensions display toggle includes angles; edits do not establish persistent angle constraints.
- **Rooms:** closed boundaries are detected automatically. Select a room on the canvas or in Plan details to name it and see its area.
- **Sketch (S):** use Excalidraw's freehand, text, and shape tools for ideas and annotations on the same canvas. Done sketching or Escape returns to drafting.
- **Navigate:** mouse wheel zooms around the pointer; H selects the pan tool. Middle-button dragging also pans. Fit plan centers the drawing.
- **Undo/redo:** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, or the canvas controls. Sketch mode has Excalidraw's separate native history.

Metric fields accept meters by default, or explicit units such as `4.2 m`, `420 cm`, and `4200 mm`. Imperial fields accept feet by default, plus feet/inches and fractions such as `12' 6"` and `6 1/2"`.

Angle fields always use degrees, regardless of measurement units. Enter `90`, `112.5 deg`, or a value with a degree symbol. Values must be greater than 0 and less than 360.

## Saving and export

One current project is automatically saved in this browser's local storage. Export an **editable project** (`.homedraw.json`) to keep separate renovation options, transfer a drawing, or back up your work. Ctrl/Cmd+S downloads a project. Opening a file or starting a new plan replaces the current local project after confirmation.

Project files preserve the geometry, units, room names, linear and angular dimensions, and sketch layer. SVG and PNG exports include visible committed dimensions and sketches, but **are not print-to-scale**. Images, frames, and embedded content are not supported in the sketch layer.

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

All dimensions and areas are measured to **wall centerlines**, not finished interior faces. Changing a wall's length keeps endpoint A fixed and moves B along the existing direction; neighboring walls follow their shared nodes. This is not a general CAD constraint solver, and neighboring right angles are not automatically preserved. Room names follow their boundary node identities; changing topology may create newly named rooms. Sketch annotations remain at their canvas coordinates rather than attaching to walls.

The current scope is a single 2D floor with geometric room detection, not nested room holes, multiple stories, 3D, furniture libraries, demolition layers, structural analysis, or construction documentation. Red geometry feedback is advisory, not a construction-safety assessment.

**This is a planning aid, not engineering or permit documentation. Verify measurements and clearances on site, and consult qualified professionals before structural work.**

Excalidraw is used under its MIT license. See the installed package and [upstream repository](https://github.com/excalidraw/excalidraw) for its license and attribution.
