import { expect, test, type Page } from "@playwright/test";
import type { Plan, Point } from "../src/model";
import { setUnits } from "./ui";

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function screenPoint(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const matrix = svg.querySelector("g")!.getScreenCTM()!;
    const position = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: position.x, y: position.y, scale: matrix.a };
  }, point);
}

async function clickWorld(page: Page, point: Point) {
  const position = await screenPoint(page, point);
  await page.mouse.click(position.x, position.y);
}

async function startAngle(page: Page) {
  await page.getByRole("button", { name: "Angle tool", exact: true }).click();
  await clickWorld(page, { x: 1000, y: 0 });
  await clickWorld(page, { x: 0, y: 2400 });
}

async function placeAngle(page: Page) {
  await startAngle(page);
  await clickWorld(page, { x: 700, y: 700 });
  return savedPlan(page);
}

async function drawing(page: Page) {
  return page.locator("canvas.excalidraw__canvas.static").evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
}

async function angleInk(page: Page, point: Point) {
  return page.evaluate(point => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.excalidraw__canvas.static")!;
    const group = document.querySelector<SVGGElement>('[data-testid="draft-canvas"] > g')!;
    const position = new DOMPoint(point.x, point.y).matrixTransform(group.getScreenCTM()!);
    const bounds = canvas.getBoundingClientRect();
    const pixels = canvas.getContext("2d")!.getImageData(
      Math.floor((position.x - bounds.x) * canvas.width / bounds.width) - 4,
      Math.floor((position.y - bounds.y) * canvas.height / bounds.height) - 4, 9, 9,
    ).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 200 && pixels[i + 2] > pixels[i] + 4 && pixels[i + 2] > pixels[i + 1] + 5) count++;
    }
    return count;
  }, point);
}

test("angle placement previews a measured arc and persists through history, export and import", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  const arcPoint = { x: Math.hypot(700, 700) * Math.cos(Math.PI / 9), y: Math.hypot(700, 700) * Math.sin(Math.PI / 9) };
  expect(await angleInk(page, arcPoint)).toBe(0);
  await startAngle(page);
  const point = await screenPoint(page, { x: 700, y: 700 });
  await page.mouse.move(point.x, point.y);
  await expect(page.getByTestId("angle-preview:angle")).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await expect(page.getByTestId("angle-arc-preview:angle")).toHaveAttribute("points", /,/);
  await expect.poll(() => angleInk(page, arcPoint)).toBeGreaterThan(0);
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.click(point.x, point.y);
  const placed = await savedPlan(page);
  expect(placed.angleDimensions).toHaveLength(1);
  expect(placed.nodes).toEqual(original.nodes);
  expect(placed.walls).toEqual(original.walls);
  const angle = placed.angleDimensions![0];
  expect(angle.radius).toBeCloseTo(Math.hypot(700, 700), 0);
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await expect(page.getByTestId("angle-value")).toHaveText("90\u00b0");
  await expect.poll(() => angleInk(page, arcPoint)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(placed);
  await page.reload();
  expect(await savedPlan(page)).toEqual(placed);
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await setUnits(page, "imperial");
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await page.locator(".export-menu summary").click();
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const stream = await (await svgDownload).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain("90\u00b0");
  const projectDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const projectStream = await (await projectDownload).createReadStream();
  const projectChunks: Buffer[] = [];
  for await (const chunk of projectStream!) projectChunks.push(Buffer.from(chunk));
  const project = Buffer.concat(projectChunks);
  expect(JSON.parse(project.toString()).plan.angleDimensions).toEqual(placed.angleDimensions);
  page.on("dialog", dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "angles.homedraw.json", mimeType: "application/json", buffer: project,
  });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  expect((await savedPlan(page)).angleDimensions).toEqual(placed.angleDimensions);
  await page.locator(".settings-menu > summary").click();
  await page.getByRole("button", { name: "Dimensions", exact: true }).click();
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Dimensions", exact: true }).click();
  await expect(page.getByTestId(`angle-${angle.id}`)).toBeVisible();
  expect(errors).toEqual([]);
});

test("angle values and arc endpoints follow shared node drags live", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  const original = await placeAngle(page);
  const angle = original.angleDimensions![0];
  const node = original.nodes.find(node => node.x === 4200 && node.y === 0)!;
  const label = page.getByTestId(`angle-${angle.id}`);
  const arc = page.getByTestId(`angle-arc-${angle.id}`);
  const beforeArc = await arc.getAttribute("points");
  const beforeCanvas = await drawing(page);
  const start = await screenPoint(page, node);
  const end = await screenPoint(page, { x: 4450, y: 250 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 86.8\u00b0");
  await expect(arc).not.toHaveAttribute("points", beforeArc!);
  await expect.poll(() => drawing(page)).not.toBe(beforeCanvas);
  expect(await savedPlan(page)).toEqual(original);
  const preview = await drawing(page);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.angleDimensions).toEqual(original.angleDimensions);
  await expect.poll(() => drawing(page)).toBe(preview);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 86.8\u00b0");
});

test("angle arcs reposition radially after zoom and pan with cancellation and one undo step", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  const original = await placeAngle(page);
  const angle = original.angleDimensions![0];
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const canvas = (await page.getByTestId("draft-canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 140, canvas.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 180, canvas.y + 130, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const label = page.getByTestId(`angle-${angle.id}`);
  const arc = page.getByTestId(`angle-arc-${angle.id}`);
  const originalArc = await arc.getAttribute("points");
  const box = (await label.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const begin = async (dx: number, dy: number) => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
  };
  await begin(50, -50);
  await expect(arc).toHaveAttribute("points", originalArc!);
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await begin(50, 50);
  await expect(arc).not.toHaveAttribute("points", originalArc!);
  expect(await savedPlan(page)).toEqual(original);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(arc).toHaveAttribute("points", originalArc!);
  expect(await savedPlan(page)).toEqual(original);
  await begin(50, 50);
  await page.getByTestId("draft-canvas").dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(arc).toHaveAttribute("points", originalArc!);
  expect(await savedPlan(page)).toEqual(original);
  const arcStart = await arc.evaluate(element => {
    const line = element as SVGPolylineElement;
    const point = line.points.getItem(Math.floor(line.points.numberOfItems / 4));
    const position = new DOMPoint(point.x, point.y).matrixTransform(line.getScreenCTM()!);
    return { x: position.x, y: position.y };
  });
  await page.mouse.move(arcStart.x, arcStart.y);
  await page.mouse.down();
  await page.mouse.move(arcStart.x + 45, arcStart.y + 45, { steps: 8 });
  await expect(arc).not.toHaveAttribute("points", originalArc!);
  await page.mouse.up();
  const moved = await savedPlan(page);
  const { scale } = await screenPoint(page, { x: 0, y: 0 });
  expect(moved.angleDimensions![0].radius).toBeCloseTo(angle.radius + Math.sqrt(2) * 45 / scale, 0);
  expect(moved.nodes).toEqual(original.nodes);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await label.click();
  await page.getByRole("button", { name: "Measure other side", exact: true }).click();
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 270\u00b0");
  const radius = page.getByRole("textbox", { name: "Angle arc radius", exact: true });
  await radius.fill("1.5 m");
  await radius.press("Enter");
  expect((await savedPlan(page)).angleDimensions![0].radius).toBe(1500);
  await radius.fill("0.01 m");
  await radius.press("Enter");
  await expect(radius).toHaveAttribute("aria-invalid", "true");
  expect((await savedPlan(page)).angleDimensions![0].radius).toBe(1500);
  await label.focus();
  await page.keyboard.press("Delete");
  await expect(label).toHaveCount(0);
  expect((await savedPlan(page)).angleDimensions).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(label).toBeVisible();
  await clickWorld(page, { x: 1000, y: 0 });
  await page.getByRole("button", { name: "Delete wall", exact: true }).click();
  expect((await savedPlan(page)).angleDimensions).toEqual([]);
});

test("angle placement rejects unrelated walls, supports reflex angles and cancels cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  await page.keyboard.press("a");
  await expect(page.getByRole("button", { name: "Angle tool", exact: true })).toHaveAttribute("aria-pressed", "true");
  await clickWorld(page, { x: 1000, y: 1800 });
  await expect(page.getByRole("alert")).toContainText("Click directly on a wall");
  await clickWorld(page, { x: 1000, y: 0 });
  await clickWorld(page, { x: 1500, y: 0 });
  await expect(page.getByRole("alert")).toBeVisible();
  await clickWorld(page, { x: 1000, y: 4800 });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("angle-preview:angle")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await clickWorld(page, { x: 0, y: 2400 });
  const outside = await screenPoint(page, { x: -600, y: -600 });
  await page.mouse.move(outside.x, outside.y);
  await expect(page.getByTestId("angle-preview:angle")).toHaveAttribute("aria-label", "Angle measurement 270\u00b0");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("angle-preview:angle")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await startAngle(page);
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  await expect(page.getByTestId("angle-preview:angle")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await startAngle(page);
  await clickWorld(page, { x: -600, y: -600 });
  const placed = await savedPlan(page);
  const angle = placed.angleDimensions![0];
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveAttribute("aria-label", "Angle measurement 270\u00b0");
  await startAngle(page);
  await clickWorld(page, { x: -600, y: -600 });
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await savedPlan(page)).toEqual(placed);
  await page.keyboard.press("Escape");
  await startAngle(page);
  await page.getByRole("button", { name: "Delete wall", exact: true }).click();
  await expect(page.getByTestId("angle-preview:angle")).toHaveCount(0);
  expect((await savedPlan(page)).angleDimensions).toEqual([]);
  expect(errors).toEqual([]);
});

test("double-click angle editing rotates the second wall with undo, redo, reload and export", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await savedPlan(page);
  const original = await placeAngle(page);
  const angle = original.angleDimensions![0];
  const secondWall = original.walls.find(wall => wall.id === angle.wallB)!;
  const movingId = secondWall.a === angle.vertex ? secondWall.b : secondWall.a;
  const label = page.getByTestId(`angle-${angle.id}`);
  const beforeCanvas = await drawing(page);
  await label.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit angle", exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("90\u00b0");
  await editor.fill("80");
  expect(await savedPlan(page)).toEqual(original);
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 80\u00b0");
  const changed = await savedPlan(page);
  const end = changed.nodes.find(node => node.id === movingId)!;
  expect(end.x).toBeCloseTo(4800 * Math.cos(80 * Math.PI / 180), 6);
  expect(end.y).toBeCloseTo(4800 * Math.sin(80 * Math.PI / 180), 6);
  expect(changed.nodes.filter(node => node.id !== movingId)).toEqual(original.nodes.filter(node => node.id !== movingId));
  expect(changed.openings).toEqual(original.openings);
  expect(changed.angleDimensions).toEqual(original.angleDimensions);
  expect(changed.roomNames).toEqual(original.roomNames);
  await expect(page.getByRole("textbox", { name: "Angle", exact: true })).toHaveValue("80\u00b0");
  await expect.poll(() => drawing(page)).not.toBe(beforeCanvas);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(changed);
  await page.reload();
  expect(await savedPlan(page)).toEqual(changed);
  await expect(page.getByTestId(`angle-${angle.id}`)).toHaveAttribute("aria-label", "Angle measurement 80\u00b0");
  await page.locator(".export-menu summary").click();
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await svgDownload).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain("80\u00b0");
  expect(errors).toEqual([]);
});

test("inline angle edits apply on blur after zoom and pan and also work from the inspector", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  const original = await placeAngle(page);
  const angle = original.angleDimensions![0];
  await page.getByRole("button", { name: "Measure other side", exact: true }).click();
  const reflex = await savedPlan(page);
  await setUnits(page, "imperial");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const canvas = (await page.getByTestId("draft-canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 160, canvas.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 200, canvas.y + 140, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const label = page.getByTestId(`angle-${angle.id}`);
  await label.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit angle", exact: true });
  await expect(editor).toHaveValue("270\u00b0");
  const labelBox = (await label.boundingBox())!, editBox = (await editor.boundingBox())!;
  expect(editBox.x + editBox.width / 2).toBeCloseTo(labelBox.x + labelBox.width / 2, 0);
  expect(editBox.y + editBox.height / 2).toBeCloseTo(labelBox.y + labelBox.height / 2, 0);
  await editor.fill("280 deg");
  await editor.press("Tab");
  await expect(editor).toHaveCount(0);
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 280\u00b0");
  const changed = await savedPlan(page);
  expect(changed.angleDimensions).toEqual(reflex.angleDimensions);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await savedPlan(page)).nodes).toEqual(original.nodes);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(changed);
  await label.click();
  const inspector = page.getByRole("textbox", { name: "Angle", exact: true });
  await inspector.fill("285.125 degrees");
  await inspector.press("Enter");
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 285.1\u00b0");
  await expect(inspector).toHaveValue("285.125\u00b0");
  const precise = await savedPlan(page);
  await label.focus();
  await label.press("Enter");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("285.125\u00b0");
  await editor.press("Enter");
  expect(await savedPlan(page)).toEqual(precise);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(changed);
  const beforeDrag = (await label.boundingBox())!;
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 + 25, beforeDrag.y + beforeDrag.height / 2 + 25, { steps: 8 });
  await page.mouse.up();
  await expect(editor).toHaveCount(0);
  const repositioned = await savedPlan(page);
  expect(repositioned.nodes).toEqual(changed.nodes);
  expect(repositioned.angleDimensions![0].radius).not.toBe(changed.angleDimensions![0].radius);
  await label.dblclick();
  await expect(editor).toBeFocused();
  await editor.press("Escape");
  expect(await savedPlan(page)).toEqual(repositioned);
});

test("angle editing rejects malformed input but permits warned geometry and supports cancellation", async ({ page }) => {
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("button", { name: "Window tool", exact: true }).click();
  await clickWorld(page, { x: 2100, y: 4800 });
  await savedPlan(page);
  const original = await placeAngle(page);
  const angle = original.angleDimensions![0];
  const label = page.getByTestId(`angle-${angle.id}`);
  await label.dblclick();
  const editor = page.getByRole("textbox", { name: "Edit angle", exact: true });
  for (const text of ["", "360", "-30", "90 m", "60 trailing"]) {
    await editor.fill(text);
    await editor.press("Enter");
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(await savedPlan(page)).toEqual(original);
  }
  await editor.fill("45");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("geometry-feedback")).toContainText(/opening/i);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  expect((await savedPlan(page)).openings).toEqual(original.openings);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await label.dblclick();
  await editor.fill("300");
  await editor.press("Tab");
  await expect(editor).toHaveCount(0);
  await expect(page.getByTestId("geometry-feedback")).toContainText(/cross|meet/i);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  expect((await savedPlan(page)).nodes).not.toEqual(original.nodes);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await label.dblclick();
  await editor.fill("85");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await label.dblclick();
  await editor.press("Tab");
  expect(await savedPlan(page)).toEqual(original);
  await label.dblclick();
  await editor.fill("80");
  await editor.press("Enter");
  await expect(label).toHaveAttribute("aria-label", "Angle measurement 80\u00b0");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await savedPlan(page)).angleDimensions).toBeUndefined();
});
