import { expect, test, type Page } from "@playwright/test";
import { addThicknessDimension, detectRooms, moveNode, validatePlan, type Plan, type Point } from "../src/model";
import { thicknessDimensionPosition } from "../src/dimensions";
import { setUnits } from "./ui";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

const fixture = (): Plan => ({
  version: 1, name: "Thickness dimensions", units: "metric", roomNames: { "room:a:b:c:d": "Studio" },
  nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 }, { id: "d", x: 0, y: 3000 }],
  walls: [
    { id: "top", a: "a", b: "b", thickness: 150, dimension: true },
    { id: "right", a: "b", b: "c", thickness: 150, dimension: true },
    { id: "bottom", a: "c", b: "d", thickness: 150, dimension: true },
    { id: "left", a: "d", b: "a", thickness: 150, dimension: true },
  ],
  openings: [{ id: "door", wallId: "top", kind: "door", offset: 2000, width: 900, flip: false }],
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

async function click(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.click(p.x, p.y);
}

for (const width of [1440, 390]) test(`wall thickness measurements add and edit inline with history at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const original = await load(page);
  await click(page, { x: 1000, y: 0 });
  await page.getByRole("button", { name: "Add thickness measurement", exact: true }).click();
  const created = await savedPlan(page), dimension = created.thicknessDimensions![0];
  const label = page.getByTestId(`thickness-${dimension.id}`);
  await expect(label).toHaveAttribute("aria-label", "Thickness measurement 0.15 m");
  expect(dimension).toMatchObject({ wallId: "top", offset: 350 });
  const line = page.getByTestId(`thickness-line-${dimension.id}`);
  await expect(line).toHaveAttribute("x1", "4350");
  await expect(line).toHaveAttribute("y1", "-75");
  await expect(line).toHaveAttribute("y2", "75");
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit thickness", exact: true });
  await expect(input).toBeFocused();
  await input.fill("250 mm");
  await input.press("Enter");
  const edited = await savedPlan(page);
  expect(edited.walls[0].thickness).toBe(250);
  expect(edited.nodes).toEqual(original.nodes);
  expect(edited.openings).toEqual(original.openings);
  expect(detectRooms(edited)[0]).toMatchObject({ name: "Studio", area: 12_000_000 });
  await expect(label).toHaveAttribute("aria-label", "Thickness measurement 0.25 m");
  await expect(line).toHaveAttribute("y1", "-125");
  await expect(line).toHaveAttribute("y2", "125");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(created);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.reload();
  expect(await savedPlan(page)).toEqual(edited);
  await expect(label).toHaveAttribute("aria-label", "Thickness measurement 0.25 m");
});

test("Dimension tool places thickness at the clicked wall position and invalid inline values remain editable", async ({ page }) => {
  const original = await load(page);
  await page.getByRole("button", { name: "Dimension tool", exact: true }).click();
  await page.getByRole("button", { name: "Thickness", exact: true }).click();
  await click(page, { x: 1000, y: 0 });
  const created = await savedPlan(page), dimension = created.thicknessDimensions![0];
  expect(dimension.offset).toBeCloseTo(-3000, 2);
  expect(created.walls).toEqual(original.walls);
  const label = page.getByTestId(`thickness-${dimension.id}`);
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit thickness", exact: true });
  for (const text of ["nonsense", "5 mm", "2 m"]) {
    await input.fill(text);
    await input.press("Enter");
    await expect(input).toBeVisible();
    expect((await savedPlan(page)).walls).toEqual(original.walls);
  }
  await input.fill("200 mm");
  await input.press("Enter");
  expect((await savedPlan(page)).walls[0].thickness).toBe(200);
  await expect(label).toHaveAttribute("aria-label", "Thickness measurement 0.2 m");
});

for (const rotation of [0, Math.PI / 2, Math.PI / 6]) test(`thickness labels drag along rotated walls (${rotation}) without resizing them`, async ({ page }) => {
  let plan = fixture();
  plan = validatePlan({ ...plan, nodes: plan.nodes.map(node => ({
    ...node, x: node.x * Math.cos(rotation) - node.y * Math.sin(rotation), y: node.x * Math.sin(rotation) + node.y * Math.cos(rotation),
  })) });
  plan = addThicknessDimension(plan, "top");
  const original = await load(page, plan), dimension = original.thicknessDimensions![0];
  const label = page.getByTestId(`thickness-${dimension.id}`);
  const box = (await label.boundingBox())!;
  const { axis } = thicknessDimensionPosition(original, dimension);
  const scale = (await screen(page, { x: 0, y: 0 })).scale;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + axis.x * 60 - axis.y * 30, start.y + axis.y * 60 + axis.x * 30, { steps: 8 });
  await expect.poll(async () => (await label.boundingBox())!.x).toBeCloseTo(box.x + axis.x * 60, 1);
  await expect.poll(async () => (await label.boundingBox())!.y).toBeCloseTo(box.y + axis.y * 60, 1);
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const moved = await savedPlan(page);
  expect(moved.thicknessDimensions![0].offset).toBeCloseTo(350 + 60 / scale, 2);
  expect(moved.nodes).toEqual(original.nodes);
  expect(moved.walls).toEqual(original.walls);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("thickness line dragging cancels cleanly and release coordinates win over queued previews", async ({ page }) => {
  const original = await load(page, addThicknessDimension(fixture(), "top"));
  const dimension = original.thicknessDimensions![0];
  const start = await screen(page, { x: 4350, y: 0 }), end = await screen(page, { x: 4850, y: 200 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId(`thickness-line-${dimension.id}`)).toHaveAttribute("x1", "4850");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.getByTestId("draft-canvas").evaluate((svg, end) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: end.x - 20, clientY: end.y }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: end.x, clientY: end.y }));
  }, end);
  await page.mouse.up();
  expect((await savedPlan(page)).thicknessDimensions![0].offset).toBeCloseTo(850, 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("thickness dimensions export, import, honor visibility and delete without deleting the wall", async ({ page }) => {
  const original = await load(page, addThicknessDimension(fixture(), "top"));
  const id = original.thicknessDimensions![0].id, dialogs: string[] = [];
  const label = page.getByTestId(`thickness-${id}`);
  await page.locator(".export-menu > summary").click();
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const svgChunks: Buffer[] = [];
  for await (const chunk of (await (await svgDownload).createReadStream())!) svgChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(svgChunks).toString()).toContain("0.15 m");
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG image", exact: true }).click();
  const pngChunks: Buffer[] = [];
  for await (const chunk of (await (await pngDownload).createReadStream())!) pngChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(pngChunks).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await projectDownload).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).plan).toEqual(original);
  page.once("dialog", dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "thickness.homedraw.json", mimeType: "application/json", buffer: Buffer.concat(chunks),
  });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await page.locator(".settings-menu > summary").click();
  await page.getByRole("button", { name: "Dimensions", exact: true }).click();
  await expect(label).toHaveCount(0);
  await page.getByRole("button", { name: "Dimensions", exact: true }).click();
  await page.locator(".settings-menu > summary").click();
  await label.click();
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.keyboard.press("Delete");
  const deleted = await savedPlan(page);
  expect(deleted.thicknessDimensions).toEqual([]);
  expect(deleted.walls).toEqual(original.walls);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  expect(dialogs).toEqual([]);
});

test("collapsed hosts retain editable thickness values and restore measurement geometry when repaired", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const original = addThicknessDimension(fixture(), "top");
  const collapsed = moveNode(original, "b", { x: 0, y: 0 });
  await load(page, collapsed);
  const id = collapsed.thicknessDimensions![0].id;
  await expect(page.getByTestId(`thickness-line-${id}`)).toHaveCount(0);
  const label = page.getByTestId(`thickness-${id}`);
  await label.focus();
  await label.press("Enter");
  const input = page.getByRole("textbox", { name: "Edit thickness", exact: true });
  await input.fill("200 mm");
  await input.press("Enter");
  expect((await savedPlan(page)).walls[0].thickness).toBe(200);
  const start = await screen(page, { x: 0, y: 0 }), end = await screen(page, { x: 4000, y: 0 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId(`thickness-line-${id}`)).toHaveAttribute("y1", "-100");
  await expect(label).toHaveAttribute("aria-label", "Thickness measurement 0.2 m");
  expect(errors).toEqual([]);
});

test("imperial thickness edits and signed offset properties work after zoom and pan", async ({ page }) => {
  await load(page, addThicknessDimension(fixture(), "top"));
  await setUnits(page, "imperial");
  const original = await savedPlan(page), id = original.thicknessDimensions![0].id;
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  await page.mouse.move(700, 700);
  await page.mouse.down();
  await page.mouse.move(640, 735, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const label = page.getByTestId(`thickness-${id}`);
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit thickness", exact: true });
  await input.fill('8"');
  await input.press("Enter");
  expect((await savedPlan(page)).walls[0].thickness).toBeCloseTo(203.2, 8);
  await expect(label).toHaveAttribute("aria-label", /8"/);
  const offset = page.getByRole("textbox", { name: "Offset from wall end", exact: true });
  await offset.fill("-3 ft");
  await offset.press("Enter");
  const positioned = await savedPlan(page);
  expect(positioned.thicknessDimensions![0].offset).toBeCloseTo(-914.4, 8);
  const box = (await label.boundingBox())!, scale = (await screen(page, { x: 0, y: 0 })).scale;
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 63, box.y + box.height / 2 - 25, { steps: 5 });
  await page.mouse.up();
  expect((await savedPlan(page)).thicknessDimensions![0].offset).toBeCloseTo(-914.4 + 60 / scale, 2);
  expect((await savedPlan(page)).nodes).toEqual(original.nodes);
  await page.getByRole("button", { name: "Delete thickness measurement", exact: true }).click();
  expect((await savedPlan(page)).thicknessDimensions).toEqual([]);
  expect((await savedPlan(page)).walls).toHaveLength(4);
});

test("thickness annotations support marquee, Shift selection and atomic group movement/deletion", async ({ page }) => {
  let plan = addThicknessDimension(fixture(), "top");
  plan = addThicknessDimension(plan, "right");
  const original = await load(page, plan), [first, second] = original.thicknessDimensions!;
  const start = await screen(page, { x: 4001, y: -200 }), end = await screen(page, { x: 4800, y: 600 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Delete thickness measurement", exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByTestId(`thickness-${second.id}`).click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  const label = page.getByTestId(`thickness-${first.id}`), box = (await label.boundingBox())!;
  const scale = (await screen(page, { x: 0, y: 0 })).scale;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200 * scale, box.y + box.height / 2 + 300 * scale, { steps: 5 });
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.thicknessDimensions!.map(dimension => dimension.offset)).toEqual([550, 650]);
  expect(moved.nodes).toEqual(original.nodes);
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  const deleted = await savedPlan(page);
  expect(deleted.thicknessDimensions).toEqual([]);
  expect(deleted.walls).toEqual(original.walls);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("splitting, joining and combining nodes retain or remove host thickness annotations with history", async ({ page }) => {
  const original = await load(page, addThicknessDimension(fixture(), "top", -1000));
  const id = original.thicknessDimensions![0].id;
  await click(page, { x: 1000, y: 0 });
  await page.getByRole("button", { name: "Add midpoint node", exact: true }).click();
  const split = await savedPlan(page), junction = split.nodes.find(node => !original.nodes.some(old => old.id === node.id))!;
  expect(split.thicknessDimensions![0].wallId).not.toBe("top");
  await expect(page.getByTestId(`thickness-line-${id}`)).toHaveAttribute("x1", "3000");
  const handle = page.getByTestId(`node-${junction.id}`);
  await handle.focus();
  await handle.press("Enter");
  await page.keyboard.press("Delete");
  const joined = await savedPlan(page);
  expect(joined.thicknessDimensions).toEqual(original.thicknessDimensions);
  await expect(page.getByTestId(`thickness-line-${id}`)).toHaveAttribute("x1", "3000");
  const start = await screen(page, { x: 0, y: 0 }), end = await screen(page, { x: 4000, y: 0 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  expect((await savedPlan(page)).thicknessDimensions).toEqual([]);
  await expect(page.getByTestId(`thickness-${id}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(joined);
});

test("thickness renderer previews reuse unrelated elements and match committed exports", async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async () => {
    const modelPath = "/src/model.ts", scenePath = "/src/scene.ts";
    const model: typeof import("../src/model") = await import(modelPath);
    const scene: typeof import("../src/scene") = await import(scenePath);
    const original: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    const plan = model.addThicknessDimension(original, "top"), id = plan.thicknessDimensions![0].id;
    const renderer = scene.createPlanRenderer(), before = renderer.render(plan);
    const byId = new Map(before.map(element => [element.id, element]));
    const preview = renderer.render(plan, true, { id, offset: -1000, measurement: "thickness" });
    const clean = ({ version, versionNonce, updated, index, ...drawing }: ExcalidrawElement) => drawing;
    const positioned = model.updateThicknessDimension(plan, id, { offset: -1000 });
    const changes = preview.filter(element => element !== byId.get(element.id)).map(element => element.id);
    const hidden = renderer.render(positioned, false);
    const lengthPreview = renderer.render(plan, true, { id: "top", offset: -1000 });
    const committed = renderer.render(plan);
    const thicknessLine = committed.find(element => element.id === `plan-thickness-line-${id}`)!;
    if (thicknessLine.type !== "line") throw new Error("Expected a face-to-face measurement line.");
    const [a, b] = thicknessLine.points;
    return {
      changes, actual: preview.map(clean), expected: scene.planToElements(positioned).map(clean),
      hidden: hidden.filter(element => element.id.startsWith("plan-thickness-")).length,
      lengthActual: lengthPreview.map(clean), lengthExpected: scene.planToElements(model.setDimensionOffset(plan, "top", -1000)).map(clean),
      span: Math.hypot(b[0] - a[0], b[1] - a[1]),
      text: committed.find(element => element.id === `plan-thickness-label-${id}` && element.type === "text"),
    };
  });
  expect(result.changes.length).toBeGreaterThan(0);
  expect(result.changes.every(id => id.startsWith("plan-thickness-"))).toBe(true);
  expect(result.actual).toEqual(result.expected);
  expect(result.lengthActual).toEqual(result.lengthExpected);
  expect(result.hidden).toBe(0);
  expect(result.span).toBe(15);
  expect(result.text).toMatchObject({ text: "0.15 m", strokeColor: "#514ca8" });
});
