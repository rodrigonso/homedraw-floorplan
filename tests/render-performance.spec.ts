import { expect, test, type Page } from "@playwright/test";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Plan, Point } from "../src/model";

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}
async function screenPoint(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const result = new DOMPoint(point.x, point.y).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: result.x, y: result.y };
  }, point);
}
async function beginNodeDrag(page: Page) {
  await page.goto("/");
  const original = await savedPlan(page);
  await page.evaluate(() => document.fonts.ready);
  const node = original.nodes.find(node => node.x === 4200 && node.y === 0)!;
  const start = await screenPoint(page, node);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(page.getByRole("button", { name: "Delete node", exact: true })).toBeVisible();
  return { original, node };
}

test("incremental conversion matches fresh geometry while preserving unaffected elements", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  const result = await page.evaluate(async () => {
    const modelPath = "/src/model.ts", scenePath = "/src/scene.ts";
    const model: typeof import("../src/model") = await import(modelPath);
    const scene: typeof import("../src/scene") = await import(scenePath);
    let plan = model.createEmptyPlan();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      plan = model.addRoom(plan, { x: x * 4200, y: y * 4800 }, { x: (x + 1) * 4200, y: (y + 1) * 4800 }, 150);
    }
    const renderer = scene.createPlanRenderer();
    const before = renderer.render(plan);
    const node = plan.nodes.find(node => node.x === 4200 && node.y === 0)!;
    const moved = model.moveNode(plan, node.id, { x: 4450, y: 250 });
    const after = renderer.render(moved);
    const clean = ({ version, versionNonce, updated, index, ...drawing }: ExcalidrawElement) => drawing;
    const beforeById = new Map(before.map(element => [element.id, element]));
    const wall = moved.walls[0];
    const preview = renderer.render(moved, true, { id: wall.id, offset: -900 });
    const afterById = new Map(after.map(element => [element.id, element]));
    const hidden = renderer.render(moved, false);
    renderer.clear();
    const refreshed = renderer.render(moved);
    const merged = model.mergeNodes(moved, node.id, moved.nodes.find(node => node.x === 0 && node.y === 0)!.id);
    const combined = renderer.render(merged);
    return {
      total: before.length,
      reused: after.filter(element => element === beforeById.get(element.id)).length,
      actual: after.map(clean), expected: scene.planToElements(moved).map(clean),
      dimensionChanges: preview.filter(element => element !== afterById.get(element.id)).map(element => element.id),
      wallId: wall.id,
      hiddenDimensions: hidden.filter(element => element.id.startsWith("plan-dim-")).length,
      refreshed: refreshed.map(clean),
      cleared: refreshed.every(element => element !== afterById.get(element.id)),
      combined: combined.map(clean), expectedCombined: scene.planToElements(merged).map(clean),
    };
  });
  expect(result.reused).toBeGreaterThan(result.total * 0.85);
  expect(result.actual).toEqual(result.expected);
  expect(result.dimensionChanges.length).toBeGreaterThan(0);
  expect(result.dimensionChanges.length).toBeLessThanOrEqual(7);
  expect(result.dimensionChanges.every(id => id.includes(result.wallId))).toBe(true);
  expect(result.hiddenDimensions).toBe(0);
  expect(result.refreshed).toEqual(result.expected);
  expect(result.cleared).toBe(true);
  expect(result.combined).toEqual(result.expectedCombined);
});

test("release before a queued preview commits the release coordinates exactly once", async ({ page }) => {
  const { original, node } = await beginNodeDrag(page);
  const preview = await screenPoint(page, { x: 4450, y: 250 });
  const release = await screenPoint(page, { x: 4500, y: 300 });
  await page.getByTestId("draft-canvas").evaluate((svg, { preview, release }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 1, buttons: 1, clientX: preview.x, clientY: preview.y,
    }));
    svg.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 1, button: 0, clientX: release.x, clientY: release.y,
    }));
  }, { preview, release });
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(other => other.id === node.id)).toMatchObject({ x: 4500, y: 300 });
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cx", "4500");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture"]) {
  test(`${cancellation} discards a pending node preview before the next frame`, async ({ page }) => {
    const { original, node } = await beginNodeDrag(page);
    const target = await screenPoint(page, { x: 4450, y: 250 });
    await page.getByTestId("draft-canvas").evaluate((svg, { target, cancellation }) => {
      svg.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, buttons: 1, clientX: target.x, clientY: target.y,
      }));
      if (cancellation === "Escape") svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else svg.dispatchEvent(new PointerEvent(cancellation, { bubbles: true, pointerId: 1 }));
    }, { target, cancellation });
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cx", "4200");
    expect(await savedPlan(page)).toEqual(original);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  });
}

test("pointer jitter inside one snap cell does not allocate or redraw scene canvases", async ({ page }) => {
  const { original, node } = await beginNodeDrag(page);
  const target = await screenPoint(page, { x: 4450, y: 250 });
  await page.mouse.move(target.x, target.y);
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cx", "4450");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const counts = await page.getByTestId("draft-canvas").evaluate(async svg => {
    let canvases = 0, paints = 0;
    const create = document.createElement.bind(document);
    const descriptor = Object.getOwnPropertyDescriptor(document, "createElement");
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
      for (let i = 0; i < 12; i++) {
        const point = new DOMPoint(4450 + (i % 2 ? 5 : -5), 250).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
        svg.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true, pointerId: 1, buttons: 1, clientX: point.x, clientY: point.y,
        }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    } finally {
      if (descriptor) Object.defineProperty(document, "createElement", descriptor);
      else Reflect.deleteProperty(document, "createElement");
      CanvasRenderingContext2D.prototype.fillRect = fillRect;
    }
    return { canvases, paints };
  });
  expect(counts).toEqual({ canvases: 0, paints: 0 });
  expect(await savedPlan(page)).toEqual(original);
  await page.keyboard.press("Escape");
  await page.mouse.up();
});
