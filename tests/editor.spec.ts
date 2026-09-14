import { expect, test, type Page } from "@playwright/test";
import type { Plan, Point } from "../src/model";
import { setUnits } from "./ui";

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function clickWorld(page: Page, point: Point) {
  const position = await page.getByTestId("draft-canvas").evaluate((svg, p) => {
    const transform = svg.querySelector("g")!.getScreenCTM()!;
    const result = new DOMPoint(p.x, p.y).matrixTransform(transform);
    return { x: result.x, y: result.y };
  }, point);
  await page.mouse.click(position.x, position.y);
}

async function canvasPixelAt(page: Page, point: Point) {
  return page.evaluate(point => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.excalidraw__canvas.static")!;
    const group = document.querySelector<SVGGElement>('[data-testid="draft-canvas"] > g')!;
    const position = new DOMPoint(point.x, point.y).matrixTransform(group.getScreenCTM()!);
    const rect = canvas.getBoundingClientRect();
    return Array.from(canvas.getContext("2d")!.getImageData(
      Math.floor((position.x - rect.x) * canvas.width / rect.width),
      Math.floor((position.y - rect.y) * canvas.height / rect.height), 1, 1,
    ).data);
  }, point);
}

test("demo, precise editing, openings, dimensions, undo and reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByTestId("draft-canvas")).toBeVisible();
  let plan = await savedPlan(page);
  expect(plan.walls.length).toBeGreaterThanOrEqual(7);
  await page.locator(".rooms-menu > summary").click();
  await expect(page.getByRole("button", { name: /Living room/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Kitchen/ })).toBeVisible();
  await page.locator(".rooms-menu > summary").click();

  const wall = plan.walls.find(w => !plan.openings.some(o => o.wallId === w.id))!;
  const a = plan.nodes.find(n => n.id === wall.a)!;
  const b = plan.nodes.find(n => n.id === wall.b)!;
  await clickWorld(page, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Wall thickness", exact: true }).fill("200 mm");
  await page.getByRole("textbox", { name: "Wall thickness", exact: true }).press("Enter");
  await expect.poll(async () => (await savedPlan(page)).walls.find(w => w.id === wall.id)!.thickness).toBe(200);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await savedPlan(page)).walls.find(w => w.id === wall.id)!.thickness).toBe(wall.thickness);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await savedPlan(page)).walls.find(w => w.id === wall.id)!.thickness).toBe(200);
  await clickWorld(page, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  await setUnits(page, "imperial");
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toHaveValue(/'/);
  await page.getByRole("textbox", { name: "Wall length", exact: true }).focus();
  await page.getByRole("textbox", { name: "Wall length", exact: true }).press("Tab");
  const unchanged = await savedPlan(page);
  expect(unchanged.nodes).toEqual(plan.nodes);
  await setUnits(page, "metric");
  await page.getByRole("button", { name: "Window tool", exact: true }).click();
  await clickWorld(page, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  await expect(page.getByRole("textbox", { name: "Opening width" })).toBeVisible();
  await page.getByRole("textbox", { name: "Opening width" }).fill("1 m");
  await page.getByRole("textbox", { name: "Opening width" }).press("Enter");
  plan = await savedPlan(page);
  expect(plan.openings.at(-1)?.width).toBe(1000);
  await page.reload();
  await expect(page.getByTestId("draft-canvas")).toBeVisible();
  const reloaded = await savedPlan(page);
  expect(reloaded).toEqual(plan);
  expect(errors).toEqual([]);
});

test("draw room, resize a dimension, reject invalid edits, name and export", async ({ page }) => {
  await page.goto("/");
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await page.getByRole("button", { name: "Start blank plan" }).click();
  await page.getByRole("button", { name: "Draw your first room" }).click();
  const svg = page.getByTestId("draft-canvas");
  const bounds = (await svg.boundingBox())!;
  await page.mouse.click(bounds.x + 100, bounds.y + 120);
  await page.mouse.move(bounds.x + 420, bounds.y + 420);
  await page.mouse.click(bounds.x + 420, bounds.y + 420);
  let plan = await savedPlan(page);
  expect(plan.walls).toHaveLength(4);
  expect(plan.nodes).toHaveLength(4);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit plan", exact: true }).click();
  const wall = plan.walls[0];
  const a = plan.nodes.find(n => n.id === wall.a)!;
  const b = plan.nodes.find(n => n.id === wall.b)!;
  await clickWorld(page, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const field = page.getByRole("textbox", { name: "Wall length", exact: true });
  await field.fill("4.2 m");
  await field.press("Enter");
  plan = await savedPlan(page);
  const newA = plan.nodes.find(n => n.id === wall.a)!;
  const newB = plan.nodes.find(n => n.id === wall.b)!;
  expect(Math.hypot(newB.x - newA.x, newB.y - newA.y)).toBeCloseTo(4200);
  expect(newA).toEqual(a);
  await field.fill("-2");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await savedPlan(page)).toEqual(plan);
  await field.fill("4.2 m");
  await field.press("Enter");
  await page.getByRole("button", { name: "Attached dimension" }).click();
  expect((await savedPlan(page)).walls[0].dimension).toBe(!wall.dimension);

  await page.locator(".rooms-menu > summary").click();
  await page.locator(".room-list button").first().click();
  await page.getByRole("textbox", { name: "Room name" }).fill("My workshop");
  await page.getByRole("textbox", { name: "Room name" }).press("Enter");
  await page.locator(".rooms-menu > summary").click();
  await expect(page.getByRole("button", { name: /My workshop/ })).toBeVisible();
  await page.locator(".export-menu summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.homedraw\.json$/);
  const projectStream = await download.createReadStream();
  const projectChunks: Buffer[] = [];
  for await (const chunk of projectStream!) projectChunks.push(Buffer.from(chunk));
  const exportedProject = JSON.parse(Buffer.concat(projectChunks).toString());
  expect(exportedProject.plan.walls).toHaveLength(4);
  expect(Object.values(exportedProject.plan.roomNames)).toContain("My workshop");
  const svgDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing" }).click();
  const svgDownload = await svgDownloadPromise;
  expect(svgDownload.suggestedFilename()).toMatch(/\.svg$/);
  const svgStream = await svgDownload.createReadStream();
  const svgChunks: Buffer[] = [];
  for await (const chunk of svgStream!) svgChunks.push(Buffer.from(chunk));
  const svgText = Buffer.concat(svgChunks).toString();
  expect(svgText).toContain("<svg");
  expect(svgText).toContain("My workshop");
  const pngPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG image" }).click();
  const pngStream = await (await pngPromise).createReadStream();
  const pngChunks: Buffer[] = [];
  for await (const chunk of pngStream!) pngChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(pngChunks).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
});

test("sketch layer persists and is included in project round trips", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await savedPlan(page);
  await page.getByRole("button", { name: "Sketch & annotate" }).click();
  await expect(page.getByRole("button", { name: "Done sketching" })).toBeVisible();
  const bounds = (await page.locator(".canvas-stage").boundingBox())!;
  await page.mouse.move(bounds.x + 140, bounds.y + bounds.height - 160);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 200, bounds.y + bounds.height - 190, { steps: 10 });
  await page.mouse.move(bounds.x + 260, bounds.y + bounds.height - 160, { steps: 10 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done sketching" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).sketches.length)).toBeGreaterThan(0);
  const saved = await page.evaluate(() => localStorage.getItem("homedraw.project.v1")!);
  await page.reload();
  await savedPlan(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).sketches.length)).toBeGreaterThan(0);
  page.on("dialog", dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: "roundtrip.homedraw.json", mimeType: "application/json", buffer: Buffer.from(saved) });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  await savedPlan(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).sketches.length)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("invalid saved project is protected and invalid import is surfaced", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("homedraw.project.v1", "{broken"));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Autosave is paused");
  expect(await page.evaluate(() => localStorage.getItem("homedraw.project.v1"))).toBe("{broken");
  await page.locator('input[type="file"]').setInputFiles({
    name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"version":8}'),
  });
  await expect(page.getByRole("alert")).toContainText("Could not open project");
});

test("mobile drafting controls remain accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("draft-canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Room tool", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("connected wall drawing closes a room and deleting its wall removes openings", async ({ page }) => {
  await page.goto("/");
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await page.getByRole("button", { name: "Start blank plan" }).click();
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  const bounds = (await page.getByTestId("draft-canvas").boundingBox())!;
  const corners = [
    { x: bounds.x + 180, y: bounds.y + 140 },
    { x: bounds.x + 480, y: bounds.y + 140 },
    { x: bounds.x + 480, y: bounds.y + 410 },
    { x: bounds.x + 180, y: bounds.y + 410 },
    { x: bounds.x + 180, y: bounds.y + 140 },
  ];
  for (const point of corners) await page.mouse.click(point.x, point.y);
  let plan = await savedPlan(page);
  expect(plan.walls).toHaveLength(4);
  expect(plan.nodes).toHaveLength(4);
  await expect(page.locator(".room-list button")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit plan", exact: true }).click();
  const wall = plan.walls[0];
  const a = plan.nodes.find(n => n.id === wall.a)!;
  const b = plan.nodes.find(n => n.id === wall.b)!;
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.getByRole("button", { name: "Door tool", exact: true }).click();
  await clickWorld(page, center);
  await expect(page.getByRole("button", { name: "Flip door swing" })).toBeVisible();
  await page.getByRole("button", { name: "Flip door swing" }).click();
  plan = await savedPlan(page);
  expect(plan.openings).toHaveLength(1);
  expect(plan.openings[0].flip).toBe(true);

  await clickWorld(page, { x: a.x * 0.85 + b.x * 0.15, y: a.y * 0.85 + b.y * 0.15 });
  await page.getByRole("button", { name: "Delete wall", exact: true }).click();
  plan = await savedPlan(page);
  expect(plan.walls).toHaveLength(3);
  expect(plan.openings).toHaveLength(0);
  await expect(page.locator(".room-list button")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  plan = await savedPlan(page);
  expect(plan.walls).toHaveLength(4);
  expect(plan.openings).toHaveLength(1);
  await expect(page.locator(".room-list button")).toHaveCount(1);
});

test("wall dragging remains aligned after zooming and panning", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const wall = original.walls.find(w => {
    const a = original.nodes.find(n => n.id === w.a)!;
    const b = original.nodes.find(n => n.id === w.b)!;
    return a.x === 4200 && b.x === 4200;
  })!;
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const canvasBounds = (await page.getByTestId("draft-canvas").boundingBox())!;
  await page.mouse.move(canvasBounds.x + 100, canvasBounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBounds.x + 135, canvasBounds.y + 125, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const drag = await page.getByTestId("draft-canvas").evaluate(svg => {
    const matrix = svg.querySelector("g")!.getScreenCTM()!;
    const point = new DOMPoint(4200, 2400).matrixTransform(matrix);
    return { x: point.x, y: point.y, dx: 250 * matrix.a };
  });
  const wallPixel = await canvasPixelAt(page, { x: 4200, y: 2400 });
  const openingPixel = await canvasPixelAt(page, { x: 4200, y: 3500 });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.dx, drag.y, { steps: 8 });
  await expect(page.locator(".selection-line")).toHaveAttribute("x1", "4450");
  await expect(page.locator(".selection-line")).toHaveAttribute("x2", "4450");
  await expect(page.locator(".room-list button").filter({ hasText: "Living room" })).toContainText("21.36");
  await expect(page.locator(".room-list button").filter({ hasText: "Kitchen" })).toContainText("11.28");
  const top = original.walls.find(w => original.nodes.find(n => n.id === w.a)!.y === 0
    && original.nodes.find(n => n.id === w.b)!.y === 0
    && original.nodes.find(n => n.id === w.a)!.x === 0)!;
  await expect(page.getByTestId(`dimension-${top.id}`)).toHaveAttribute("aria-label", "Edit measurement 4.45 m");
  await expect.poll(() => canvasPixelAt(page, { x: 4450, y: 2400 })).toEqual(wallPixel);
  await expect.poll(() => canvasPixelAt(page, { x: 4450, y: 3500 })).toEqual(openingPixel);
  expect(await canvasPixelAt(page, { x: 4200, y: 2400 })).not.toEqual(wallPixel);
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  const preview = await page.locator("canvas.excalidraw__canvas.static").evaluate(canvas =>
    (canvas as HTMLCanvasElement).toDataURL());
  await page.mouse.up();
  const moved = await savedPlan(page);
  for (const id of [wall.a, wall.b]) {
    expect(moved.nodes.find(n => n.id === id)!.x).toBe(4450);
  }
  expect(moved.openings).toEqual(original.openings);
  await expect.poll(() => page.locator("canvas.excalidraw__canvas.static").evaluate(canvas =>
    (canvas as HTMLCanvasElement).toDataURL())).toBe(preview);
  await expect(page.locator(".room-list button")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await savedPlan(page)).nodes).toEqual(original.nodes);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
});

test("wall live previews cancel cleanly and allow warned drops without saving partial moves", async ({ page }) => {
  const original: Plan = {
    version: 1, name: "Live room", units: "metric", roomNames: {},
    nodes: [
      { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 },
      { id: "c", x: 4000, y: 3000 }, { id: "d", x: 0, y: 3000 },
    ],
    walls: [
      { id: "top", a: "a", b: "b", thickness: 150, dimension: true },
      { id: "right", a: "b", b: "c", thickness: 150, dimension: true },
      { id: "bottom", a: "c", b: "d", thickness: 150, dimension: true },
      { id: "left", a: "d", b: "a", thickness: 150, dimension: true },
    ],
    openings: [{ id: "door", wallId: "right", kind: "door", offset: 1200, width: 900, flip: false }],
  };
  await page.addInitScript(plan => localStorage.setItem("homedraw.project.v1", JSON.stringify({
    format: "homedraw", version: 1, plan, sketches: [],
  })), original);
  await page.goto("/");
  await savedPlan(page);
  const positions = await page.getByTestId("draft-canvas").evaluate(svg => {
    const matrix = svg.querySelector("g")!.getScreenCTM()!;
    const at = (x: number, y: number) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: p.x, y: p.y };
    };
    return { start: at(2000, 0), valid: at(2000, 500), invalid: at(2000, 1800) };
  });
  const begin = async () => {
    await page.mouse.move(positions.start.x, positions.start.y);
    await page.mouse.down();
    await page.mouse.move(positions.valid.x, positions.valid.y, { steps: 8 });
    await expect(page.locator(".selection-line")).toHaveAttribute("y1", "500");
    await expect(page.locator(".room-list button")).toContainText("10 m");
    expect(await savedPlan(page)).toEqual(original);
  };
  await begin();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".room-list button")).toContainText("12 m");
  expect(await savedPlan(page)).toEqual(original);
  await begin();
  await page.getByTestId("draft-canvas").dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(page.locator(".room-list button")).toContainText("12 m");
  expect(await savedPlan(page)).toEqual(original);
  await begin();
  await page.mouse.move(positions.invalid.x, positions.invalid.y, { steps: 1 });
  await expect(page.getByTestId("geometry-feedback")).toContainText(/opening/i);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await expect(page.locator(".selection-line")).toHaveAttribute("y1", "1800");
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  await expect(page.locator(".selection-line")).toHaveAttribute("y1", "1800");
  expect((await savedPlan(page)).nodes.find(node => node.id === "a")!.y).toBe(1800);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect(page.getByTestId("geometry-feedback")).toHaveCount(0);
  await begin();
  await page.mouse.move(positions.invalid.x, positions.invalid.y, { steps: 1 });
  await expect(page.getByTestId("geometry-feedback")).toBeVisible();
  await page.mouse.move(positions.valid.x, positions.valid.y, { steps: 1 });
  await expect(page.getByTestId("geometry-feedback")).toHaveCount(0);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(n => n.id === "a")!.y).toBe(500);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("double-clicking a measurement edits it in place with undo, redo and persistence", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const wall = original.walls.find(w => !original.openings.some(o => o.wallId === w.id))!;
  const label = page.getByTestId(`dimension-${wall.id}`);
  const bounds = (await label.boundingBox())!;
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await expect(input).toBeFocused();
  const inputBounds = (await input.boundingBox())!;
  expect(Math.abs(inputBounds.x + inputBounds.width / 2 - bounds.x - bounds.width / 2)).toBeLessThan(2);
  expect(Math.abs(inputBounds.y + inputBounds.height / 2 - bounds.y - bounds.height / 2)).toBeLessThan(2);
  expect(await input.evaluate(element => {
    const field = element as HTMLInputElement;
    return field.selectionEnd! - field.selectionStart! === field.value.length;
  })).toBe(true);
  await input.fill("450 cm");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  const updated = await savedPlan(page);
  const a = updated.nodes.find(n => n.id === wall.a)!;
  const b = updated.nodes.find(n => n.id === wall.b)!;
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(4500);
  expect(a).toEqual(original.nodes.find(n => n.id === wall.a));
  await expect(label).toHaveAttribute("aria-label", "Edit measurement 4.5 m");
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toHaveValue("4.5 m");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(updated);
  await page.reload();
  expect(await savedPlan(page)).toEqual(updated);
  await expect(page.getByTestId(`dimension-${wall.id}`)).toHaveAttribute("aria-label", "Edit measurement 4.5 m");
});

test("inline measurements reject malformed input but allow overhanging openings with feedback", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const opening = original.openings.find(o => o.kind === "window")!;
  const label = page.getByTestId(`dimension-${opening.wallId}`);
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await input.fill("-2 m");
  await input.press("Enter");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#inline-dimension-error")).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await input.fill("0.5 m");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  const shortened = await savedPlan(page);
  expect(shortened.openings).toEqual(original.openings);
  await expect(page.getByTestId("geometry-feedback")).toContainText(/opening/i);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await label.dblclick();
  await input.fill("5 m");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await setUnits(page, "imperial");
  const imperial = await savedPlan(page);
  await label.dblclick();
  await expect(input).toHaveValue(/'/);
  await input.press("Enter");
  expect(await savedPlan(page)).toEqual(imperial);
});

test("vertical dimensions edit after zoom and pan and apply on blur only once", async ({ page }) => {
  await page.goto("/");
  const plan = await savedPlan(page);
  const wall = plan.walls.find(w => {
    const a = plan.nodes.find(n => n.id === w.a)!;
    const b = plan.nodes.find(n => n.id === w.b)!;
    return a.x === 6800 && b.x === 6800;
  })!;
  await setUnits(page, "imperial");
  const original = await savedPlan(page);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const canvas = (await page.getByTestId("draft-canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 200, canvas.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 170, canvas.y + 125, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  await page.getByTestId(`dimension-${wall.id}`).dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await input.fill("16' 6 1/2\"");
  await page.getByRole("textbox", { name: "Project name" }).focus();
  await expect(input).toHaveCount(0);
  const updated = await savedPlan(page);
  const a = updated.nodes.find(n => n.id === wall.a)!;
  const b = updated.nodes.find(n => n.id === wall.b)!;
  expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(5041.9);
  expect(updated.openings).toEqual(original.openings);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("dimension labels drag on their normal axis with live preview, one undo step and project persistence", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const wall = original.walls[0];
  const label = page.getByTestId(`dimension-${wall.id}`);
  const before = (await label.boundingBox())!;
  const scale = await page.getByTestId("draft-canvas").evaluate(svg => svg.querySelector("g")!.getScreenCTM()!.a);
  const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 55, start.y - 65, { steps: 8 });
  await expect.poll(async () => (await label.boundingBox())!.y).toBeCloseTo(before.y - 65, 0);
  const preview = (await label.boundingBox())!;
  expect(preview.x + preview.width / 2).toBeCloseTo(start.x, 0);
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes).toEqual(original.nodes);
  expect(moved.openings).toEqual(original.openings);
  expect(moved.walls.slice(1)).toEqual(original.walls.slice(1));
  expect(moved.walls[0].dimensionOffset).toBeCloseTo(-425 - 65 / scale, 0);
  await expect(label).toHaveAttribute("aria-label", "Edit measurement 4.2 m");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.reload();
  expect(await savedPlan(page)).toEqual(moved);

  await page.locator(".export-menu summary").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project" }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = Buffer.concat(chunks);
  expect(JSON.parse(exported.toString()).plan).toEqual(moved);
  page.on("dialog", dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({
    name: "dimensions.homedraw.json", mimeType: "application/json", buffer: exported,
  });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(moved);
  await page.locator(".export-menu summary").click();
  await label.dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await expect(input).toBeFocused();
  await input.fill("4.4 m");
  await input.press("Enter");
  const resized = await savedPlan(page);
  expect(resized.walls[0].dimensionOffset).toBe(moved.walls[0].dimensionOffset);
  expect(resized.nodes.find(n => n.id === wall.b)!.x).toBe(4400);
});

test("dimension line dragging works across the wall after zooming and panning", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const wall = original.walls.find(w => original.nodes.find(n => n.id === w.a)!.x === 6800
    && original.nodes.find(n => n.id === w.b)!.x === 6800)!;
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const canvas = (await page.getByTestId("draft-canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 150, canvas.y + 130);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 120, canvas.y + 150, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Dimension tool", exact: true }).click();
  const label = page.getByTestId(`dimension-${wall.id}`);
  const before = (await label.boundingBox())!;
  const line = page.getByTestId(`dimension-line-${wall.id}`);
  const start = await line.evaluate(element => {
    const line = element as SVGLineElement;
    const point = new DOMPoint(
      line.x1.baseVal.value * 0.75 + line.x2.baseVal.value * 0.25,
      line.y1.baseVal.value * 0.75 + line.y2.baseVal.value * 0.25,
    ).matrixTransform(line.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  const scale = await page.getByTestId("draft-canvas").evaluate(svg => svg.querySelector("g")!.getScreenCTM()!.a);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 95, start.y + 30, { steps: 8 });
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.walls.find(w => w.id === wall.id)!.dimensionOffset).toBeCloseTo(-425 + 95 / scale, 0);
  expect(moved.nodes).toEqual(original.nodes);
  expect(moved.walls.find(w => w.id === wall.id)!.dimension).toBe(true);
  await expect.poll(async () => {
    const bounds = (await label.boundingBox())!;
    return bounds.x + bounds.width / 2;
  }).toBeCloseTo(before.x + before.width / 2 - 95, 0);
  const after = (await label.boundingBox())!;
  expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 0);
});

test("dimension drag cancellation and along-wall movement do not change geometry or history", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const wall = original.walls[0];
  const label = page.getByTestId(`dimension-${wall.id}`);
  const before = (await label.boundingBox())!;
  const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await label.click();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y, { steps: 6 });
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - 60, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await expect.poll(async () => (await label.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - 40, { steps: 6 });
  await label.dispatchEvent("pointercancel");
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await expect.poll(async () => (await label.boundingBox())!.y).toBeCloseTo(before.y, 0);
});

test("angled wall measurements ignore pointer movement along the wall", async ({ page }) => {
  const plan: Plan = {
    version: 1, name: "Angled wall", units: "metric", roomNames: {}, openings: [],
    nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 3000, y: 3000 }],
    walls: [{ id: "angled", a: "a", b: "b", thickness: 150, dimension: true }],
  };
  await page.addInitScript(plan => localStorage.setItem("homedraw.project.v1", JSON.stringify({
    format: "homedraw", version: 1, plan, sketches: [],
  })), plan);
  await page.goto("/");
  await savedPlan(page);
  const label = page.getByTestId("dimension-angled");
  const before = (await label.boundingBox())!;
  const center = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const scale = await page.getByTestId("draft-canvas").evaluate(svg => svg.querySelector("g")!.getScreenCTM()!.a);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 20, center.y + 80, { steps: 8 });
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.walls[0].dimensionOffset).toBeCloseTo(425 + Math.sqrt(5000) / scale, 0);
  expect(moved.nodes).toEqual(plan.nodes);
  const after = (await label.boundingBox())!;
  expect(after.x + after.width / 2).toBeCloseTo(center.x - 50, 0);
  expect(after.y + after.height / 2).toBeCloseTo(center.y + 50, 0);
  await label.dblclick();
  await expect(page.getByRole("textbox", { name: "Edit dimension", exact: true })).toBeFocused();
});

test("dragging a shared node reshapes every connected wall live and saves one undo step", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const node = original.nodes.find(n => n.x === 4200 && n.y === 0)!;
  const top = original.walls.find(w => w.b === node.id && original.nodes.find(n => n.id === w.a)!.x === 0)!;
  const target = page.getByTestId(`node-${node.id}`);
  const positions = await target.evaluate(element => {
    const circle = element as SVGCircleElement;
    const matrix = circle.getScreenCTM()!;
    const at = (x: number, y: number) => {
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    return { start: at(4200, 0), end: at(4450, 250) };
  });
  const wallPixel = await canvasPixelAt(page, { x: 1000, y: 0 });
  await page.mouse.move(positions.start.x, positions.start.y);
  await page.mouse.down();
  await page.mouse.move(positions.end.x, positions.end.y, { steps: 10 });
  await expect(target).toHaveAttribute("cx", "4450");
  await expect(target).toHaveAttribute("cy", "250");
  await expect(page.getByTestId(`dimension-${top.id}`)).toHaveAttribute("aria-label", /4\.457 m/);
  for (const other of original.nodes.filter(n => n.id !== node.id)) {
    await expect(page.getByTestId(`node-${other.id}`)).toHaveAttribute("cx", String(other.x));
    await expect(page.getByTestId(`node-${other.id}`)).toHaveAttribute("cy", String(other.y));
  }
  await expect.poll(() => canvasPixelAt(page, { x: 1000, y: 1000 * 250 / 4450 })).toEqual(wallPixel);
  expect(await savedPlan(page)).toEqual(original);
  const preview = await page.locator("canvas.excalidraw__canvas.static").evaluate(element =>
    (element as HTMLCanvasElement).toDataURL());
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(n => n.id === node.id)).toMatchObject({ x: 4450, y: 250 });
  expect(moved.nodes.filter(n => n.id !== node.id)).toEqual(original.nodes.filter(n => n.id !== node.id));
  expect(moved.walls).toEqual(original.walls);
  expect(moved.openings).toEqual(original.openings);
  await expect(page.locator(".room-list button")).toHaveCount(2);
  await expect.poll(() => page.locator("canvas.excalidraw__canvas.static").evaluate(element =>
    (element as HTMLCanvasElement).toDataURL())).toBe(preview);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.reload();
  expect(await savedPlan(page)).toEqual(moved);
  await expect(page.getByTestId(`node-${node.id}`)).toHaveAttribute("cx", "4450");
});

test("node handles preserve grab offset after zooming and panning and honor Shift and Alt", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const node = original.nodes.find(n => n.x === 6800 && n.y === 0)!;
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const canvas = (await page.getByTestId("draft-canvas").boundingBox())!;
  await page.mouse.move(canvas.x + 120, canvas.y + 120);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 90, canvas.y + 140, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  const target = page.getByTestId(`node-${node.id}`);
  const coordinates = await target.evaluate(element => {
    const circle = element as SVGCircleElement;
    const matrix = circle.getScreenCTM()!;
    const point = new DOMPoint(6800, 0).matrixTransform(matrix);
    return { x: point.x + 3, y: point.y + 2, scale: matrix.a };
  });
  await page.mouse.move(coordinates.x, coordinates.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(coordinates.x + 277 * coordinates.scale, coordinates.y + 173 * coordinates.scale, { steps: 8 });
  await expect(target).toHaveAttribute("cx", "7100");
  await expect(target).toHaveAttribute("cy", "0");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Shift");
  await page.mouse.up();
  expect(await savedPlan(page)).toEqual(original);
  await expect(target).toHaveAttribute("cx", "6800");
  await page.mouse.move(coordinates.x, coordinates.y);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(coordinates.x + 277 * coordinates.scale, coordinates.y + 173 * coordinates.scale, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const moved = await savedPlan(page);
  const end = moved.nodes.find(n => n.id === node.id)!;
  expect(end.x).toBeCloseTo(7077, 0);
  expect(end.y).toBeCloseTo(173, 0);
  expect(moved.nodes.filter(n => n.id !== node.id)).toEqual(original.nodes.filter(n => n.id !== node.id));
});

test("node drags cancel or retain collapsed walls with red feedback", async ({ page }) => {
  await page.goto("/");
  const original = await savedPlan(page);
  const node = original.nodes.find(n => n.x === 4200 && n.y === 0)!;
  const target = page.getByTestId(`node-${node.id}`);
  const positions = await target.evaluate(element => {
    const matrix = (element as SVGCircleElement).getScreenCTM()!;
    const at = (x: number, y: number) => {
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    };
    return { start: at(4200, 0), valid: at(4450, 250), invalid: at(6800, 0) };
  });
  const begin = async () => {
    await page.mouse.move(positions.start.x, positions.start.y);
    await page.mouse.down();
    await page.mouse.move(positions.valid.x, positions.valid.y, { steps: 8 });
    await expect(target).toHaveAttribute("cx", "4450");
  };
  await begin();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(target).toHaveAttribute("cx", "4200");
  expect(await savedPlan(page)).toEqual(original);
  await begin();
  await page.getByTestId("draft-canvas").dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(target).toHaveAttribute("cx", "4200");
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("textbox", { name: "Wall length", exact: true }).focus();
  await begin();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(target).toHaveAttribute("cx", "4200");
  expect(await savedPlan(page)).toEqual(original);
  await begin();
  await page.getByTestId("draft-canvas").dispatchEvent("lostpointercapture");
  await page.mouse.up();
  await expect(target).toHaveAttribute("cx", "4200");
  expect(await savedPlan(page)).toEqual(original);
  await begin();
  await page.mouse.move(positions.invalid.x, positions.invalid.y, { steps: 1 });
  await expect(page.getByTestId("geometry-feedback")).toBeVisible();
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await expect(target).toHaveAttribute("cx", "6800");
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  await expect(target).toHaveAttribute("cx", "6800");
  const collapsed = await savedPlan(page);
  expect(collapsed.nodes.find(n => n.id === node.id)).toMatchObject({ x: 6800, y: 0 });
  expect(collapsed.walls).toEqual(original.walls);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await begin();
  await page.mouse.move(positions.invalid.x, positions.invalid.y);
  await expect(page.getByTestId("geometry-feedback")).toBeVisible();
  await page.mouse.move(positions.valid.x, positions.valid.y);
  await expect(target).toHaveAttribute("cx", "4450");
  await expect(page.getByTestId("geometry-feedback")).toHaveCount(0);
  await page.mouse.up();
  const recovered = await savedPlan(page);
  expect(recovered.nodes.find(n => n.id === node.id)).toMatchObject({ x: 4450, y: 250 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});
