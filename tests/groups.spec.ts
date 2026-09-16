import { expect, test, type Page } from "@playwright/test";
import type { Project } from "../src/storage";
import { addRoom, createEmptyPlan, type Plan, type Point } from "../src/model";

const planFixture = (): Plan => ({
  version: 1, name: "Grouped renovation", units: "metric", roomNames: {},
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 2000, y: 0 }, { id: "c", x: 2000, y: 2000 },
    { id: "d", x: 4500, y: 0 }, { id: "e", x: 6500, y: 0 },
  ],
  walls: [
    { id: "first", a: "a", b: "b", thickness: 150, dimension: false },
    { id: "second", a: "b", b: "c", thickness: 150, dimension: false },
    { id: "third", a: "d", b: "e", thickness: 150, dimension: false },
  ],
  openings: [{ id: "door", wallId: "first", kind: "door", offset: 1000, width: 500, flip: false }],
});

async function saved(page: Page): Promise<Project> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!));
}

async function load(page: Page) {
  await page.addInitScript(plan => {
    if (!localStorage.getItem("homedraw.project.v1")) localStorage.setItem("homedraw.project.v1", JSON.stringify({
      format: "homedraw", version: 1, plan, sketches: [
        { id: "label", type: "text", x: 50, y: 80, width: 120, height: 25, text: "Remove wall", fontSize: 20, fontFamily: 5 },
        { id: "other-label", type: "text", x: 480, y: 100, width: 120, height: 25, text: "Keep this", fontSize: 20, fontFamily: 5 },
      ],
    }));
  }, planFixture());
  await page.goto("/");
  return saved(page);
}

async function screen(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const p = new DOMPoint(point.x, point.y).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, point);
}
async function click(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.click(p.x, p.y);
}
async function drag(page: Page, from: Point, to: Point, release = true) {
  const a = await screen(page, from), b = await screen(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  if (release) await page.mouse.up();
}
async function createMixedGroup(page: Page) {
  await drag(page, { x: -300, y: -300 }, { x: 2300, y: 2300 });
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  await page.keyboard.press("Control+g");
  const project = await saved(page);
  expect(project.groups).toHaveLength(1);
  expect(project.groups![0].members).toEqual(expect.arrayContaining([
    { kind: "wall", id: "first" }, { kind: "wall", id: "second" }, { kind: "note", id: "label" },
  ]));
  return project;
}
const label = (project: Project) => project.sketches.find(note => note.id === "label")!;

for (const width of [1440, 390]) test(`mixed groups select, move and undo as one persistent object at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const original = await load(page);
  const grouped = await createMixedGroup(page);
  await click(page, { x: 3000, y: 2600 });
  await click(page, { x: 400, y: 0 });
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  await expect(page.getByRole("button", { name: "Ungroup selection", exact: true })).toBeVisible();
  await drag(page, { x: 400, y: 0 }, { x: 900, y: 300 }, false);
  await expect(page.getByTestId("node-a")).toHaveAttribute("cx", "500");
  expect((await saved(page)).plan).toEqual(original.plan);
  expect(label(await saved(page)).x).toBe(label(original).x);
  await page.mouse.up();
  const moved = await saved(page);
  expect(moved.plan.nodes.slice(0, 3)).toEqual(original.plan.nodes.slice(0, 3).map(node => ({
    ...node, x: node.x + 500, y: node.y + 300,
  })));
  expect(moved.plan.nodes.slice(3)).toEqual(original.plan.nodes.slice(3));
  expect(label(moved)).toMatchObject({ x: label(original).x + 50, y: label(original).y + 30 });
  expect(moved.groups).toEqual(grouped.groups);
  await page.screenshot({ path: testInfo.outputPath("mixed-group.png") });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).plan).toEqual(original.plan);
  expect(label(await saved(page))).toMatchObject({ x: label(original).x, y: label(original).y });
  expect((await saved(page)).groups).toEqual(grouped.groups);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).groups ?? []).toEqual([]);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await saved(page)).plan).toEqual(moved.plan);
  await page.reload();
  expect((await saved(page)).groups).toEqual(grouped.groups);
  expect(label(await saved(page))).toMatchObject({ x: label(moved).x, y: label(moved).y });
  await click(page, { x: 900, y: 300 });
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
});

test("dragging grouped text moves its walls and Escape cancels the entire preview", async ({ page }) => {
  await load(page);
  const original = await createMixedGroup(page);
  await click(page, { x: 3000, y: 2600 });
  await page.keyboard.down("Alt");
  await drag(page, { x: 700, y: 900 }, { x: 1100, y: 1100 }, false);
  await expect.poll(async () => Number(await page.getByTestId("node-a").getAttribute("cx"))).toBeCloseTo(400, 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect((await saved(page)).plan).toEqual(original.plan);
  expect(label(await saved(page))).toMatchObject({ x: label(original).x, y: label(original).y });
  await page.keyboard.down("Shift");
  await drag(page, { x: 700, y: 900 }, { x: 1100, y: 1100 });
  await page.keyboard.up("Shift");
  const moved = await saved(page);
  expect(moved.plan.nodes[0]).toMatchObject({ x: 400, y: 0 });
  expect(label(moved)).toMatchObject({ x: label(original).x + 40, y: label(original).y });
});

test("nested groups ungroup one level at a time and keep geometry unchanged", async ({ page }) => {
  await load(page);
  const inner = await createMixedGroup(page);
  await page.keyboard.down("Shift");
  await click(page, { x: 5500, y: 0 });
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-count")).toHaveText("4 items selected");
  await page.getByRole("button", { name: "Group selection", exact: true }).click();
  const nested = await saved(page);
  expect(nested.groups).toHaveLength(2);
  expect(nested.plan).toEqual(inner.plan);
  await click(page, { x: 3000, y: 2600 });
  await click(page, { x: 400, y: 0 });
  await expect(page.getByTestId("selection-count")).toHaveText("4 items selected");
  await page.keyboard.press("Control+Shift+g");
  expect((await saved(page)).groups).toEqual(inner.groups);
  await click(page, { x: 3000, y: 2600 });
  await click(page, { x: 400, y: 0 });
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
  await page.getByRole("button", { name: "Ungroup selection", exact: true }).click();
  expect((await saved(page)).groups ?? []).toEqual([]);
});

test("deleting a group removes its mixed members and restores all of them with one undo", async ({ page }) => {
  await load(page);
  const original = await createMixedGroup(page);
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await click(page, { x: 3000, y: 2600 });
  await click(page, { x: 700, y: 900 });
  await page.keyboard.press("Delete");
  const deleted = await saved(page);
  expect(deleted.plan.walls.map(wall => wall.id)).toEqual(["third"]);
  expect(deleted.plan.openings).toEqual([]);
  expect(deleted.sketches.map(note => note.id)).toEqual(["other-label"]);
  expect(deleted.groups ?? []).toEqual([]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).plan).toEqual(original.plan);
  expect((await saved(page)).groups).toEqual(original.groups);
  expect((await saved(page)).sketches.map(note => note.id)).toEqual(["label", "other-label"]);
  expect(dialogs).toEqual([]);
});

test("Shift-click combines walls and text and Ctrl-click edits a grouped member", async ({ page }) => {
  const original = await load(page);
  await click(page, { x: 400, y: 0 });
  await page.keyboard.down("Shift");
  await click(page, { x: 700, y: 900 });
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await page.getByRole("button", { name: "Group selection", exact: true }).click();
  const grouped = await saved(page);
  await page.keyboard.down("Control");
  await click(page, { x: 700, y: 900 });
  await page.keyboard.up("Control");
  const point = await screen(page, { x: 700, y: 900 });
  await page.mouse.dblclick(point.x, point.y);
  const input = page.locator("textarea.excalidraw-wysiwyg");
  await input.fill("Grouped text edited");
  await input.press("Escape");
  expect(label(await saved(page))).toMatchObject({ text: "Grouped text edited" });
  expect((await saved(page)).plan).toEqual(original.plan);
  expect((await saved(page)).groups).toEqual(grouped.groups);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(label(await saved(page))).toMatchObject({ text: "Remove wall" });
  expect((await saved(page)).groups).toEqual(grouped.groups);
});

test("groups survive project export/import and splitting a member wall", async ({ page }) => {
  await load(page);
  await createMixedGroup(page);
  await page.keyboard.down("Control");
  const point = await screen(page, { x: 1400, y: 0 });
  await page.mouse.dblclick(point.x, point.y);
  await page.keyboard.up("Control");
  const split = await saved(page);
  expect(split.plan.walls).toHaveLength(4);
  expect(split.groups![0].members.filter(member => member.kind === "wall")).toHaveLength(3);
  await page.locator(".export-menu > summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  const buffer = Buffer.concat(chunks);
  expect(JSON.parse(buffer.toString()).groups).toEqual(split.groups);
  await page.locator(".project-menu > summary").click();
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await page.getByRole("button", { name: "Start blank plan", exact: true }).click();
  await saved(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "grouped.homedraw.json", mimeType: "application/json", buffer });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  expect((await saved(page)).groups).toEqual(split.groups);
  await click(page, { x: 400, y: 0 });
  await expect(page.getByTestId("selection-count")).toHaveText("4 items selected");
});

test("text-only groups move, delete and undo without changing the measured plan", async ({ page }) => {
  const original = await load(page);
  await click(page, { x: 700, y: 900 });
  await page.keyboard.down("Shift");
  await click(page, { x: 5000, y: 1100 });
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await page.keyboard.press("Control+g");
  expect((await saved(page)).groups![0].members.every(member => member.kind === "note")).toBe(true);
  await drag(page, { x: 700, y: 900 }, { x: 1100, y: 1100 });
  const moved = await saved(page);
  expect(moved.plan).toEqual(original.plan);
  for (const note of original.sketches) {
    expect(moved.sketches.find(moved => moved.id === note.id)).toMatchObject({ x: note.x + 40, y: note.y + 20 });
  }
  await page.keyboard.press("Delete");
  expect((await saved(page)).sketches).toHaveLength(0);
  expect((await saved(page)).plan).toEqual(original.plan);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).sketches).toHaveLength(2);
  expect((await saved(page)).groups).toEqual(moved.groups);
});

test("ungrouped notes remain selectable regardless of membership order", async ({ page }) => {
  const original = await load(page);
  await page.addInitScript(project => {
    project.sketches.push({ ...project.sketches[0], id: "third-label", x: 350, y: 220 });
    project.groups = [{ id: "notes-group", members: [
      { kind: "note", id: "other-label" }, { kind: "note", id: "label" },
    ] }];
    localStorage.setItem("homedraw.project.v1", JSON.stringify(project));
  }, { ...original, sketches: [...original.sketches] });
  await page.reload();
  await saved(page);
  await click(page, { x: 5000, y: 1100 });
  await expect(page.getByTestId("selection-count")).toHaveText("2 items selected");
  await page.keyboard.press("Control+Shift+g");
  expect((await saved(page)).groups ?? []).toEqual([]);
  await click(page, { x: 3600, y: 2300 });
  await expect(page.getByTestId("selection-count")).toHaveCount(0);
  await page.keyboard.press("Delete");
  expect((await saved(page)).sketches.map(note => note.id)).toEqual(original.sketches.map(note => note.id));
});

test("marquee selection respects whole groups instead of selecting a covered junction alone", async ({ page }) => {
  await load(page);
  const grouped = await createMixedGroup(page);
  await click(page, { x: 3000, y: 2600 });
  await drag(page, { x: -300, y: -300 }, { x: 1000, y: 300 });
  await expect(page.getByTestId("selection-bounds")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ungroup selection", exact: true })).toHaveCount(0);
  await page.keyboard.press("Delete");
  expect((await saved(page)).plan).toEqual(grouped.plan);
  expect((await saved(page)).groups).toEqual(grouped.groups);
  await drag(page, { x: -300, y: -300 }, { x: 2300, y: 2300 });
  await expect(page.getByTestId("selection-count")).toHaveText("3 items selected");
});

test("a room and its custom text form one group with stable wall membership", async ({ page }) => {
  const plan = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
  await page.addInitScript(plan => localStorage.setItem("homedraw.project.v1", JSON.stringify({
    format: "homedraw", version: 1, plan, sketches: [
      { id: "label", type: "text", x: 120, y: 120, width: 120, height: 25, text: "Work area", fontSize: 20, fontFamily: 5 },
    ],
  })), plan);
  await page.goto("/");
  const original = await saved(page);
  await page.locator(".rooms-menu > summary").click();
  await page.locator(".room-list button").first().click();
  await page.keyboard.down("Shift");
  await click(page, { x: 1400, y: 1300 });
  await page.keyboard.up("Shift");
  await page.keyboard.press("Control+g");
  const grouped = await saved(page);
  expect(grouped.groups![0].members.filter(member => member.kind === "wall")).toHaveLength(4);
  expect(grouped.groups![0].members.some(member => member.kind === "room")).toBe(false);
  await click(page, { x: 4500, y: 3500 });
  await click(page, { x: 3000, y: 2200 });
  await expect(page.getByTestId("selection-count")).toHaveText("5 items selected");
  await drag(page, { x: 3000, y: 2200 }, { x: 3400, y: 2450 });
  const moved = await saved(page);
  expect(moved.plan.nodes).toEqual(original.plan.nodes.map(node => ({ ...node, x: node.x + 400, y: node.y + 250 })));
  expect(label(moved)).toMatchObject({ x: 160, y: 145 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).plan).toEqual(original.plan);
  expect(label(await saved(page))).toMatchObject({ x: 120, y: 120 });
});

test("pasted native annotation groups enter project grouping and undo in one step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const original = await load(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await click(page, { x: 700, y: 900 });
  await page.evaluate(async notes => {
    await navigator.clipboard.writeText(JSON.stringify({
      type: "excalidraw/clipboard", elements: notes.map(note => ({ ...note, groupIds: ["clipboard-group"] })), files: {},
    }));
  }, original.sketches);
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await saved(page)).sketches.length).toBe(4);
  const pasted = await saved(page);
  expect(pasted.groups).toHaveLength(1);
  expect(pasted.groups![0].members).toHaveLength(2);
  expect(pasted.groups![0].members.every(member => member.kind === "note"
    && !original.sketches.some(note => note.id === member.id))).toBe(true);
  expect(pasted.sketches.every(note => note.groupIds.length === 0)).toBe(true);
  await expect(page.getByRole("button", { name: "Ungroup selection", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await saved(page)).sketches.map(note => note.id)).toEqual(original.sketches.map(note => note.id));
  expect((await saved(page)).groups ?? []).toEqual([]);
  expect(errors).toEqual([]);
});
