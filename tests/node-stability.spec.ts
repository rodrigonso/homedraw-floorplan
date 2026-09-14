import { expect, test, type Page } from "@playwright/test";
import type { Plan, Point } from "../src/model";

async function savedPlan(page: Page): Promise<Plan> {
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  return page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan);
}

async function screenPoint(page: Page, point: Point) {
  return page.getByTestId("draft-canvas").evaluate((svg, point) => {
    const result = new DOMPoint(point.x, point.y).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: result.x, y: result.y };
  }, point);
}

test("valid corner moves keep rendering and saving after a formerly crashing junction", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  const node = original.nodes.find(node => node.x === 0 && node.y === 0)!;
  const handle = page.getByTestId(`node-${node.id}`);
  const canvas = page.locator("canvas.excalidraw__canvas.static");
  const beforeCanvas = await canvas.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  const start = await screenPoint(page, node);
  const target = await screenPoint(page, { x: -100, y: -100 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y);
  await expect(handle).toHaveAttribute("cx", "-100");
  await expect(handle).toHaveAttribute("cy", "-100");
  await expect.poll(() => canvas.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(beforeCanvas);
  expect(await savedPlan(page)).toEqual(original);
  expect(errors).toEqual([]);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes.find(other => other.id === node.id)).toMatchObject({ x: -100, y: -100 });
  expect(moved.nodes.filter(other => other.id !== node.id)).toEqual(original.nodes.filter(other => other.id !== node.id));
  expect(moved.openings).toEqual(original.openings);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(moved);
  await page.reload();
  expect(await savedPlan(page)).toEqual(moved);
  await expect(handle).toHaveAttribute("cx", "-100");
  await page.locator(".export-menu summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of (await (await download).createReadStream())!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain("<svg");
  expect(errors).toEqual([]);
});

test("repeated snapped and free corner previews stay responsive and cancel without saving", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const original = await savedPlan(page);
  const node = original.nodes.find(node => node.x === 0 && node.y === 0)!;
  const handle = page.getByTestId(`node-${node.id}`);
  const start = await screenPoint(page, node);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [i, target] of [
    { x: -100, y: -100 },
    { x: 850, y: -300 },
    { x: -125.25, y: -76.5 },
    { x: 847.375, y: -299.125 },
  ].entries()) {
    if (i === 2) await page.keyboard.down("Alt");
    const point = await screenPoint(page, target);
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await expect.poll(async () => Number(await handle.getAttribute("cx"))).toBeCloseTo(target.x, 2);
    await expect.poll(async () => Number(await handle.getAttribute("cy"))).toBeCloseTo(target.y, 2);
    await expect(page.locator("canvas.excalidraw__canvas.static")).toBeVisible();
    expect(await savedPlan(page)).toEqual(original);
    expect(errors).toEqual([]);
  }
  await page.keyboard.up("Alt");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle).toHaveAttribute("cx", "0");
  await expect(handle).toHaveAttribute("cy", "0");
  expect(await savedPlan(page)).toEqual(original);
  expect(errors).toEqual([]);
});
