import { expect, test, type Page } from "@playwright/test";
import type { Plan } from "../src/model";

async function openEditor(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
}

async function selectWall(page: Page) {
  const position = await page.getByTestId("draft-canvas").evaluate(svg => {
    const plan: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    const wall = plan.walls.find(wall => !plan.openings.some(opening => opening.wallId === wall.id))!;
    const a = plan.nodes.find(node => node.id === wall.a)!;
    const b = plan.nodes.find(node => node.id === wall.b)!;
    const point = new DOMPoint((a.x + b.x) / 2, (a.y + b.y) / 2).matrixTransform(svg.querySelector("g")!.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(position.x, position.y);
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toBeVisible();
}

test("minimal chrome keeps the full canvas stable when contextual properties appear", async ({ page }) => {
  await openEditor(page);
  const canvas = page.getByTestId("draft-canvas");
  const original = await canvas.boundingBox();
  expect(original).toEqual({ x: 0, y: 0, ...page.viewportSize() });
  await expect(page.getByRole("navigation", { name: "Drawing tools" }).getByRole("button")).toHaveCount(9);
  await expect(page.locator(".floating-inspector")).toHaveCount(0);
  await expect(page.locator(".grid-layer")).toHaveCount(0);
  const transform = await canvas.locator(":scope > g").getAttribute("transform");
  await selectWall(page);
  expect(await canvas.boundingBox()).toEqual(original);
  await expect(canvas.locator(":scope > g")).toHaveAttribute("transform", transform!);
  await page.keyboard.press("Escape");
  await expect(page.locator(".floating-inspector")).toHaveCount(0);
  await page.keyboard.press("w");
  await expect(page.getByRole("textbox", { name: "New wall thickness", exact: true })).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(original);
  await page.getByRole("textbox", { name: "New wall thickness", exact: true }).fill("0.2 m");
  await page.getByRole("textbox", { name: "New wall thickness", exact: true }).press("Enter");
  await page.keyboard.press("r");
  await expect(page.getByRole("textbox", { name: "New wall thickness", exact: true })).toHaveValue("0.2 m");
});

test("menus expose project and drawing controls, dismiss accessibly, and preserve selection", async ({ page }) => {
  await openEditor(page);
  await selectWall(page);
  const settings = page.locator(".settings-menu > summary");
  await settings.click();
  await page.getByLabel("Measurement units").selectOption("imperial");
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toHaveValue(/'/);
  await expect(page.getByRole("button", { name: "Snap to geometry", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Dot grid", exact: true }).click();
  await expect(page.locator(".grid-layer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-menu")).not.toHaveAttribute("open", "");
  await expect(settings).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toBeVisible();
  await settings.click();
  await page.locator(".export-menu > summary").click();
  await expect(page.locator(".settings-menu")).not.toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Editable project", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select tool", exact: true }).click();
  await expect(page.locator(".export-menu")).not.toHaveAttribute("open", "");
  await page.locator(".project-menu > summary").click();
  await expect(page.getByRole("button", { name: "Open project", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  expect((await download).suggestedFilename()).toMatch(/\.homedraw\.json$/);
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New plan", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep working", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Wall length", exact: true })).toBeVisible();
});

for (const width of [320, 390, 768]) {
  test(`floating controls and settings remain usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openEditor(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await page.getByTestId("draft-canvas").boundingBox()).toEqual({ x: 0, y: 0, width, height: 844 });
    const tools = page.getByRole("navigation", { name: "Drawing tools" }).getByRole("button");
    for (const tool of await tools.all()) await tool.click({ trial: true });
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await page.getByRole("button", { name: "Fit plan", exact: true }).click();
    await page.locator(".settings-menu > summary").click();
    const box = (await page.locator(".settings-menu .menu-popover").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.getByLabel("Measurement units").selectOption("imperial");
    await page.keyboard.press("Escape");
    await page.locator(".rooms-menu > summary").click();
    await page.getByRole("button", { name: /Living room/ }).click();
    await expect(page.getByRole("textbox", { name: "Room name", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Room name", exact: true }).fill("Study");
    await page.getByRole("textbox", { name: "Room name", exact: true }).press("Enter");
    await page.locator(".rooms-menu > summary").click();
    await expect(page.getByRole("button", { name: /Study/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".rooms-menu")).not.toHaveAttribute("open", "");
    await expect(page.locator(".rooms-menu > summary")).toBeFocused();
    await page.getByRole("button", { name: "Wall tool", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "New wall thickness", exact: true })).toBeVisible();
    const panel = (await page.locator(".floating-inspector").boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    expect(panel.y + panel.height).toBeLessThan(790);
  });
}
