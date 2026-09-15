import { expect, test, type Page } from "@playwright/test";
import type { Plan, Point } from "../src/model";

const fixture = (): Plan => ({
  version: 1, name: "Box selection", units: "metric", roomNames: {},
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 2000, y: 0 }, { id: "c", x: 2000, y: 2000 },
    { id: "d", x: 4000, y: 0 }, { id: "e", x: 6000, y: 0 },
  ],
  walls: [
    { id: "first", a: "a", b: "b", thickness: 150, dimension: false },
    { id: "second", a: "b", b: "c", thickness: 150, dimension: false },
    { id: "third", a: "d", b: "e", thickness: 150, dimension: false },
  ],
  openings: [{ id: "door", wallId: "first", kind: "door", offset: 1000, width: 500, flip: false }],
  angleDimensions: [{ id: "angle", wallA: "first", wallB: "second", vertex: "b", radius: 400, clockwise: false }],
});

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function load(page: Page, plan = fixture()) {
  await page.addInitScript(plan => {
    if (!localStorage.getItem("homedraw.project.v1")) localStorage.setItem("homedraw.project.v1",
      JSON.stringify({ format: "homedraw", version: 1, plan, sketches: [] }));
  }, plan);
  await page.goto("/");
  return savedPlan(page);
}

async function screen(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const p = new DOMPoint(point.x, point.y).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, point);
}

async function click(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.click(p.x, p.y);
}

async function drag(page: Page, start: Point, end: Point, release = true) {
  const a = await screen(page, start), b = await screen(page, end);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  if (release) await page.mouse.up();
}

const boxStart = { x: -300, y: -300 }, boxEnd = { x: 2300, y: 2300 };

for (const width of [1440, 390]) test(`box selection previews and moves connected walls together at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const original = await load(page);
  await drag(page, boxStart, boxEnd, false);
  await expect(page.getByTestId("selection-marquee")).toBeVisible();
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await expect(page.getByTestId("selected-wall-first")).toHaveCount(1);
  await expect(page.getByTestId("selected-wall-second")).toHaveCount(1);
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  await expect(page.getByTestId("selection-marquee")).toHaveCount(0);
  await expect(page.getByTestId("selection-bounds")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await drag(page, { x: 400, y: 0 }, { x: 900, y: 300 }, false);
  await expect(page.getByTestId("node-a")).toHaveAttribute("cx", "500");
  await expect(page.getByTestId("node-b")).toHaveAttribute("cx", "2500");
  await expect(page.getByTestId("node-c")).toHaveAttribute("cy", "2300");
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.slice(0, 3)).toEqual(original.nodes.slice(0, 3).map(node => ({ ...node, x: node.x + 500, y: node.y + 300 })));
  expect(moved.nodes.slice(3)).toEqual(original.nodes.slice(3));
  expect(moved.walls).toEqual(original.walls);
  expect(moved.openings).toEqual(original.openings);
  expect(moved.angleDimensions).toEqual(original.angleDimensions);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.reload();
  expect(await savedPlan(page)).toEqual(moved);
  expect(errors).toEqual([]);
});

for (const action of ["Delete", "Backspace", "button"]) test(`bulk deletion via ${action} removes dependencies in one undoable change without dialogs`, async ({ page }) => {
  const original = await load(page), dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await drag(page, boxEnd, boxStart);
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  if (action === "button") await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  else await page.keyboard.press(action);
  const deleted = await savedPlan(page);
  expect(deleted.walls).toEqual(original.walls.slice(2));
  expect(deleted.nodes).toEqual(original.nodes.slice(3));
  expect(deleted.openings).toEqual([]);
  expect(deleted.angleDimensions).toEqual([]);
  await expect(page.getByTestId("selection-bounds")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  expect(dialogs).toEqual([]);
});

test("Shift-click toggles members and Shift-box adds to the selection", async ({ page }) => {
  const original = await load(page);
  await click(page, { x: 400, y: 0 });
  await page.keyboard.down("Shift");
  await click(page, { x: 5000, y: 0 });
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await click(page, { x: 400, y: 0 });
  await expect(page.getByTestId("selection-count")).toHaveCount(0);
  await expect(page.locator(".selection-line")).toHaveAttribute("x1", "4000");
  await page.getByTestId("node-c").click();
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await page.getByTestId("node-c").click();
  await expect(page.getByTestId("selection-count")).toHaveCount(0);
  await drag(page, boxStart, boxEnd);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selection-bounds")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture"]) test(`${cancellation} restores the selection before the marquee and discards queued updates`, async ({ page }) => {
  const original = await load(page);
  await click(page, { x: 5000, y: 0 });
  await drag(page, boxStart, boxEnd, false);
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  const end = await screen(page, { x: 6300, y: 2300 });
  await page.getByTestId("draft-canvas").evaluate((svg, { end, cancellation }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: end.x, clientY: end.y }));
    if (cancellation === "Escape") svg.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    else svg.dispatchEvent(new PointerEvent(cancellation, { bubbles: true, pointerId: 1 }));
  }, { end, cancellation });
  await page.mouse.up();
  await expect(page.getByTestId("selection-marquee")).toHaveCount(0);
  await expect(page.getByTestId("selection-count")).toHaveCount(0);
  await expect(page.locator(".selection-line")).toHaveAttribute("x1", "4000");
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("marquee release uses final coordinates before the animation frame runs", async ({ page }) => {
  const original = await load(page);
  const start = await screen(page, boxStart), preview = await screen(page, boxEnd), release = await screen(page, { x: 6300, y: 2300 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.getByTestId("draft-canvas").evaluate((svg, { preview, release }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: preview.x, clientY: preview.y }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: release.x, clientY: release.y }));
  }, { preview, release });
  await page.mouse.up();
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  expect(await savedPlan(page)).toEqual(original);
});

test("thin boxes select nodes without selecting intersecting wall bodies", async ({ page }) => {
  const original = await load(page);
  await drag(page, { x: -300, y: -30 }, { x: 2300, y: 30 });
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await expect(page.getByTestId("node-a")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("node-b")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".multi-selection .selection-line")).toHaveCount(0);
  await drag(page, { x: 0, y: 0 }, { x: 500, y: -300 });
  const moved = await savedPlan(page);
  expect(moved.nodes[0]).toMatchObject({ x: 500, y: -300 });
  expect(moved.nodes[1]).toMatchObject({ x: 2500, y: -300 });
  expect(moved.nodes[2]).toEqual(original.nodes[2]);
  expect(moved.nodes).toHaveLength(original.nodes.length);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("room interiors can start a marquee while a plain room click still opens room properties", async ({ page }) => {
  const plan: Plan = {
    ...fixture(), nodes: [
      { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 }, { id: "d", x: 0, y: 3000 },
    ], walls: [
      { id: "top", a: "a", b: "b", thickness: 150, dimension: false },
      { id: "right", a: "b", b: "c", thickness: 150, dimension: false },
      { id: "bottom", a: "c", b: "d", thickness: 150, dimension: false },
      { id: "left", a: "d", b: "a", thickness: 150, dimension: false },
    ], openings: [], angleDimensions: [],
  };
  await load(page, plan);
  await click(page, { x: 500, y: 500 });
  await expect(page.getByRole("textbox", { name: "Room name", exact: true })).toBeVisible();
  await drag(page, { x: 500, y: 500 }, { x: 4500, y: 3500 });
  await expect(page.getByTestId("node-c")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Room name", exact: true })).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(plan);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("box selection follows zoom and pan, supports select all, and leaves text-field shortcuts alone", async ({ page }) => {
  const original = await load(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(160, 230, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  await drag(page, boxEnd, boxStart);
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await page.keyboard.press("Control+a");
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  const name = page.getByRole("textbox", { name: "Project name", exact: true });
  await name.focus();
  await name.press("Control+a");
  await name.press("Backspace");
  expect((await savedPlan(page)).walls).toEqual(original.walls);
  await name.fill(original.name);
  await name.press("Enter");
});

test("group moves honor Shift and Alt and cancellation never saves a preview", async ({ page }) => {
  const original = await load(page);
  await drag(page, boxStart, boxEnd);
  const start = await screen(page, { x: 400, y: 0 }), end = await screen(page, { x: 677, y: 173 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId("node-a")).toHaveAttribute("cx", "300");
  await expect(page.getByTestId("node-a")).toHaveAttribute("cy", "0");
  expect(await savedPlan(page)).toEqual(original);
  await page.keyboard.press("Escape");
  await page.keyboard.up("Shift");
  await page.mouse.up();
  await expect(page.getByTestId("node-a")).toHaveAttribute("cx", "0");
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await drag(page, boxStart, boxEnd);
  await page.keyboard.down("Alt");
  await drag(page, { x: 400, y: 0 }, { x: 677, y: 173 });
  await page.keyboard.up("Alt");
  const moved = await savedPlan(page);
  expect(moved.nodes[0].x).toBeCloseTo(277, 3);
  expect(moved.nodes[0].y).toBeCloseTo(173, 3);
  expect(moved.nodes[1].x).toBeCloseTo(2277, 3);
  expect(moved.nodes[2].x).toBeCloseTo(2277, 3);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("bulk deletion during a group drag cancels queued movement and undo restores committed geometry", async ({ page }) => {
  const original = await load(page);
  await drag(page, boxStart, boxEnd);
  await drag(page, { x: 400, y: 0 }, { x: 900, y: 300 }, false);
  await expect(page.getByTestId("node-a")).toHaveAttribute("cx", "500");
  const next = await screen(page, { x: 1000, y: 400 });
  await page.getByTestId("draft-canvas").evaluate((svg, next) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: next.x, clientY: next.y }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
  }, next);
  await page.mouse.up();
  expect((await savedPlan(page)).walls).toEqual(original.walls.slice(2));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("marquee updates do not rebuild or repaint the Excalidraw canvas", async ({ page }) => {
  const original = await load(page);
  await page.evaluate(() => document.fonts.ready);
  await drag(page, boxStart, boxEnd, false);
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  const counts = await page.getByTestId("draft-canvas").evaluate(async svg => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    let canvases = 0, paints = 0;
    const create = document.createElement.bind(document), descriptor = Object.getOwnPropertyDescriptor(document, "createElement");
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    Object.defineProperty(document, "createElement", { configurable: true, value: (tag: string, options?: ElementCreationOptions) => {
      if (tag === "canvas") canvases++;
      return create(tag, options);
    } });
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.classList.contains("static")) paints++;
      return fillRect.apply(this, args);
    };
    try {
      for (let i = 0; i < 8; i++) {
        const point = new DOMPoint(2300 + i * 10, 2300 + i * 10).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
        svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: point.x, clientY: point.y }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    } finally {
      if (descriptor) Object.defineProperty(document, "createElement", descriptor);
      else Reflect.deleteProperty(document, "createElement");
      CanvasRenderingContext2D.prototype.fillRect = fillRect;
    }
    return { canvases, paints };
  });
  await page.mouse.up();
  expect(counts).toEqual({ canvases: 0, paints: 0 });
  expect(await savedPlan(page)).toEqual(original);
});
