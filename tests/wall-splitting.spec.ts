import { expect, test, type Page } from "@playwright/test";
import { addWall, createEmptyPlan, type Plan, type Point } from "../src/model";

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function screen(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const matrix = svg.querySelector("g")!.getScreenCTM()!;
    const p = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: p.x, y: p.y, scale: matrix.a };
  }, point);
}

test("double-click inserts a shared wall node that drags live, saves and supports undo and redo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  const position = await screen(page, { x: 1234, y: 4800 });
  await page.mouse.dblclick(position.x, position.y);
  await expect(page.locator(".node-control")).toHaveCount(original.nodes.length + 1);
  const split = await savedPlan(page);
  expect(split.walls).toHaveLength(original.walls.length + 1);
  const node = split.nodes.find(node => !original.nodes.some(old => old.id === node.id))!;
  expect(node).toMatchObject({ x: 1250, y: 4800 });
  expect(split.nodes.filter(item => item.id !== node.id)).toEqual(original.nodes);
  expect(split.openings).toEqual(original.openings);
  expect(split.walls.filter(wall => wall.a === node.id || wall.b === node.id)).toHaveLength(2);
  await expect(page.locator(".room-list button").filter({ hasText: "Living room" })).toContainText("20.16");
  const start = await screen(page, node), end = await screen(page, { x: 1250, y: 4300 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cy", "4300");
  expect(await savedPlan(page)).toEqual(split);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(item => item.id === node.id)).toMatchObject({ x: 1250, y: 4300 });
  expect(moved.nodes.filter(item => item.id !== node.id)).toEqual(original.nodes);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(split);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(split);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.reload();
  expect(await savedPlan(page)).toEqual(moved);
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cy", "4300");
  await page.locator(".export-menu > summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).plan).toEqual(moved);
  expect(errors).toEqual([]);
});

test("midpoint insertion is keyboard accessible and leaves existing openings in place", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const position = await screen(page, { x: 1000, y: 4800 });
  await page.mouse.click(position.x, position.y);
  const button = page.getByRole("button", { name: "Add midpoint node", exact: true });
  await button.focus();
  await button.press("Enter");
  const split = await savedPlan(page);
  expect(split.nodes.at(-1)).toMatchObject({ x: 2100, y: 4800 });
  expect(split.walls).toHaveLength(original.walls.length + 1);
  expect(split.openings).toEqual(original.openings);
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toHaveValue("2.1 m");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("slanted walls split on their centerline after zoom and pan, with Alt bypassing split snapping", async ({ page }) => {
  const original = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 3000, y: 4000 }, 150);
  await page.addInitScript(plan => localStorage.setItem("homedraw.project.v1",
    JSON.stringify({ format: "homedraw", version: 1, plan, sketches: [] })), original);
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  await page.mouse.move(200, 300);
  await page.mouse.down();
  await page.mouse.move(240, 330, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const position = await screen(page, { x: 750, y: 1000 });
  await page.mouse.dblclick(position.x, position.y);
  expect((await savedPlan(page)).nodes.at(-1)).toMatchObject({ x: 750, y: 1000 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const exact = await screen(page, { x: 744, y: 992 });
  await page.keyboard.down("Alt");
  await page.mouse.dblclick(exact.x, exact.y);
  await page.keyboard.up("Alt");
  const split = await savedPlan(page);
  expect(split.nodes).toHaveLength(3);
  const node = split.nodes.at(-1)!;
  // Double-click MouseEvents report integer CSS pixels, unlike PointerEvents.
  expect(Math.hypot(node.x - 744, node.y - 992)).toBeLessThanOrEqual(Math.SQRT2 / exact.scale);
  expect(node.y / node.x).toBeCloseTo(4 / 3, 8);
  const snappedSteps = Math.hypot(node.x, node.y) / 50;
  expect(Math.abs(snappedSteps - Math.round(snappedSteps))).toBeGreaterThan(0.001);
});

test("double-clicking existing junctions, openings and measurements does not insert nodes", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  await page.getByTestId(`node-${original.nodes[0].id}`).dblclick();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByTestId("input-feedback")).toHaveCount(0);
  const opening = await screen(page, { x: 2100, y: 0 });
  await page.mouse.dblclick(opening.x, opening.y);
  await expect(page.getByRole("textbox", { name: "Opening width", exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByTestId("input-feedback")).toHaveCount(0);
  const wall = original.walls.find(wall => !original.openings.some(opening => opening.wallId === wall.id))!;
  await page.getByTestId(`dimension-${wall.id}`).dblclick();
  await expect(page.getByRole("textbox", { name: "Edit dimension", exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await page.keyboard.press("Escape");
});

test("a double-click delivered after a wall drag does not add a node", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const start = await screen(page, { x: 1000, y: 4800 }), end = await screen(page, { x: 1000, y: 4550 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes).not.toEqual(original.nodes);
  await page.getByTestId("draft-canvas").dispatchEvent("dblclick", { button: 0, clientX: end.x, clientY: end.y });
  expect(await savedPlan(page)).toEqual(moved);
  await expect(page.getByTestId("input-feedback")).toHaveCount(0);
});
