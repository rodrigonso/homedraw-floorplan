import { expect, test, type Page } from "@playwright/test";
import type { Project } from "../src/storage";
import { addRoom, createEmptyPlan } from "../src/model";
import { palette } from "../src/theme";

async function saved(page: Page): Promise<Project> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!));
}

async function openNotes(page: Page) {
  await page.goto("/");
  const original = await saved(page);
  await page.getByRole("button", { name: "Renovation notes", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Notes tools" })).toBeVisible();
  return original;
}

async function draw(page: Page) {
  const width = page.viewportSize()!.width;
  await page.mouse.move(width / 3, 350);
  await page.mouse.down();
  await page.mouse.move(width / 3 + 40, 370, { steps: 5 });
  await page.mouse.move(width / 3 + 60, 345, { steps: 5 });
  await page.mouse.up();
}

test("project shortcuts share note selection, deletion and history from the properties panel", async ({ page }) => {
  const original = await openNotes(page);
  await draw(page);
  const created = (await saved(page)).sketches;
  expect(created).toHaveLength(1);
  const color = page.getByRole("button", { name: "Red notes", exact: true });
  await color.focus();
  await page.keyboard.press("Control+a");
  await expect(page.getByRole("button", { name: "Delete selected notes", exact: true })).toBeVisible();
  await page.keyboard.press("Delete");
  expect((await saved(page)).sketches).toHaveLength(0);
  await page.keyboard.press("Control+z");
  expect((await saved(page)).sketches.map(note => note.id)).toEqual(created.map(note => note.id));
  await page.keyboard.press("Control+Shift+z");
  expect((await saved(page)).sketches).toHaveLength(0);
  expect((await saved(page)).plan).toEqual(original.plan);
});

for (const width of [1440, 390, 320]) {
  test(`Text places freely movable and editable text boxes from the main toolbar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    const original = await saved(page);
    await page.getByRole("button", { name: "Text tool", exact: true }).click();
    await expect(page.getByRole("button", { name: "Text tool", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("navigation", { name: "Drawing tools", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Wall tool", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Done notes", exact: true })).toHaveCount(0);
    await page.mouse.click(60, 250);
    const input = page.locator("textarea.excalidraw-wysiwyg");
    await input.fill("Paint trim\nKeep door");
    const bounds = (await input.boundingBox())!;
    const point = { x: bounds.x + bounds.width / 4, y: bounds.y + bounds.height / 4 };
    await input.press("Escape");
    await expect(page.getByRole("button", { name: "Select tool", exact: true })).toHaveAttribute("aria-pressed", "true");
    const created = (await saved(page)).sketches;
    expect(created).toEqual([expect.objectContaining({ type: "text", text: "Paint trim\nKeep door", containerId: null })]);

    await page.getByRole("button", { name: "Select tool", exact: true }).click();
    if (width === 1440) {
      await page.keyboard.press("Delete");
      expect((await saved(page)).sketches).toHaveLength(0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect((await saved(page)).sketches).toHaveLength(1);
      await page.mouse.click(point.x, point.y);
      await page.mouse.move(bounds.x + bounds.width + 4, bounds.y + bounds.height + 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width + 34, bounds.y + bounds.height + 22, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => (await saved(page)).sketches[0].width).toBeGreaterThan(created[0].width);
    }
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 35, point.y + 45, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await saved(page)).sketches[0].x).not.toBe(created[0].x);
    await page.mouse.dblclick(point.x + 35, point.y + 45);
    await expect(input).toHaveValue("Paint trim\nKeep door");
    await input.fill("Replace trim\nKeep door");
    await input.press("Escape");
    expect((await saved(page)).sketches).toEqual([expect.objectContaining({ text: "Replace trim\nKeep door", containerId: null })]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await saved(page)).sketches).toEqual([expect.objectContaining({ text: "Paint trim\nKeep door" })]);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    const edited = (await saved(page)).sketches[0];
    expect(edited).toMatchObject({ text: "Replace trim\nKeep door" });
    expect((await saved(page)).plan).toEqual(original.plan);
    await page.mouse.click(30, 600);
    await page.keyboard.press("Control+z");
    expect((await saved(page)).sketches).toEqual([expect.objectContaining({ text: "Paint trim\nKeep door" })]);
    await page.keyboard.press("Control+Shift+z");
    expect((await saved(page)).sketches).toEqual([expect.objectContaining({ text: "Replace trim\nKeep door" })]);
    await page.reload();
    expect((await saved(page)).sketches).toEqual([expect.objectContaining({
      type: "text", text: "Replace trim\nKeep door", containerId: null, x: edited.x, y: edited.y,
    })]);
    expect((await saved(page)).plan).toEqual(original.plan);
  });
}

test("T opens text placement from drafting without intercepting text fields or changing the Notes default", async ({ page }) => {
  await page.goto("/");
  await saved(page);
  await page.getByRole("textbox", { name: "Project name" }).press("t");
  await expect(page.getByTestId("draft-canvas")).toBeVisible();
  await page.getByTestId("draft-canvas").focus();
  await page.keyboard.press("t");
  await expect(page.getByRole("button", { name: "Text tool", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(100, 250);
  const input = page.locator("textarea.excalidraw-wysiwyg");
  await input.fill("Check clearance");
  await input.press("Escape");
  expect((await saved(page)).sketches).toEqual([expect.objectContaining({ type: "text", text: "Check clearance" })]);
  await page.keyboard.press("w");
  await expect(page.getByRole("button", { name: "Wall tool", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "New wall thickness", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Renovation notes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Draw note", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Done notes", exact: true }).click();
  await page.getByRole("button", { name: "Text tool", exact: true }).click();
  await expect(page.getByRole("button", { name: "Text tool", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("overlapping saved text remains selectable alongside measured walls in the normal editor", async ({ page }, testInfo) => {
  const plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
  const annotations = [
    { id: "lower", type: "text", x: 100, y: 100, width: 160, height: 25, text: "Lower label", fontSize: 20 },
    { id: "upper", type: "text", x: 110, y: 105, width: 160, height: 25, text: "Custom room label", fontSize: 20 },
  ];
  await page.addInitScript(project => localStorage.setItem("homedraw.project.v1", JSON.stringify(project)),
    { format: "homedraw", version: 1, plan, sketches: annotations });
  await page.goto("/");
  await saved(page);
  const point = await page.getByTestId("draft-canvas").evaluate(svg => {
    const point = new DOMPoint(1200, 1150).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.press("Delete");
  expect((await saved(page)).sketches.map(note => note.id)).toEqual(["lower"]);
  expect((await saved(page)).plan).toEqual(plan);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).sketches.map(note => note.id)).toEqual(["lower", "upper"]);
  await page.getByTestId(`dimension-${plan.walls[0].id}`).dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await input.fill("5 m");
  await input.press("Enter");
  const resized = (await saved(page)).plan;
  expect(resized.nodes).not.toEqual(plan.nodes);
  await page.mouse.dblclick(point.x, point.y);
  const text = page.locator("textarea.excalidraw-wysiwyg");
  await expect(text).toHaveValue("Custom room label");
  await text.fill("My custom room name");
  await text.press("Escape");
  expect((await saved(page)).plan).toEqual(resized);
  await expect(page.getByRole("button", { name: "Text tool", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Done notes", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("integrated-text.png") });
});

for (const width of [1440, 390, 320]) {
  test(`Homedraw keeps one product shell and working note history at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const original = await openNotes(page);
    await expect(page.getByRole("textbox", { name: "Project name" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quick guide", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Zoom out", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Notes tools" }).getByRole("button")).toHaveCount(6);
    for (const button of await page.getByRole("navigation", { name: "Notes tools" }).getByRole("button").all()) {
      await button.click({ trial: true });
    }
    const nativeButtons = await page.locator(".excalidraw button").evaluateAll(buttons =>
      buttons.filter(button => button.checkVisibility({ visibilityProperty: true })).map(button => button.getAttribute("aria-label")));
    expect(nativeButtons).toEqual([]);
    await expect(page.getByTestId("main-menu-trigger")).not.toBeVisible();
    await expect(page.getByTestId("toolbar-library")).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await draw(page);
    expect((await saved(page)).sketches).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("renovation-notes.png") });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await saved(page)).sketches).toHaveLength(0);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect((await saved(page)).sketches).toHaveLength(1);
    expect((await saved(page)).plan).toEqual(original.plan);
    await page.getByRole("button", { name: "Done notes", exact: true }).click();
    await expect(page.getByTestId("draft-canvas")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await page.reload();
    expect((await saved(page)).sketches).toHaveLength(1);
    expect((await saved(page)).plan).toEqual(original.plan);
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`text, arrows, recoloring and deletion use Notes controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const original = await openNotes(page);
    await page.getByRole("button", { name: "Text note", exact: true }).click();
    await page.mouse.click(width / 3, 350);
    const text = page.locator("textarea.excalidraw-wysiwyg");
    await text.fill("Replace these cabinets");
    await text.press("Escape");
    await expect(text).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Notes tools" })).toBeVisible();
    expect((await saved(page)).sketches).toEqual([expect.objectContaining({ type: "text", text: "Replace these cabinets" })]);
    await page.getByRole("button", { name: "Select notes", exact: true }).click();
    await page.locator(".excalidraw").focus();
    await page.keyboard.press("Control+a");
    await page.getByRole("button", { name: "Red notes", exact: true }).click();
    expect((await saved(page)).sketches[0].strokeColor).toBe(palette.warning);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await saved(page)).sketches[0].strokeColor).toBe(palette.ink);
    await page.getByRole("button", { name: "Arrow note", exact: true }).click();
    await draw(page);
    expect((await saved(page)).sketches.map(note => note.type)).toEqual(["text", "arrow"]);
    await page.getByRole("button", { name: "Select notes", exact: true }).click();
    await page.locator(".excalidraw").focus();
    await page.keyboard.press("Control+a");
    await page.getByRole("button", { name: "Delete selected notes", exact: true }).click();
    expect((await saved(page)).sketches).toHaveLength(0);
    expect((await saved(page)).plan).toEqual(original.plan);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await saved(page)).sketches).toHaveLength(2);
    await page.locator(".excalidraw").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    expect((await saved(page)).sketches).toHaveLength(0);
    expect((await saved(page)).plan).toEqual(original.plan);
  });
}

test("project history keeps notes and measured edits in chronological order across tools", async ({ page }, testInfo) => {
  const original = await openNotes(page);
  await draw(page);
  expect((await saved(page)).sketches).toHaveLength(1);
  await page.getByRole("button", { name: "Done notes", exact: true }).click();
  const wall = original.plan.walls.find(wall => wall.dimension)!;
  await page.getByTestId(`dimension-${wall.id}`).dblclick();
  const input = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await input.fill("5 m");
  await input.press("Enter");
  const resized = (await saved(page)).plan;
  expect(resized.nodes).not.toEqual(original.plan.nodes);
  await page.getByRole("button", { name: "Renovation notes", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).sketches).toHaveLength(1);
  expect((await saved(page)).plan).toEqual(original.plan);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).sketches).toHaveLength(0);
  expect((await saved(page)).plan).toEqual(original.plan);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await saved(page)).sketches).toHaveLength(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await saved(page)).plan).toEqual(resized);
  await page.screenshot({ path: testInfo.outputPath("notes-history-preserves-plan.png") });
  await page.getByRole("button", { name: "Done notes", exact: true }).click();
  await expect(page.getByTestId(`dimension-${wall.id}`)).toHaveAttribute("aria-label", "Edit measurement 5 m");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).plan).toEqual(original.plan);
  expect((await saved(page)).sketches).toHaveLength(1);
});

test("whiteboard shortcuts, menus and file drops do not expose upstream workflows", async ({ page }) => {
  const external: string[] = [];
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== "http://127.0.0.1:5173") external.push(request.url());
  });
  const original = await openNotes(page);
  for (const key of ["?", "Control+k", "Control+f", "Control+/", "f", "9", "k", "l", "o", "d"]) {
    await page.locator(".excalidraw").focus();
    await page.keyboard.press(key);
    await expect(page.getByRole("button", { name: "Draw note", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".excalidraw-modal-container")).toHaveCount(0);
    await expect(page.locator(".excalidraw .sidebar")).not.toBeVisible();
  }
  await page.mouse.click(200, 450, { button: "right" });
  await expect(page.locator(".excalidraw .context-menu")).toHaveCount(0);
  await page.locator(".canvas-engine").evaluate(engine => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['{"type":"excalidraw","elements":[]}'], "drawing.excalidraw", { type: "application/json" }));
    engine.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(page.getByRole("alert")).toContainText("Use Open project");
  expect((await saved(page)).plan).toEqual(original.plan);
  await page.locator(".project-menu > summary").click();
  await expect(page.getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Quick guide", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Quick guide", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText("Excalidraw");
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  expect(external).toEqual([]);
});

test("project shortcuts and exports remain Homedraw-owned while adding notes", async ({ page }) => {
  const original = await openNotes(page);
  await draw(page);
  await saved(page);
  await page.locator(".excalidraw").focus();
  const projectDownload = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const project = await projectDownload;
  expect(project.suggestedFilename()).toMatch(/\.homedraw\.json$/);
  const chunks: Buffer[] = [];
  for await (const chunk of (await project.createReadStream())!) chunks.push(Buffer.from(chunk));
  const exported: Project = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.format).toBe("homedraw");
  expect(exported.plan).toEqual(original.plan);
  expect(exported.sketches).toHaveLength(1);
  await page.locator(".export-menu > summary").click();
  const imageDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  expect((await imageDownload).suggestedFilename()).toMatch(/\.svg$/);
  await expect(page.getByRole("navigation", { name: "Notes tools" })).toBeVisible();
});

test("legacy shape annotations remain editable without reintroducing generic shape tools", async ({ page }) => {
  const plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
  await page.addInitScript(plan => localStorage.setItem("homedraw.project.v1", JSON.stringify({
    format: "homedraw", version: 1, plan,
    sketches: [{ id: "legacy-ellipse", type: "ellipse", x: 100, y: 100, width: 120, height: 80, strokeColor: "#e03131" }],
  })), plan);
  await openNotes(page);
  await page.getByRole("button", { name: "Select notes", exact: true }).click();
  await page.locator(".excalidraw").focus();
  await page.keyboard.press("Control+a");
  await page.getByRole("button", { name: "Violet notes", exact: true }).click();
  expect((await saved(page)).sketches).toEqual([expect.objectContaining({ id: "legacy-ellipse", type: "ellipse", strokeColor: palette.accent })]);
  expect((await saved(page)).plan).toEqual(plan);
  await expect(page.getByRole("navigation", { name: "Notes tools" }).getByRole("button")).toHaveCount(6);
});

for (const source of ["graph TD\n A --> B", "https://www.youtube.com/watch?v=renovation-note"]) {
  test(`pasted ${source.startsWith("graph") ? "diagram source" : "video links"} remain text notes without integrations`, async ({ page }) => {
    const external: string[] = [];
    await page.route("https://**/*", route => { external.push(route.request().url()); return route.abort(); });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const original = await openNotes(page);
    await page.getByRole("button", { name: "Select notes", exact: true }).click();
    await page.mouse.move(250, 400);
    await page.locator(".excalidraw").focus();
    await page.evaluate(text => navigator.clipboard.writeText(text), source);
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await saved(page)).sketches.length).toBeGreaterThan(0);
    const notes = (await saved(page)).sketches;
    expect(notes.every(note => note.type === "text")).toBe(true);
    expect(notes.filter(note => note.type === "text").map(note => note.text).join("\n")).toContain(source.trim().replace("\n ", "\n"));
    expect((await saved(page)).plan).toEqual(original.plan);
    await expect(page.locator(".excalidraw-modal-container")).toHaveCount(0);
    expect(external).toEqual([]);
  });
}
