import { expect, test } from "@playwright/test";
import { addAngleDimension, addOpening, addWall, createEmptyPlan, type Plan } from "../src/model";
import { palette } from "../src/theme";

const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

test("room fills and area values share the accent on the canvas, in properties and in export elements", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  const rooms = await page.evaluate(async () => {
    const path = "/src/scene.ts";
    const scene: typeof import("../src/scene") = await import(path);
    const plan: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    const elements = scene.planToElements(plan);
    return {
      fills: elements.filter(element => element.id.startsWith("plan-room-")).map(element => element.backgroundColor),
      areas: elements.filter(element => element.id.startsWith("plan-area-")).map(element => element.strokeColor),
    };
  });
  expect(rooms.fills).toEqual([palette.accentSoft, palette.accentSoft]);
  expect(rooms.areas).toEqual([palette.accentText, palette.accentText]);
  await page.locator(".rooms-menu > summary").click();
  await expect(page.locator(".plan-summary .area-value")).toHaveCSS("color", rgb(palette.accentText));
  for (const dot of await page.locator(".room-dot").all()) {
    await expect(dot).toHaveCSS("background-color", rgb(palette.accentSoft));
  }
  for (const area of await page.locator(".room-list small").all()) {
    await expect(area).toHaveCSS("color", rgb(palette.accentText));
  }
  await page.getByRole("button", { name: /Living room/ }).click();
  await expect(page.locator(".room-area")).toHaveCSS("background-color", rgb(palette.accentSoft));
  await expect(page.locator(".room-area .area-value")).toHaveCSS("color", rgb(palette.accentText));
});

test("draft controls, focus, selections and native sketch controls share the accent palette", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toHaveCSS("color", rgb(palette.accent));
  const selected = page.getByRole("button", { name: "Select tool", exact: true });
  await expect(selected).toHaveCSS("background-color", rgb(palette.accentSoft));
  await expect(selected).toHaveCSS("color", rgb(palette.accentText));
  await expect(page.locator(".node-handle").first()).toHaveCSS("stroke", rgb(palette.accent));
  await page.locator(".settings-menu > summary").click();
  await expect(page.locator(".settings-menu > summary")).toHaveCSS("color", rgb(palette.accentText));
  await expect(page.getByRole("button", { name: "Snap to geometry", exact: true }).locator(".switch"))
    .toHaveCSS("background-color", rgb(palette.accent));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  const field = page.getByRole("textbox", { name: "New wall thickness", exact: true });
  await field.focus();
  await expect(field).toHaveCSS("border-color", rgb(palette.accent));
  await field.fill("invalid");
  await field.press("Enter");
  await field.focus();
  await expect(field).toHaveCSS("border-color", rgb(palette.warning));
  await field.press("Escape");
  await page.getByRole("button", { name: "Quick guide", exact: true }).click();
  const primary = page.getByRole("button", { name: "Got it", exact: true });
  await expect(primary).toHaveCSS("background-color", rgb(palette.accent));
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", rgb(palette.accentHover));
  await primary.click();
  await page.getByRole("button", { name: "Sketch & annotate", exact: true }).click();
  const nativeSelected = page.locator(".excalidraw .ToolIcon_type_radio:checked + .ToolIcon__icon").first();
  await expect(nativeSelected).toHaveCSS("background-color", rgb(palette.accentSoft));
  await expect(nativeSelected.locator("svg")).toHaveCSS("color", rgb(palette.accentText));
  const nativePrimary = await page.locator(".excalidraw").evaluate(element =>
    getComputedStyle(element).getPropertyValue("--color-primary").trim());
  expect(nativePrimary).toBe(palette.accent);
  await page.getByTestId("main-menu-trigger").click();
  await page.getByTestId("help-menu-item").click();
  const nativeDialog = page.locator(".excalidraw-modal-container");
  await expect(nativeDialog).toBeVisible();
  expect(await nativeDialog.evaluate(element =>
    getComputedStyle(element).getPropertyValue("--color-surface-primary-container").trim())).toBe(palette.accentSoft);
  expect(await nativeDialog.evaluate(element =>
    getComputedStyle(element).getPropertyValue("--color-on-primary-container").trim())).toBe(palette.accentText);
  await page.locator(".HelpDialog .Modal__background").click({ position: { x: 5, y: 5 } });
  await expect(nativeDialog).toHaveCount(0);
  await page.mouse.move(140, 840);
  await page.mouse.down();
  await page.mouse.move(200, 810, { steps: 8 });
  await page.mouse.move(260, 840, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done sketching", exact: true }).click();
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).sketches.at(-1).strokeColor))
    .toBe(palette.ink);
});

test("linear and angular measurements share export colors while warnings stay red", async ({ page }) => {
  let plan = addWall(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 0 }, 150);
  plan = addWall(plan, { x: 0, y: 0 }, { x: 0, y: 3000 }, 150);
  plan = addOpening(plan, plan.walls[0].id, "window", 2800, 1000);
  plan = addAngleDimension(plan, {
    wallA: plan.walls[0].id, wallB: plan.walls[1].id, vertex: plan.walls[0].a, radius: 800, clockwise: true,
  });
  plan = addWall(plan, { x: 2000, y: -1000 }, { x: 2000, y: 1000 }, 150);
  await page.addInitScript(plan => localStorage.setItem("homedraw.project.v1",
    JSON.stringify({ format: "homedraw", version: 1, plan, sketches: [] })), plan);
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  await expect(page.locator(".geometry-warning-line").first()).toHaveCSS("stroke", rgb(palette.warning));
  const colors = await page.evaluate(async () => {
    const path = "/src/scene.ts";
    const scene: typeof import("../src/scene") = await import(path);
    const plan: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    const elements = scene.planToElements(plan);
    return {
      lines: [...new Set(elements.filter(element => element.type === "line"
        && /^plan-(dim|ext|tick|angle-arc|angle-ext|angle-tick|window|jamb)-/.test(element.id)).map(element => element.strokeColor))],
      labels: [...new Set(elements.filter(element => /^plan-(dim-label|angle-label)-/.test(element.id)).map(element => element.strokeColor))],
      warnings: [...new Set(elements.filter(element => element.id.startsWith("plan-warning-")).map(element => element.strokeColor))],
    };
  });
  expect(colors).toEqual({ lines: [palette.accent], labels: [palette.accentText], warnings: [palette.warning] });
  await page.locator(".export-menu > summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const svg = Buffer.concat(chunks).toString();
  expect(svg).toContain(palette.accent);
  expect(svg).toContain(palette.accentText);
  expect(svg).toContain(palette.warning);
});
