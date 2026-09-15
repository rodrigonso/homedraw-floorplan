import { expect, test, type Page } from "@playwright/test";
import {
  addAngleDimension, addOpening, addWall, createDemoPlan, createEmptyPlan, splitWall, validatePlan, type Plan, type Point,
} from "../src/model";

async function load(page: Page, plan: Plan) {
  await page.addInitScript(plan => {
    if (!localStorage.getItem("homedraw.project.v1")) localStorage.setItem("homedraw.project.v1",
      JSON.stringify({ format: "homedraw", version: 1, plan, sketches: [] }));
  }, plan);
  await page.goto("/");
  return savedPlan(page);
}

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function screen(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const p = new DOMPoint(point.x, point.y).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, point);
}

for (const width of [1440, 390]) test(`nodes can be selected and deleted with history and persistence at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  let original = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
  original = addOpening(original, original.walls[0].id, "window", 3000, 700);
  const split = splitWall(original, original.walls[0].id, 2000);
  const node = split.nodes.at(-1)!;
  await load(page, split);
  const handle = page.getByTestId(`node-${node.id}`);
  await handle.click();
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".node-control.node-selected")).toHaveCount(1);
  await expect(page.locator(".node-wall-highlight")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Delete node", exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(split);
  await page.keyboard.press("Delete");
  expect(await savedPlan(page)).toEqual(original);
  await expect(handle).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(split);
  await handle.focus();
  await handle.press("Enter");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await handle.press("Backspace");
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.reload();
  expect(await savedPlan(page)).toEqual(original);
});

test("branch deletion removes attached geometry immediately from properties and the keyboard", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  const original = createDemoPlan();
  await load(page, original);
  const node = original.nodes.find(node => node.x === 4200 && node.y === 0)!;
  const handle = page.getByTestId(`node-${node.id}`);
  await handle.click();
  await expect(page.locator(".node-wall-highlight")).toHaveCount(3);
  const button = page.getByRole("button", { name: "Delete node", exact: true });
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await button.click();
  const deleted = await savedPlan(page);
  expect(deleted.nodes.some(item => item.id === node.id)).toBe(false);
  expect(deleted.walls).toHaveLength(original.walls.length - 3);
  expect(deleted.openings).toHaveLength(original.openings.length - 3);
  await expect(button).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await handle.click();
  await page.keyboard.press("Backspace");
  expect(await savedPlan(page)).toEqual(deleted);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const kind of ["endpoint", "corner"]) test(`${kind} deletion never prompts, even when removing openings or angles and changing wall settings`, async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  let original = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
  const first = original.walls[0];
  original = addOpening(original, first.id, "window", 2000, 700);
  if (kind === "corner") {
    original = addWall(original, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, 200);
    original = addAngleDimension(original, {
      wallA: first.id, wallB: original.walls[1].id, vertex: first.b, radius: 500, clockwise: true,
    });
  }
  await load(page, original);
  const handle = page.getByTestId(`node-${first.b}`);
  await handle.focus();
  await handle.press("Enter");
  await handle.press("Delete");
  const deleted = await savedPlan(page);
  expect(deleted.nodes.some(node => node.id === first.b)).toBe(false);
  expect(deleted.walls).toHaveLength(kind === "corner" ? 1 : 0);
  expect(deleted.openings).toHaveLength(kind === "corner" ? 1 : 0);
  expect(deleted.angleDimensions ?? []).toEqual([]);
  await expect(handle).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("deleting during a node drag discards pending previews and undo restores the committed node", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const original = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
  const split = splitWall(original, original.walls[0].id, 2000);
  const node = split.nodes.at(-1)!;
  await load(page, split);
  const start = await screen(page, node), end = await screen(page, { x: 2000, y: -500 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cy", "-500");
  await page.getByTestId("draft-canvas").evaluate(svg => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: 700, clientY: 300 }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
  });
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.locator(".node-control")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(split);
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cy", "0");
  expect(errors).toEqual([]);
});

test("joining reversed walls preserves door hinges and outer angle annotations in rendering and saved projects", async ({ page }) => {
  const original = validatePlan({
    ...createEmptyPlan(),
    nodes: [{ id: "a", x: 0, y: 0 }, { id: "n", x: 2000, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 }],
    walls: [
      { id: "first", a: "a", b: "n", thickness: 150, dimension: true },
      { id: "second", a: "b", b: "n", thickness: 150, dimension: true },
      { id: "third", a: "b", b: "c", thickness: 150, dimension: true },
    ],
    openings: [{ id: "door", wallId: "second", kind: "door", offset: 800, width: 600, flip: false }],
    angleDimensions: [{ id: "angle", wallA: "second", wallB: "third", vertex: "b", radius: 600, clockwise: true }],
  });
  await load(page, original);
  const doorGeometry = () => page.evaluate(async () => {
    const path = "/src/scene.ts";
    const scene: typeof import("../src/scene") = await import(path);
    const plan: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    return scene.planToElements(plan).filter(element => element.type === "line" && /^plan-(door|swing)-/.test(element.id))
      .flatMap(element => element.type === "line" ? element.points.map(point => [element.x + point[0], element.y + point[1]]) : []);
  });
  const before = await doorGeometry();
  const angleLabel = await page.getByTestId("angle-angle").getAttribute("aria-label");
  await page.getByTestId("node-n").click();
  await page.getByRole("button", { name: "Delete node", exact: true }).click();
  const deleted = await savedPlan(page);
  expect(deleted.openings[0]).toMatchObject({ wallId: "first", flip: true, hingeAtEnd: true, width: 600 });
  expect(deleted.angleDimensions![0]).toMatchObject({ id: "angle", wallA: "first", wallB: "third", vertex: "b" });
  await expect(page.getByTestId("angle-angle")).toHaveAttribute("aria-label", angleLabel!);
  const after = await doorGeometry();
  expect(after).toHaveLength(before.length);
  after.forEach((point, i) => point.forEach((value, j) => expect(value).toBeCloseTo(before[i][j], 6)));
  await page.reload();
  expect(await savedPlan(page)).toEqual(deleted);
  await page.locator(".export-menu > summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).plan).toEqual(deleted);
  page.once("dialog", dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "joined.homedraw.json", mimeType: "application/json", buffer: Buffer.concat(chunks),
  });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(deleted);
});
