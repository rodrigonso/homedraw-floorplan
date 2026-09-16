import { describe, expect, it, vi } from "vitest";
import {
  addAngleDimension, addRoom, addThicknessDimension, createEmptyPlan, detectRooms,
  moveNode, renameRoom, setDimensionOffset,
} from "./model";
import { dimensionPosition } from "./dimensions";
import { planToElements, SCALE } from "./scene";
import type { PlanShape } from "./sceneCache";
import { palette } from "./theme";

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (shapes: PlanShape[]) => shapes,
}));

function measuredRoom() {
  let plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
  plan = addThicknessDimension(plan, plan.walls[0].id);
  plan = addAngleDimension(plan, {
    wallA: plan.walls[0].id, wallB: plan.walls[1].id,
    vertex: plan.walls[0].b, radius: 500, clockwise: false,
  });
  return plan;
}

describe("plan shape generation", () => {
  it("retains measurement label IDs, backgrounds, widths and order", () => {
    const plan = measuredRoom();
    const elements = planToElements(plan);
    for (const [kind, id, text, width] of [
      ["dim", plan.walls[0].id, "4 m", 48],
      ["thickness", plan.thicknessDimensions![0].id, "0.15 m", 56],
      ["angle", plan.angleDimensions![0].id, "90\u00b0", 40],
    ] as const) {
      const index = elements.findIndex(element => element.id === `plan-${kind}-bg-${id}`);
      expect(index).toBeGreaterThanOrEqual(0);
      const background = elements[index], label = elements[index + 1];
      expect(background).toMatchObject({
        type: "rectangle", width, height: 24, backgroundColor: "#ffffff",
        strokeColor: "transparent", fillStyle: "solid",
      });
      expect(label).toMatchObject({
        id: `plan-${kind}-label-${id}`, type: "text", text,
        fontSize: 14, textAlign: "center", strokeColor: palette.accentText,
      });
      expect(label.x).toBeCloseTo(background.x + width / 2);
      expect(label.y).toBeCloseTo(background.y + 2.5);
    }
  });

  it("renders the same extension and tick geometry used by selection, including previews", () => {
    const plan = measuredRoom(), wall = plan.walls[0], offset = -50;
    const elements = planToElements(plan, true, { id: wall.id, offset });
    const dim = dimensionPosition(plan, { ...wall, dimensionOffset: offset });
    const ids: string[] = [];
    dim.extensions.forEach((extension, i) => {
      for (const [kind, points] of [["ext", extension], ["tick", dim.ticks[i]]] as const) {
        const id = `plan-${kind}-${wall.id}-${i}`;
        ids.push(id);
        expect(elements.find(element => element.id === id)).toMatchObject({
          type: "line", x: points[0].x * SCALE, y: points[0].y * SCALE,
          points: points.map(point => [
            (point.x - points[0].x) * SCALE, (point.y - points[0].y) * SCALE,
          ]),
        });
      }
    });
    expect(elements.filter(element => ids.includes(element.id)).map(element => element.id)).toEqual(ids);
    expect(elements).toEqual(planToElements(setDimensionOffset(plan, wall.id, offset)));
  });

  it("preserves warning labels and room metadata without automatic room labels", () => {
    let plan = measuredRoom();
    const room = detectRooms(plan)[0];
    plan = renameRoom(plan, room.id, "Studio");
    expect(planToElements(plan).some(element => element.id === `plan-room-${room.id}`)).toBe(true);
    expect(planToElements(plan).some(element => element.type === "text" && element.text === "Studio")).toBe(false);
    expect(planToElements(plan, false).some(element => element.type === "text")).toBe(false);
    const wall = plan.walls[0], start = plan.nodes.find(node => node.id === wall.a)!;
    const collapsed = moveNode(plan, wall.b, start);
    const elements = planToElements(collapsed);
    for (const [id, text] of [
      [`warning-length-${wall.id}`, "0 m"],
      [`thickness-label-${plan.thicknessDimensions![0].id}`, "Thickness 0.15 m"],
      [`warning-angle-label-${plan.angleDimensions![0].id}`, "Angle unavailable"],
    ]) {
      expect(elements.find(element => element.id === `plan-${id}`)).toMatchObject({
        type: "text", text, strokeColor: palette.warning,
      });
    }
    expect(plan.roomNames[room.id]).toBe("Studio");
  });
});
