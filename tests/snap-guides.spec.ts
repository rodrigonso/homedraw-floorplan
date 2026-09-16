import { expect, test, type Page } from "@playwright/test";
import { distance, wallPoints, type Plan, type Point } from "../src/model";

const fixture = (): Plan => ({
  version: 1, name: "Alignment guides", units: "metric", roomNames: {},
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 }, { id: "d", x: 0, y: 3000 },
    { id: "p", x: 6237, y: 1473 }, { id: "q", x: 8237, y: 2473 },
  ],
  walls: [
    { id: "top", a: "a", b: "b", thickness: 150, dimension: true },
    { id: "right", a: "b", b: "c", thickness: 150, dimension: false },
    { id: "bottom", a: "c", b: "d", thickness: 150, dimension: false },
    { id: "left", a: "d", b: "a", thickness: 150, dimension: false },
    { id: "diagonal", a: "p", b: "q", thickness: 150, dimension: false },
  ],
  openings: [{ id: "door", wallId: "top", kind: "door", offset: 1000, width: 600, flip: false }],
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
    const matrix = svg.querySelector("g")!.getScreenCTM()!;
    const p = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: p.x, y: p.y, scale: matrix.a };
  }, point);
}

async function move(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.move(p.x, p.y, { steps: 5 });
}

async function click(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.click(p.x, p.y);
}

async function freeWalls(page: Page) {
  await page.locator(".settings-menu > summary").click();
  await page.getByRole("button", { name: "Straight walls", exact: true }).click();
  await page.locator(".settings-menu > summary").click();
}

for (const tool of ["Wall", "Room"]) test(`${tool} drawing shows magnetic alignment to off-grid geometry and Alt bypasses it`, async ({ page }) => {
  const original = await load(page);
  await freeWalls(page);
  await page.getByRole("button", { name: `${tool} tool`, exact: true }).click();
  await click(page, { x: 5000, y: 4000 });
  await move(page, { x: 6260, y: 2970 });
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  const shape = page.locator(tool === "Wall" ? ".preview-line" : ".preview-room");
  if (tool === "Wall") {
    await expect(shape).toHaveAttribute("x2", "6237");
    await expect(shape).toHaveAttribute("y2", "3000");
  } else {
    await expect(shape).toHaveAttribute("width", "1237");
    await expect(shape).toHaveAttribute("y", "3000");
  }
  expect(await savedPlan(page)).toEqual(original);
  await page.keyboard.down("Alt");
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  if (tool === "Wall") await expect.poll(async () => Number(await shape.getAttribute("x2"))).toBeCloseTo(6260, 3);
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  await click(page, { x: 6260, y: 2970 });
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  const added = await savedPlan(page);
  expect(added.nodes).toContainEqual(expect.objectContaining({ x: 6237, y: 3000 }));
  expect(JSON.stringify(added)).not.toContain('"guides":');
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("slanted wall extensions remain collinear beyond the endpoint after zooming", async ({ page }) => {
  await load(page);
  await freeWalls(page);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  await click(page, { x: 7000, y: 4500 });
  await move(page, { x: 10057, y: 3353 });
  await expect(page.locator('[data-guide-kind="extension"]')).toBeVisible();
  const preview = page.locator(".preview-line");
  const x = Number(await preview.getAttribute("x2")), y = Number(await preview.getAttribute("y2"));
  expect(y - 1473).toBeCloseTo((x - 6237) / 2, 6);
  expect(x).toBeGreaterThan(8237);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
});

test("node alignment uses release coordinates, preserves topology, and is one undo step", async ({ page }) => {
  const original = await load(page);
  await move(page, { x: 4000, y: 0 });
  await page.mouse.down();
  await move(page, { x: 6260, y: 2970 });
  await expect(page.getByTestId("node-b")).toHaveAttribute("cx", "6237");
  await expect(page.getByTestId("node-b")).toHaveAttribute("cy", "3000");
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  const release = await screen(page, { x: 8260, y: 4473 });
  await page.getByTestId("draft-canvas").evaluate((svg, p) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: p.x - 100, clientY: p.y }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: p.x, clientY: p.y }));
  }, release);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(node => node.id === "b")!.x).toBe(8237);
  expect(moved.nodes).toHaveLength(original.nodes.length);
  expect(moved.walls).toEqual(original.walls);
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture", "blur"]) test(`${cancellation} clears live and queued snap guides`, async ({ page }) => {
  const original = await load(page);
  await move(page, { x: 4000, y: 0 });
  await page.mouse.down();
  await move(page, { x: 6260, y: 2970 });
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  const target = await screen(page, { x: 8240, y: 2480 });
  await page.getByTestId("draft-canvas").evaluate((svg, { target, cancellation }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: target.x, clientY: target.y }));
    if (cancellation === "Escape") svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else if (cancellation === "blur") window.dispatchEvent(new Event("blur"));
    else svg.dispatchEvent(new PointerEvent(cancellation, { bubbles: true, pointerId: 1 }));
  }, { target, cancellation });
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
});

for (const group of [false, true]) test(`${group ? "Group" : "Wall"} translation aligns endpoints without stretching or self-snapping`, async ({ page }) => {
  const original = await load(page);
  if (group) {
    await click(page, { x: 300, y: 0 });
    await page.keyboard.down("Shift");
    await click(page, { x: 0, y: 1000 });
    await page.keyboard.up("Shift");
    await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  }
  const start = await screen(page, { x: 300, y: 0 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await move(page, { x: 2540, y: 2970 });
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  await expect(page.getByTestId("node-b")).toHaveAttribute("cx", "6237");
  await expect(page.getByTestId("node-a")).toHaveAttribute("cy", "3000");
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(distance(...wallPoints(moved, moved.walls[0]))).toBe(4000);
  if (group) expect(distance(...wallPoints(moved, moved.walls[3]))).toBe(3000);
  expect(moved.nodes.find(node => node.id === "p")).toEqual(original.nodes.find(node => node.id === "p"));
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

for (const tool of ["Door", "Window"]) test(`${tool} placement previews its host and snaps to its midpoint`, async ({ page }) => {
  const original = await load(page);
  await page.getByRole("button", { name: `${tool} tool`, exact: true }).click();
  await move(page, { x: 2030, y: 20 });
  const body = page.locator(".opening-placement-body");
  await expect(page.getByTestId("opening-placement")).toBeVisible();
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  expect((Number(await body.getAttribute("x1")) + Number(await body.getAttribute("x2"))) / 2).toBe(2000);
  expect(await savedPlan(page)).toEqual(original);
  await click(page, { x: 2030, y: 20 });
  const placed = await savedPlan(page);
  expect(placed.openings.at(-1)).toMatchObject({ wallId: "top", offset: 2000, kind: tool.toLowerCase() });
  await expect(page.getByTestId("opening-placement")).toHaveCount(0);
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("opening dragging retains the host constraint and Alt disables guide attraction", async ({ page }) => {
  const original = await load(page);
  await move(page, { x: 1000, y: 0 });
  await page.mouse.down();
  await move(page, { x: 2030, y: 80 });
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Position from wall start", exact: true })).toHaveValue("2 m");
  await page.keyboard.down("Alt");
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Position from wall start", exact: true })).toHaveValue("2.03 m");
  await page.keyboard.up("Alt");
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  await page.mouse.up();
  expect((await savedPlan(page)).openings[0]).toEqual({ ...original.openings[0], offset: 2000 });
});

test("guides stay transient, hide with snapping disabled, and do not intercept canvas input", async ({ page }) => {
  const original = await load(page);
  await page.getByRole("button", { name: "Window tool", exact: true }).click();
  await move(page, { x: 2030, y: 0 });
  await expect(page.getByTestId("snap-guides")).toHaveCSS("pointer-events", "none");
  await page.locator(".settings-menu > summary").click();
  await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
  await page.locator(".settings-menu > summary").click();
  await move(page, { x: 2030, y: 0 });
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  const body = page.locator(".opening-placement-body");
  expect((Number(await body.getAttribute("x1")) + Number(await body.getAttribute("x2"))) / 2).toBeCloseTo(2030, 3);
  await page.mouse.move(30, 30);
  await expect(page.getByTestId("opening-placement")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  await page.mouse.move(700, 800);
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
});

for (const width of [1440, 390]) test(`Shift combines an exact axis lock with alignment guides at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const original = await load(page);
  await freeWalls(page);
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  await click(page, { x: 5000, y: 4000 });
  await move(page, { x: 6260, y: 2970 });
  await page.keyboard.down("Shift");
  const preview = page.locator(".preview-line");
  await expect(preview).toHaveAttribute("x2", "6237");
  await expect(preview).toHaveAttribute("y2", "4000");
  await expect(page.locator('[data-guide-kind="alignment"]')).toBeVisible();
  await expect(page.locator('[data-guide-kind="constraint"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("alignment-guides.png") });
  await page.keyboard.down("Alt");
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  await expect(preview).toHaveAttribute("y2", "4000");
  await expect.poll(async () => Math.abs(Number(await preview.getAttribute("x2")) - 6260)).toBeLessThan(0.001);
  await page.keyboard.up("Alt");
  await expect(preview).toHaveAttribute("x2", "6237");
  await click(page, { x: 6260, y: 2970 });
  await page.keyboard.up("Shift");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId("snap-guides")).toHaveCount(0);
  expect((await savedPlan(page)).nodes).toContainEqual(expect.objectContaining({ x: 6237, y: 4000 }));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("overlapping opening previews stay red and can still be placed", async ({ page }, testInfo) => {
  const original = await load(page);
  await page.getByRole("button", { name: "Door tool", exact: true }).click();
  await move(page, { x: 1030, y: 10 });
  const preview = page.getByTestId("opening-placement");
  await expect(preview).toHaveClass(/invalid-placement/);
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("opening-guides.png") });
  expect(await savedPlan(page)).toEqual(original);
  await click(page, { x: 1030, y: 10 });
  const placed = await savedPlan(page);
  expect(placed.openings).toHaveLength(2);
  expect(placed.openings[1]).toMatchObject({ wallId: "top", offset: 1000, kind: "door" });
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId("geometry-warning-overlay")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("rotated window previews and final placements stay on their host axis", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Window tool", exact: true }).click();
  await move(page, { x: 7260, y: 1980 });
  await expect(page.getByTestId("opening-placement")).toBeVisible();
  await expect(page.getByTestId("snap-guides")).toBeVisible();
  const body = page.locator(".opening-placement-body");
  const coordinates = await body.evaluate(line => ["x1", "y1", "x2", "y2"].map(key => Number(line.getAttribute(key))));
  expect((coordinates[0] + coordinates[2]) / 2).toBeCloseTo(7237, 6);
  expect((coordinates[1] + coordinates[3]) / 2).toBeCloseTo(1973, 6);
  expect(coordinates[3] - coordinates[1]).toBeCloseTo((coordinates[2] - coordinates[0]) / 2, 6);
  await click(page, { x: 7260, y: 1980 });
  expect((await savedPlan(page)).openings.at(-1)!.offset).toBeCloseTo(Math.hypot(2000, 1000) / 2, 6);
});
