import { expect, test, type Page } from "@playwright/test";
import { anglePosition } from "../src/angles";
import { distance, wallPoints, type Plan } from "../src/model";

const fixture = (units: Plan["units"] = "metric"): Plan => ({
  version: 1, name: "Measurement arithmetic", units, roomNames: {},
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

async function load(page: Page, units: Plan["units"] = "metric") {
  await page.addInitScript(plan => {
    if (!localStorage.getItem("homedraw.project.v1")) localStorage.setItem("homedraw.project.v1",
      JSON.stringify({ format: "homedraw", version: 1, plan, sketches: [] }));
  }, fixture(units));
  await page.goto("/");
  return savedPlan(page);
}

const cases = [
  { kind: "length", label: "dimension-top", editor: "Edit dimension", expression: "20' - 10'", expected: 3048 },
  { kind: "thickness", label: "thickness-thickness", editor: "Edit thickness", expression: '(6 1/2" + 1/2") / 2', expected: 88.9 },
  { kind: "angle", label: "angle-angle", editor: "Edit angle", expression: "(180 deg - 30 deg) / 2", expected: 75 },
] as const;

for (const units of ["metric", "imperial"] as const) for (const entry of cases) {
  test(`${entry.kind} inline arithmetic applies once with history and persistence (${units})`, async ({ page }) => {
    const original = await load(page, units);
    const label = page.getByTestId(entry.label);
    await label.dblclick();
    const editor = page.getByRole("textbox", { name: entry.editor, exact: true });
    await editor.fill(entry.expression);
    expect(await savedPlan(page)).toEqual(original);
    if (entry.kind === "thickness") await editor.press("Tab");
    else await editor.press("Enter");
    await expect(editor).toHaveCount(0);
    const updated = await savedPlan(page);
    const measured = entry.kind === "length" ? distance(...wallPoints(updated, updated.walls[0]))
      : entry.kind === "thickness" ? updated.walls[0].thickness : anglePosition(updated, updated.angleDimensions![0]).degrees;
    expect(measured).toBeCloseTo(entry.expected, 7);
    expect(updated.nodes[0]).toEqual(original.nodes[0]);
    expect(updated.openings).toEqual(original.openings);
    if (entry.kind === "thickness") expect(updated.nodes).toEqual(original.nodes);
    if (entry.kind === "length" && units === "imperial") {
      await expect(label).toHaveAttribute("aria-label", 'Edit measurement 10\' 0"');
    }
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect(await savedPlan(page)).toEqual(original);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect(await savedPlan(page)).toEqual(updated);
    await page.reload();
    expect(await savedPlan(page)).toEqual(updated);
    await label.dblclick();
    await expect(editor).not.toHaveValue(entry.expression);
    await editor.press("Escape");
  });
}

for (const entry of cases) test(`${entry.kind} inline arithmetic errors and cancellation leave the plan unchanged`, async ({ page }) => {
  const original = await load(page);
  const label = page.getByTestId(entry.label);
  await label.dblclick();
  const editor = page.getByRole("textbox", { name: entry.editor, exact: true });
  const invalid = entry.kind === "angle" ? "180 + 180" : entry.kind === "thickness" ? "500 mm * 3" : "2 m - 4 m";
  for (const expression of ["2 +", "(2 + 3", "4 / (2 - 2)", invalid]) {
    await editor.fill(expression);
    await editor.press("Enter");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(await savedPlan(page)).toEqual(original);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  }
  await editor.fill(entry.expression);
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await label.dblclick();
  await editor.fill(entry.kind === "angle" ? "180 / 2" : entry.kind === "thickness" ? "100 mm + 50 mm" : "2 m * 2");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("properties share arithmetic for openings, signed offsets, thickness, and angles", async ({ page }) => {
  await load(page);
  await page.getByTestId("thickness-thickness").click();
  const thickness = page.getByRole("textbox", { name: "Wall thickness", exact: true });
  await thickness.fill("100 mm + 50 mm");
  await thickness.press("Enter");
  await expect(thickness).toHaveValue("0.15 m");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  const offset = page.getByRole("textbox", { name: "Offset from wall end", exact: true });
  await offset.fill("1 m - 2 m");
  await offset.press("Enter");
  expect((await savedPlan(page)).thicknessDimensions![0].offset).toBe(-1000);
  await expect(offset).toHaveValue("-1 m");
  await offset.fill("2 m - 2 m");
  await offset.press("Enter");
  expect((await savedPlan(page)).thicknessDimensions![0].offset).toBe(0);
  await page.getByTestId("angle-angle").click();
  const angle = page.getByRole("textbox", { name: "Angle", exact: true });
  await angle.fill("90 + 15");
  await angle.press("Enter");
  const rotated = await savedPlan(page);
  expect(anglePosition(rotated, rotated.angleDimensions![0]).degrees).toBeCloseTo(105);
  const radius = page.getByRole("textbox", { name: "Angle arc radius", exact: true });
  await radius.fill("500 mm * 2");
  await radius.press("Enter");
  expect((await savedPlan(page)).angleDimensions![0].radius).toBe(1000);
  const point = await page.getByTestId("draft-canvas").evaluate(svg => {
    const p = new DOMPoint(2000, 0).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  const width = page.getByRole("textbox", { name: "Opening width", exact: true });
  await width.fill('4\' - 6"');
  await width.press("Enter");
  expect((await savedPlan(page)).openings[0].width).toBeCloseTo(1066.8, 7);
  const position = page.getByRole("textbox", { name: "Position from wall start", exact: true });
  await position.fill("3 m / 2");
  await position.press("Enter");
  expect((await savedPlan(page)).openings[0].offset).toBe(1500);
});
