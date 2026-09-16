import { expect, test, type Page } from "@playwright/test";
import { detectRooms, getGeometryIssues, type Plan, type Point } from "../src/model";

const openRoom = (): Plan => ({
  version: 1, name: "Join nodes", units: "metric", roomNames: {},
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 },
    { id: "d", x: 0, y: 3000 }, { id: "loose", x: 0, y: 600 },
  ],
  walls: [
    { id: "top", a: "a", b: "b", thickness: 150, dimension: true },
    { id: "right", a: "b", b: "c", thickness: 150, dimension: true },
    { id: "bottom", a: "c", b: "d", thickness: 150, dimension: true },
    { id: "left", a: "d", b: "loose", thickness: 150, dimension: true },
  ],
  openings: [{ id: "door", wallId: "left", kind: "door", offset: 1000, width: 800, flip: true, hingeAtEnd: true }],
  angleDimensions: [{ id: "angle", wallA: "bottom", wallB: "left", vertex: "d", radius: 500, clockwise: true }],
});

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function load(page: Page, plan = openRoom()) {
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

async function begin(page: Page, point: Point = { x: 0, y: 600 }) {
  const p = await screen(page, point);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
}

for (const width of [1440, 390]) test(`dropping a node combines junctions and closes a room with history and persistence at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = [], dialogs: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const original = await load(page);
  const target = await screen(page, { x: 0, y: 0 });
  await begin(page);
  await page.mouse.move(target.x + 4, target.y - 3, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await expect(page.getByTestId("node-loose")).toHaveAttribute("cy", "0");
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  const merged = await savedPlan(page);
  expect(merged.nodes).toEqual(original.nodes.filter(node => node.id !== "loose"));
  expect(merged.walls).toEqual(original.walls.map(wall => wall.id === "left" ? { ...wall, b: "a" } : wall));
  expect(merged.openings).toEqual(original.openings);
  expect(merged.angleDimensions).toEqual(original.angleDimensions);
  expect(detectRooms(merged)[0].area).toBe(12_000_000);
  expect(getGeometryIssues(merged)).toEqual([]);
  await expect(page.getByTestId("node-loose")).toHaveCount(0);
  await expect(page.getByTestId("node-a")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
  await expect(page.getByTestId("geometry-feedback")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(merged);
  await page.reload();
  expect(await savedPlan(page)).toEqual(merged);
  await page.keyboard.down("Alt");
  await begin(page, { x: 0, y: 0 });
  const moved = await screen(page, { x: -300, y: -200 });
  await page.mouse.move(moved.x, moved.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const reshaped = await savedPlan(page);
  expect(reshaped.nodes.find(node => node.id === "a")!.x).toBeCloseTo(-300, 3);
  expect(reshaped.nodes.find(node => node.id === "a")!.y).toBeCloseTo(-200, 3);
  expect(reshaped.nodes.filter(node => node.id !== "a")).toEqual(merged.nodes.filter(node => node.id !== "a"));
  expect(reshaped.walls.filter(wall => wall.a === "a" || wall.b === "a")).toHaveLength(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(merged);
  await page.locator(".export-menu > summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).plan).toEqual(merged);
  expect(errors).toEqual([]);
  expect(dialogs).toEqual([]);
});

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture"]) test(`${cancellation} cancels both live and queued node combining`, async ({ page }) => {
  const original = await load(page);
  await begin(page);
  const target = await screen(page, { x: 0, y: 0 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.getByTestId("draft-canvas").evaluate((svg, { target, cancellation }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 1, buttons: 1, clientX: target.x, clientY: target.y,
    }));
    if (cancellation === "Escape") svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else svg.dispatchEvent(new PointerEvent(cancellation, { bubbles: true, pointerId: 1 }));
  }, { target, cancellation });
  await page.mouse.up();
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
  await expect(page.getByTestId("node-loose")).toHaveAttribute("cy", "600");
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("combining uses the release coordinates rather than a queued or stale target", async ({ page }) => {
  const original = await load(page);
  const target = await screen(page, { x: 0, y: 0 }), away = await screen(page, { x: -500, y: 600 });
  await begin(page);
  await page.getByTestId("draft-canvas").evaluate((svg, { target, away }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: away.x, clientY: away.y }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: target.x, clientY: target.y }));
  }, { target, away });
  await page.mouse.up();
  expect((await savedPlan(page)).nodes.some(node => node.id === "loose")).toBe(false);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await begin(page);
  await page.mouse.move(target.x, target.y);
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.getByTestId("draft-canvas").evaluate((svg, { target, away }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: target.x, clientY: target.y }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: away.x, clientY: away.y }));
  }, { target, away });
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(node => node.id === "loose")).toMatchObject({ x: -500, y: 600 });
  expect(moved.walls).toEqual(original.walls);
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

for (const bypass of ["Alt", "snap off", "Shift off-axis"]) test(`${bypass} prevents unintended node combining`, async ({ page }) => {
  const plan = openRoom();
  if (bypass === "Shift off-axis") plan.nodes[0].x = 200;
  const original = await load(page, plan);
  if (bypass === "snap off") {
    await page.locator(".settings-menu > summary").click();
    await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
    await page.locator(".settings-menu > summary").click();
  }
  await begin(page);
  if (bypass === "Alt") await page.keyboard.down("Alt");
  if (bypass === "Shift off-axis") await page.keyboard.down("Shift");
  const target = await screen(page, plan.nodes[0]);
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Shift");
  const moved = await savedPlan(page);
  expect(moved.nodes).toHaveLength(original.nodes.length);
  expect(moved.walls).toEqual(original.walls);
  const node = moved.nodes.find(node => node.id === "loose")!;
  expect(node.x).toBeCloseTo(0, 5);
  expect(node.y).toBeCloseTo(0, 5);
});

test("Alt pressed only at release cancels a highlighted combination", async ({ page }) => {
  const original = await load(page);
  await begin(page);
  const target = await screen(page, { x: 0, y: 0 });
  await page.mouse.move(target.x, target.y);
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.keyboard.down("Alt");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const moved = await savedPlan(page);
  expect(moved.nodes).toHaveLength(original.nodes.length);
  expect(moved.walls).toEqual(original.walls);
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
});

test("node combining respects the grab offset and screen-space snapping after zooming and panning", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(160, 230, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const start = await screen(page, { x: 0, y: 600 }), target = await screen(page, { x: 0, y: 0 });
  await page.mouse.move(start.x + 4, start.y + 3);
  await page.mouse.down();
  await page.mouse.move(target.x + 4 + 14, target.y + 3, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
  await page.mouse.move(target.x + 4 + 8, target.y + 3);
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.mouse.up();
  expect((await savedPlan(page)).nodes.some(node => node.id === "loose")).toBe(false);
});

test("already coincident nodes combine after a real drag, but not on a click", async ({ page }) => {
  const plan = openRoom();
  plan.nodes[4].y = 0;
  await load(page, plan);
  await page.getByTestId("node-loose").click();
  expect(await savedPlan(page)).toEqual(plan);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await begin(page, { x: 0, y: 0 });
  const away = await screen(page, { x: -300, y: 500 }), target = await screen(page, { x: 0, y: 0 });
  await page.mouse.move(away.x, away.y, { steps: 8 });
  await expect(page.getByTestId("node-loose")).toHaveAttribute("cx", "-300");
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.mouse.up();
  const merged = await savedPlan(page);
  expect(merged.nodes.some(node => node.id === "loose")).toBe(false);
  expect(getGeometryIssues(merged)).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(plan);
});

test("deleting while a combination is highlighted cancels the merge and deletes the original selection", async ({ page }) => {
  const original = await load(page);
  await begin(page);
  const target = await screen(page, { x: 0, y: 0 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.keyboard.press("Delete");
  await page.mouse.up();
  const deleted = await savedPlan(page);
  expect(deleted.nodes.find(node => node.id === "a")).toEqual(original.nodes[0]);
  expect(deleted.walls.map(wall => wall.id)).toEqual(["top", "right", "bottom"]);
  expect(deleted.openings).toEqual([]);
  await expect(page.getByTestId("node-merge-target")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("combining a wall's endpoints removes collapsed geometry without a dialog and remains undoable", async ({ page }) => {
  const plan: Plan = {
    ...openRoom(), nodes: openRoom().nodes.slice(0, 2), walls: [openRoom().walls[0]],
    openings: [{ id: "window", wallId: "top", kind: "window", offset: 2000, width: 900, flip: false }],
    angleDimensions: [],
  };
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await load(page, plan);
  await begin(page, { x: 4000, y: 0 });
  const target = await screen(page, { x: 0, y: 0 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect(page.getByTestId("node-merge-target")).toBeVisible();
  await page.mouse.up();
  const merged = await savedPlan(page);
  expect(merged.nodes).toEqual([]);
  expect(merged.walls).toEqual([]);
  expect(merged.openings).toEqual([]);
  await expect(page.getByRole("button", { name: "Delete node", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(plan);
  expect(dialogs).toEqual([]);
});
