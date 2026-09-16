import { expect, test, type Page } from "@playwright/test";
import { distance, formatLength, wallPoints, type Plan, type Point } from "../src/model";

const fixture = (): Plan => ({
  version: 1, name: "Unit choices", units: "metric", roomNames: { "room:a:b:c:d": "Studio" },
  nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 }, { id: "d", x: 0, y: 3000 }],
  walls: [
    { id: "top", a: "a", b: "b", thickness: 150, dimension: true },
    { id: "right", a: "b", b: "c", thickness: 150, dimension: true },
    { id: "bottom", a: "c", b: "d", thickness: 150, dimension: true },
    { id: "left", a: "d", b: "a", thickness: 150, dimension: true },
  ],
  openings: [{ id: "door", wallId: "top", kind: "door", offset: 2000, width: 900, flip: false }],
  thicknessDimensions: [{ id: "thickness", wallId: "top", offset: 350 }],
  angleDimensions: [{ id: "angle", wallA: "top", wallB: "left", vertex: "a", radius: 750, clockwise: true }],
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
    const p = new DOMPoint(point.x, point.y).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: p.x, y: p.y };
  }, point);
}

async function choose(page: Page, units: Plan["units"], lengthUnit?: string) {
  await page.locator(".settings-menu > summary").click();
  await page.getByLabel("Measurement units", { exact: true }).selectOption(units);
  if (lengthUnit) await page.getByLabel("Length units", { exact: true }).selectOption(lengthUnit);
  await page.locator(".settings-menu > summary").click();
  return savedPlan(page);
}

for (const width of [1440, 390]) test(`length unit choices update labels and properties without moving geometry at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const original = await load(page);
  await page.getByTestId("dimension-top").click();
  const length = page.getByRole("textbox", { name: "Wall length", exact: true });
  await expect(length).toHaveValue("4 m");
  const cm = await choose(page, "metric", "cm");
  expect(cm).toEqual({ ...original, lengthUnits: { metric: "cm", imperial: "ft" } });
  await expect(length).toHaveValue("400 cm");
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", "Edit measurement 400 cm");
  await expect(page.getByTestId("thickness-thickness")).toHaveAttribute("aria-label", "Thickness measurement 15 cm");
  await expect(page.getByTestId("angle-angle")).toHaveAttribute("aria-label", "Angle measurement 90\u00b0");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(cm);
  const inches = await choose(page, "imperial", "in");
  expect(inches.lengthUnits).toEqual({ metric: "cm", imperial: "in" });
  expect(inches.nodes).toEqual(original.nodes);
  expect(inches.walls).toEqual(original.walls);
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", 'Edit measurement 157.4803"');
  await expect(page.getByTestId("thickness-thickness")).toHaveAttribute("aria-label", 'Thickness measurement 5.9055"');
  await choose(page, "imperial", "ft");
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", 'Edit measurement 13\' 1.4803"');
  await choose(page, "imperial", "in");
  await choose(page, "metric");
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", "Edit measurement 400 cm");
  await choose(page, "metric", "m");
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", "Edit measurement 4 m");
  await choose(page, "metric", "cm");
  await choose(page, "imperial");
  await page.reload();
  const reloaded = await savedPlan(page);
  expect(reloaded.lengthUnits).toEqual({ metric: "cm", imperial: "in" });
  await page.locator(".settings-menu > summary").click();
  await expect(page.getByLabel("Length units", { exact: true })).toHaveValue("in");
  await expect(page.getByLabel("Length units", { exact: true }).locator("option")).toHaveText(["Feet & inches (ft)", "Inches (in)"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});

for (const unit of ["cm", "in"] as const) test(`inline editors and properties interpret arithmetic in ${unit}`, async ({ page }) => {
  await load(page);
  const selected = await choose(page, unit === "cm" ? "metric" : "imperial", unit);
  await page.getByTestId("dimension-top").dblclick();
  const length = page.getByRole("textbox", { name: "Edit dimension", exact: true });
  await expect(length).toHaveValue(unit === "cm" ? "400 cm" : '157.4803"');
  await length.fill(unit === "cm" ? "500 - 50" : "180 - 30");
  await length.press("Enter");
  const resized = await savedPlan(page);
  expect(distance(...wallPoints(resized, resized.walls[0]))).toBeCloseTo(unit === "cm" ? 4500 : 3810, 6);
  expect(resized.nodes[0]).toEqual(selected.nodes[0]);
  await page.getByTestId("thickness-thickness").dblclick();
  const thickness = page.getByRole("textbox", { name: "Edit thickness", exact: true });
  await thickness.fill("10 - 2");
  await thickness.press("Tab");
  expect((await savedPlan(page)).walls[0].thickness).toBeCloseTo(unit === "cm" ? 80 : 203.2, 6);
  const offset = page.getByRole("textbox", { name: "Offset from wall end", exact: true });
  await offset.fill("10 - 20");
  await offset.press("Enter");
  expect((await savedPlan(page)).thicknessDimensions![0].offset).toBeCloseTo(unit === "cm" ? -100 : -254, 6);
  await page.getByTestId("angle-angle").click();
  const radius = page.getByRole("textbox", { name: "Angle arc radius", exact: true });
  await radius.fill("50 * 2");
  await radius.press("Enter");
  expect((await savedPlan(page)).angleDimensions![0].radius).toBeCloseTo(unit === "cm" ? 1000 : 2540, 6);
  await page.getByTestId("angle-angle").dblclick();
  const angle = page.getByRole("textbox", { name: "Edit angle", exact: true });
  await expect(angle).toHaveValue("90\u00b0");
  await angle.press("Escape");
  const point = await screen(page, { x: 2000, y: 0 });
  await page.mouse.click(point.x, point.y);
  const width = page.getByRole("textbox", { name: "Opening width", exact: true });
  await width.fill("40 + 2");
  await width.press("Enter");
  expect((await savedPlan(page)).openings[0].width).toBeCloseTo(unit === "cm" ? 420 : 1066.8, 6);
  await page.getByTestId("dimension-top").dblclick();
  await length.fill("20' - 10'");
  await length.press("Enter");
  const explicit = await savedPlan(page);
  expect(distance(...wallPoints(explicit, explicit.walls[0]))).toBeCloseTo(3048, 6);
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", unit === "cm" ? "Edit measurement 304.8 cm" : 'Edit measurement 120"');
});

test("drawing defaults, previews, and snapping use the selected unit without changing the grid", async ({ page }) => {
  await load(page);
  const original = await choose(page, "metric", "cm");
  await expect(page.locator(".status-units")).toHaveText("Centimeters|5 cm snap");
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  const thickness = page.getByRole("textbox", { name: "New wall thickness", exact: true });
  await expect(thickness).toHaveValue("15 cm");
  await thickness.fill("20");
  await thickness.press("Enter");
  const start = await screen(page, { x: -1000, y: -1000 }), end = await screen(page, { x: -537, y: -1000 });
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(end.x, end.y);
  await expect(page.locator(".live-measure")).toHaveText("45 cm");
  await page.mouse.click(end.x, end.y);
  const drawn = await savedPlan(page), wall = drawn.walls.at(-1)!;
  expect(wall.thickness).toBe(200);
  expect(distance(...wallPoints(drawn, wall))).toBe(450);
  expect(drawn.nodes.slice(0, original.nodes.length)).toEqual(original.nodes);
  await page.keyboard.press("Escape");
  await choose(page, "imperial", "in");
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New wall thickness", exact: true })).toHaveValue('7.874"');
  await page.getByRole("button", { name: "Door tool", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New door width", exact: true })).toHaveValue('35.4331"');
});

test("preferred units persist through exports/imports and update cached scene labels only", async ({ page }) => {
  await load(page);
  const plan = await choose(page, "metric", "cm");
  const scene = await page.evaluate(async () => {
    const path = "/src/scene.ts";
    const scene: typeof import("../src/scene") = await import(path);
    const plan: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    const renderer = scene.createPlanRenderer(), before = renderer.render({ ...plan, lengthUnits: { metric: "m", imperial: "ft" } });
    const byId = new Map(before.map(element => [element.id, element]));
    const after = renderer.render(plan);
    return {
      texts: after.filter(element => element.type === "text").map(element => element.text),
      changedTypes: after.filter(element => byId.get(element.id) !== element).map(element => element.type),
    };
  });
  expect(scene.texts).toContain("400 cm");
  expect(scene.texts).toContain("15 cm");
  expect(scene.texts).not.toContain("12 m\u00b2");
  expect(scene.texts).not.toContain("Studio");
  expect(scene.changedTypes.every(type => type === "text" || type === "rectangle")).toBe(true);
  await page.locator(".rooms-menu > summary").click();
  await page.getByRole("button", { name: /Studio/ }).click();
  await expect(page.getByRole("textbox", { name: "Room name", exact: true })).toHaveValue("Studio");
  await expect(page.locator(".room-area .area-value")).toHaveText("12 m\u00b2");
  await page.locator(".export-menu > summary").click();
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await svgDownload).createReadStream())!) chunks.push(Buffer.from(chunk));
  const svg = Buffer.concat(chunks).toString();
  expect(svg).toContain("400 cm");
  expect(svg).not.toContain(">Studio</text>");
  expect(svg).not.toContain(">12 m\u00b2</text>");
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Editable project", exact: true }).click();
  const json: Buffer[] = [];
  for await (const chunk of (await (await jsonDownload).createReadStream())!) json.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(json).toString()).plan).toEqual(plan);
  await page.locator(".export-menu > summary").click();
  await choose(page, "imperial", "in");
  page.once("dialog", dialog => dialog.accept());
  await page.locator('input[type="file"]').setInputFiles({ name: "units.homedraw.json", mimeType: "application/json", buffer: Buffer.concat(json) });
  await expect(page.getByText("Project opened.", { exact: true })).toBeVisible();
  expect(await savedPlan(page)).toEqual(plan);
  await expect(page.getByTestId("dimension-top")).toHaveAttribute("aria-label", `Edit measurement ${formatLength(4000, plan)}`);
});
