import { expect, test } from "@playwright/test";
import { addAngleDimension, addOpening, addWall, createEmptyPlan, type Plan } from "../src/model";
import { palette } from "../src/theme";

const rgb = (hex: string) => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

test("rooms retain accent fills and property details without automatic canvas or export labels", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  const rooms = await page.evaluate(async () => {
    const path = "/src/scene.ts";
    const scene: typeof import("../src/scene") = await import(path);
    const plan: Plan = JSON.parse(localStorage.getItem("homedraw.project.v1")!).plan;
    const renderer = scene.createPlanRenderer();
    return [renderer.render(plan), scene.planToElements(plan), renderer.render(plan, false), scene.planToElements(plan, false)].map(elements => ({
      fills: elements.filter(element => element.id.startsWith("plan-room-")).map(element => element.backgroundColor),
      labels: elements.filter(element => /^plan-(name|area)-/.test(element.id)).map(element => element.id),
    }));
  });
  for (const room of rooms) {
    expect(room.fills).toEqual([palette.accentSoft, palette.accentSoft]);
    expect(room.labels).toEqual([]);
  }
  await page.locator(".rooms-menu > summary").click();
  await expect(page.locator(".room-list button")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Kitchen/ })).toBeVisible();
  await expect(page.locator(".plan-summary .area-value")).toHaveCSS("color", rgb(palette.accentText));
  for (const dot of await page.locator(".room-dot").all()) {
    await expect(dot).toHaveCSS("background-color", rgb(palette.accentSoft));
  }
  for (const area of await page.locator(".room-list small").all()) {
    await expect(area).toHaveCSS("color", rgb(palette.accentText));
  }
  await page.getByRole("button", { name: /Living room/ }).click();
  await expect(page.getByRole("textbox", { name: "Room name", exact: true })).toHaveValue("Living room");
  await expect(page.locator(".room-area")).toHaveCSS("background-color", rgb(palette.accentSoft));
  await expect(page.locator(".room-area .area-value")).toHaveCSS("color", rgb(palette.accentText));
});

test("SVG and PNG exports omit automatic room text while preserving user-created text", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  const { project, roomLabels } = await page.evaluate(async () => {
    const modelPath = "/src/model.ts";
    const model: typeof import("../src/model") = await import(modelPath);
    const project = JSON.parse(localStorage.getItem("homedraw.project.v1")!);
    project.sketches = [{
      id: "manual-room-note", type: "text", x: 100, y: 100, width: 200, height: 25,
      text: "Keep this custom label", fontSize: 20, fontFamily: 5, strokeColor: "#252422",
    }];
    return {
      project,
      roomLabels: model.detectRooms(project.plan).flatMap(room => [room.name, model.formatArea(room.area, project.plan.units)]),
    };
  });
  await page.addInitScript(project => localStorage.setItem("homedraw.project.v1", JSON.stringify(project)), project);
  await page.reload();
  await expect(page.getByRole("status", { name: "Saved on this device", exact: true })).toBeVisible();
  const originalNotes = await page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).sketches);
  expect(originalNotes).toEqual([expect.objectContaining({ id: "manual-room-note", text: "Keep this custom label" })]);
  await page.locator(".export-menu > summary").click();
  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG drawing", exact: true }).click();
  const svgChunks: Buffer[] = [];
  for await (const chunk of (await (await svgDownload).createReadStream())!) svgChunks.push(Buffer.from(chunk));
  const svg = Buffer.concat(svgChunks).toString();
  expect(svg).toContain("Keep this custom label");
  for (const label of roomLabels) expect(svg).not.toContain(`>${label}</text>`);
  expect(svg).toContain(palette.accentSoft);
  const readExportedText = await page.evaluateHandle(() => {
    const text: string[] = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      text.push(args[0]);
      return fillText.apply(this, args);
    };
    return () => {
      CanvasRenderingContext2D.prototype.fillText = fillText;
      return text;
    };
  });
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG image", exact: true }).click();
  const pngChunks: Buffer[] = [];
  for await (const chunk of (await (await pngDownload).createReadStream())!) pngChunks.push(Buffer.from(chunk));
  expect(Buffer.concat(pngChunks).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const renderedText = await readExportedText.evaluate(read => read());
  await readExportedText.dispose();
  expect(renderedText).toContain("Keep this custom label");
  for (const label of roomLabels) expect(renderedText).not.toContain(label);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("homedraw.project.v1")!).sketches)).toEqual(originalNotes);
});

test("draft controls, focus, selections and renovation notes share the accent palette", async ({ page }) => {
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
  await page.getByRole("button", { name: "Renovation notes", exact: true }).click();
  const noteTool = page.getByRole("button", { name: "Draw note", exact: true });
  await expect(noteTool).toHaveCSS("background-color", rgb(palette.accentSoft));
  await expect(noteTool).toHaveCSS("color", rgb(palette.accentText));
  const nativePrimary = await page.locator(".excalidraw").evaluate(element =>
    getComputedStyle(element).getPropertyValue("--color-primary").trim());
  expect(nativePrimary).toBe(palette.accent);
  await expect(page.getByTestId("main-menu-trigger")).not.toBeVisible();
  await page.getByRole("button", { name: "Quick guide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Got it", exact: true })).toHaveCSS("background-color", rgb(palette.accent));
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.mouse.move(140, 840);
  await page.mouse.down();
  await page.mouse.move(200, 810, { steps: 8 });
  await page.mouse.move(260, 840, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done notes", exact: true }).click();
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
