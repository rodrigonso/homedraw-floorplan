import { expect, test, type Page } from "@playwright/test";
import type { Plan, Point } from "../src/model";

const base: Plan = {
  version: 1, name: "Geometry feedback", units: "metric", roomNames: {}, openings: [],
  nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }],
  walls: [{ id: "base-wall", a: "a", b: "b", thickness: 150, dimension: true }],
};
async function load(page: Page, plan = base) {
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
async function clickWorld(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.click(p.x, p.y);
}

test("crossing walls preview in red, persist without a toast, and can be repaired", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const original = await load(page);
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  await clickWorld(page, { x: 2000, y: -1500 });
  const end = await screen(page, { x: 2000, y: 1500 });
  await page.mouse.move(end.x, end.y);
  await expect(page.locator(".preview-line.invalid-preview")).toHaveCSS("stroke", "rgb(200, 63, 69)");
  await expect(page.getByTestId("geometry-warning-overlay")).toBeVisible();
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.click(end.x, end.y);
  await page.keyboard.press("Escape");
  const crossing = await savedPlan(page);
  expect(crossing.walls).toHaveLength(2);
  await expect(page.getByTestId("geometry-feedback")).toContainText(/cross|meet/i);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByTestId("geometry-warning-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(crossing);
  await page.reload();
  expect(await savedPlan(page)).toEqual(crossing);
  await expect(page.getByTestId("geometry-feedback")).toBeVisible();
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await page.locator(".export-menu summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain("#c83f45");
  await page.locator(".export-menu summary").click();
  const start = await screen(page, { x: 2000, y: 900 }), fixed = await screen(page, { x: 4500, y: 900 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(fixed.x, fixed.y, { steps: 8 });
  await expect(page.getByTestId("geometry-feedback")).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(crossing);
  await page.mouse.up();
  expect((await savedPlan(page)).nodes.filter(node => node.id !== "a" && node.id !== "b").every(node => node.x === 4500)).toBe(true);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("geometry-warning-overlay")).toBeVisible();
  expect(errors).toEqual([]);
});

test("room drawing can cross existing geometry without inventing a valid room area", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "Room tool", exact: true }).click();
  await clickWorld(page, { x: 1000, y: -1000 });
  const end = await screen(page, { x: 3000, y: 1000 });
  await page.mouse.move(end.x, end.y);
  await expect(page.locator(".preview-room.invalid-preview")).toBeVisible();
  await page.mouse.click(end.x, end.y);
  await page.keyboard.press("Escape");
  expect((await savedPlan(page)).walls).toHaveLength(5);
  await expect(page.getByTestId("geometry-feedback")).toBeVisible();
  await expect(page.locator(".room-list button")).toHaveCount(0);
  await expect(page.locator(".toast.error")).toHaveCount(0);
});

test("collapsed walls and their annotations load safely and recover when dragged apart", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const collapsed: Plan = {
    ...base,
    nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }, { id: "c", x: 0, y: 3000 }],
    walls: [
      { id: "first", a: "a", b: "b", thickness: 150, dimension: true },
      { id: "second", a: "a", b: "c", thickness: 150, dimension: true },
    ],
    openings: [{ id: "window", wallId: "first", kind: "window", offset: 500, width: 1000, flip: false }],
    angleDimensions: [{ id: "angle", wallA: "first", wallB: "second", vertex: "a", radius: 500, clockwise: true }],
  };
  expect(await load(page, collapsed)).toEqual(collapsed);
  await expect(page.getByTestId("warning-angle-angle")).toBeVisible();
  await expect(page.getByTestId("dimension-first")).toHaveCount(0);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  const start = await screen(page, { x: 0, y: 0 }), end = await screen(page, { x: 2000, y: 0 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const repaired = await savedPlan(page);
  expect(repaired.nodes.find(node => node.id === "b")).toMatchObject({ x: 2000, y: 0 });
  expect(repaired.openings).toEqual(collapsed.openings);
  expect(repaired.angleDimensions).toEqual(collapsed.angleDimensions);
  await expect(page.getByTestId("geometry-feedback")).toHaveCount(0);
  await expect(page.getByTestId("angle-angle")).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await expect(page.getByTestId("dimension-first")).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [offset, clickX] of [[4400, 4600], [-400, -600]]) test(`overhanging openings at ${offset} remain selectable and editable`, async ({ page }) => {
  const plan: Plan = {
    ...base, openings: [{ id: "window", wallId: "base-wall", kind: "window", offset, width: 1000, flip: false }],
  };
  await load(page, plan);
  await clickWorld(page, { x: clickX, y: 0 });
  const position = page.getByRole("textbox", { name: "Position from wall start", exact: true });
  await expect(position).toBeVisible();
  await position.fill("0 m");
  await position.press("Enter");
  expect((await savedPlan(page)).openings[0].offset).toBe(0);
  await expect(page.getByTestId("geometry-feedback")).toBeVisible();
  await position.fill("2 m");
  await position.press("Enter");
  expect((await savedPlan(page)).openings[0].offset).toBe(2000);
  await expect(page.getByTestId("geometry-warning-overlay")).toHaveCount(0);
  await expect(page.locator(".toast.error")).toHaveCount(0);
});
