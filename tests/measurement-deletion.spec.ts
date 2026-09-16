import { expect, test, type Page } from "@playwright/test";
import type { Plan, Point } from "../src/model";

const fixture = (): Plan => ({
  version: 1, name: "Independent measurements", units: "metric", roomNames: {},
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 },
    { id: "c", x: 4000, y: 3000 }, { id: "d", x: 0, y: 3000 },
  ],
  walls: [
    { id: "top", a: "a", b: "b", thickness: 150, dimension: true, dimensionOffset: -700 },
    { id: "right", a: "b", b: "c", thickness: 150, dimension: true, dimensionOffset: -700 },
    { id: "bottom", a: "c", b: "d", thickness: 150, dimension: false },
    { id: "left", a: "d", b: "a", thickness: 150, dimension: false },
  ],
  openings: [{ id: "door", wallId: "top", kind: "door", offset: 1000, width: 600, flip: false }],
  angleDimensions: [{ id: "angle", wallA: "top", wallB: "right", vertex: "b", radius: 650, clockwise: false }],
  thicknessDimensions: [{ id: "thickness", wallId: "top", offset: 350 }],
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

async function clickWall(page: Page) {
  const point = await screen(page, { x: 300, y: 0 });
  await page.mouse.click(point.x, point.y);
}

for (const width of [1440, 390]) for (const action of ["Delete", "Backspace", "button"]) {
  test(`length measurement deletion via ${action} keeps its wall and can be restored at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    const original = await load(page);
    const label = page.getByTestId("dimension-top");
    await label.click();
    await expect(label).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Length measurement", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete wall", exact: true })).toHaveCount(0);
    expect(await savedPlan(page)).toEqual(original);
    if (action === "button") await page.getByRole("button", { name: "Delete measurement", exact: true }).click();
    else await page.keyboard.press(action);
    const deleted = { ...original, walls: original.walls.map(wall => wall.id === "top" ? { ...wall, dimension: false } : wall) };
    expect(await savedPlan(page)).toEqual(deleted);
    await expect(label).toHaveCount(0);
    await expect(page.getByTestId("dimension-line-top")).toHaveCount(0);
    await expect(page.getByTestId("dimension-right")).toBeVisible();
    await expect(page.getByTestId("thickness-thickness")).toBeVisible();
    await expect(page.getByTestId("angle-angle")).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await savedPlan(page)).toEqual(original);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(await savedPlan(page)).toEqual(deleted);
    await page.reload();
    expect(await savedPlan(page)).toEqual(deleted);
    await expect(label).toHaveCount(0);
    await clickWall(page);
    await page.getByRole("button", { name: "Attached dimension", exact: true }).click();
    expect(await savedPlan(page)).toEqual(original);
    await expect(label).toBeVisible();
    expect(dialogs).toEqual([]);
  });
}

for (const kind of ["dimension", "angle", "thickness"]) {
  test(`keyboard deletion of a focused ${kind} label does not delete the previously selected wall`, async ({ page }) => {
    const original = await load(page);
    await clickWall(page);
    await expect(page.getByRole("button", { name: "Delete wall", exact: true })).toBeVisible();
    const id = kind === "dimension" ? "top" : kind;
    await page.getByTestId(`${kind}-${id}`).focus();
    await page.keyboard.press("Delete");
    const expected = kind === "dimension"
      ? { ...original, walls: original.walls.map(wall => wall.id === "top" ? { ...wall, dimension: false } : wall) }
      : kind === "angle" ? { ...original, angleDimensions: [] } : { ...original, thicknessDimensions: [] };
    expect(await savedPlan(page)).toEqual(expected);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await savedPlan(page)).toEqual(original);
  });
}

test("mixed measurement labels Shift-select and delete atomically without changing geometry", async ({ page }) => {
  const original = await load(page);
  await page.getByTestId("dimension-top").click();
  await page.keyboard.down("Shift");
  await page.getByTestId("angle-angle").click();
  await page.getByTestId("thickness-thickness").click();
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  await page.getByTestId("dimension-top").click();
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await page.getByTestId("dimension-top").click();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  expect(await savedPlan(page)).toEqual({
    ...original, angleDimensions: [], thicknessDimensions: [],
    walls: original.walls.map(wall => wall.id === "top" ? { ...wall, dimension: false } : wall),
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("a marquee around a length measurement selects only its annotation", async ({ page }) => {
  const original = await load(page);
  const bounds = await page.evaluate(async plan => {
    const path = "/src/selection.ts";
    const selection: typeof import("../src/selection") = await import(path);
    return selection.selectionBounds(plan, [{ kind: "dimension", id: "top" }])!;
  }, original);
  const start = await screen(page, { x: bounds.x - 50, y: bounds.y - 50 });
  const end = await screen(page, { x: bounds.x + bounds.width + 50, y: bounds.y + bounds.height + 50 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Length measurement", { exact: true })).toBeVisible();
  await page.keyboard.press("Backspace");
  expect(await savedPlan(page)).toEqual({
    ...original, walls: original.walls.map(wall => wall.id === "top" ? { ...wall, dimension: false } : wall),
  });
});

test("group movement keeps independent length measurements on their local axes", async ({ page }) => {
  const original = await load(page);
  await page.getByTestId("dimension-top").click();
  await page.keyboard.down("Shift");
  await page.getByTestId("dimension-right").click();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  const label = (await page.getByTestId("dimension-top").boundingBox())!;
  const scale = await page.getByTestId("draft-canvas").evaluate(svg => svg.querySelector("g")!.getScreenCTM()!.a);
  const start = { x: label.x + label.width / 2, y: label.y + label.height / 2 };
  await page.keyboard.down("Alt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 200 * scale, start.y - 300 * scale, { steps: 8 });
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const moved = await savedPlan(page);
  expect(moved.nodes).toEqual(original.nodes);
  expect(moved.openings).toEqual(original.openings);
  expect(moved.angleDimensions).toEqual(original.angleDimensions);
  expect(moved.thicknessDimensions).toEqual(original.thicknessDimensions);
  expect(Math.abs(moved.walls[0].dimensionOffset! + 1000)).toBeLessThan(0.001);
  expect(Math.abs(moved.walls[1].dimensionOffset! + 900)).toBeLessThan(0.001);
  await page.keyboard.press("Delete");
  expect((await savedPlan(page)).walls.every(wall => !wall.dimension)).toBe(true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("deleting during a length drag cancels queued previews and preserves the last saved offset", async ({ page }) => {
  const original = await load(page);
  const label = page.getByTestId("dimension-top"), box = (await label.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 5 });
  await page.getByTestId("draft-canvas").evaluate(svg => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: 800, clientY: 200 }));
    svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
  });
  await page.mouse.up();
  await expect(label).toHaveCount(0);
  expect(await savedPlan(page)).toEqual({
    ...original, walls: original.walls.map(wall => wall.id === "top" ? { ...wall, dimension: false } : wall),
  });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("inline and property text deletion does not remove the selected measurement", async ({ page }) => {
  const original = await load(page);
  const label = page.getByTestId("dimension-top");
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await input.fill("5 m");
  await input.press("Backspace");
  await expect(label).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await input.press("Escape");
  const offset = page.getByRole("textbox", { name: "Measurement offset", exact: true });
  await offset.fill("-800 mm");
  await offset.press("Enter");
  expect((await savedPlan(page)).walls[0].dimensionOffset).toBe(-800);
  await label.dblclick();
  await input.fill("4.5 m");
  await input.press("Enter");
  const resized = await savedPlan(page);
  expect(resized.nodes.find(node => node.id === "b")!.x).toBe(4500);
  expect(resized.walls[0].dimensionOffset).toBe(-800);
  await page.keyboard.press("Delete");
  expect((await savedPlan(page)).walls[0].dimension).toBe(false);
  expect((await savedPlan(page)).nodes).toEqual(resized.nodes);
});

for (const kind of ["dimension", "angle", "thickness"]) {
  test(`the ${kind} label of a collapsed wall can still be selected and deleted`, async ({ page }) => {
    const plan = fixture();
    plan.nodes[1] = { id: "b", x: 0, y: 0 };
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const original = await load(page, plan);
    const id = kind === "dimension" ? "dimension-warning-top" : kind === "angle" ? "angle-warning-angle" : "thickness-thickness";
    await page.getByTestId(id).click();
    await page.keyboard.press("Delete");
    const expected = kind === "dimension"
      ? { ...original, walls: original.walls.map(wall => wall.id === "top" ? { ...wall, dimension: false } : wall) }
      : kind === "angle" ? { ...original, angleDimensions: [] } : { ...original, thicknessDimensions: [] };
    expect(await savedPlan(page)).toEqual(expected);
    await expect(page.getByTestId(id)).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await savedPlan(page)).toEqual(original);
    expect(errors).toEqual([]);
  });
}

test("removed length measurements stay absent from SVG and project exports", async ({ page }) => {
  const original = await load(page);
  const hit = await page.evaluate(async plan => {
    const path = "/src/scene.ts";
    const scene: typeof import("../src/scene") = await import(path);
    return scene.hitTest(plan, { x: 2000, y: -700 }, 100, true);
  }, original);
  expect(hit).toEqual({ kind: "dimension", id: "top" });
  await page.getByTestId("dimension-top").click();
  await page.keyboard.press("Delete");
  const deleted = await savedPlan(page);
  await page.locator(".export-menu > summary").click();
  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const project: Buffer[] = [];
  for await (const chunk of (await (await projectDownload).createReadStream())!) project.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(project).toString()).plan).toEqual(deleted);
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const svg: Buffer[] = [];
  for await (const chunk of (await (await svgDownload).createReadStream())!) svg.push(Buffer.from(chunk));
  const text = Buffer.concat(svg).toString();
  expect(text).not.toContain(">4 m</text>");
  expect(text).toContain(">3 m</text>");
});
