import { expect, test, type Page } from "@playwright/test";
import { anglePosition } from "../src/angles";
import { wallPoints, type Plan, type Point } from "../src/model";

const fixture = (): Plan => ({
  version: 1, name: "Shift constraints", units: "metric", roomNames: {},
  nodes: [
    { id: "a", x: 0, y: 0 }, { id: "b", x: 4000, y: 0 }, { id: "c", x: 4000, y: 3000 },
    { id: "d", x: 6000, y: 0 }, { id: "e", x: 8000, y: 0 },
  ],
  walls: [
    { id: "first", a: "a", b: "b", thickness: 150, dimension: true, dimensionOffset: -500 },
    { id: "second", a: "b", b: "c", thickness: 150, dimension: false },
    { id: "third", a: "d", b: "e", thickness: 150, dimension: false },
  ],
  openings: [{ id: "door", wallId: "first", kind: "door", offset: 1000, width: 600, flip: false }],
  angleDimensions: [{ id: "angle", wallA: "first", wallB: "second", vertex: "b", radius: 600, clockwise: false }],
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
    const matrix = svg.querySelector("g")!.getScreenCTM()!;
    const p = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: p.x, y: p.y, scale: matrix.a };
  }, point);
}

async function click(page: Page, point: Point) {
  const p = await screen(page, point);
  await page.mouse.click(p.x, p.y);
}

for (const straightWalls of [true, false]) test(`Shift forces orthogonal wall drawing with Straight walls=${straightWalls}`, async ({ page }) => {
  const original = await load(page);
  if (!straightWalls) {
    await page.locator(".settings-menu > summary").click();
    await page.getByRole("button", { name: "Straight walls", exact: true }).click();
    await page.locator(".settings-menu > summary").click();
  }
  await page.getByRole("button", { name: "Wall tool", exact: true }).click();
  await click(page, { x: -1000, y: -1800 });
  const end = await screen(page, { x: 1500, y: -900 });
  await page.mouse.move(end.x, end.y);
  await expect(page.locator(".preview-line")).toHaveAttribute("y2", straightWalls ? "-1800" : "-900");
  await page.keyboard.down("Shift");
  await expect(page.locator(".preview-line")).toHaveAttribute("y2", "-1800");
  await page.keyboard.up("Shift");
  await expect(page.locator(".preview-line")).toHaveAttribute("y2", straightWalls ? "-1800" : "-900");
  expect(await savedPlan(page)).toEqual(original);
  await page.keyboard.down("Shift");
  await page.mouse.click(end.x, end.y);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Escape");
  const drawn = await savedPlan(page);
  const [a, b] = wallPoints(drawn, drawn.walls.at(-1)!);
  expect(a).toMatchObject({ x: -1000, y: -1800 });
  expect(b).toMatchObject({ x: 1500, y: -1800 });
});

for (const kind of ["node", "wall", "group"]) test(`Shift held before a ${kind} drag locks movement, responds to key changes and preserves Alt free placement`, async ({ page }) => {
  const original = await load(page);
  if (kind === "group") {
    await page.getByTestId("draft-canvas").focus();
    await page.keyboard.press("Control+a");
  }
  const origin = kind === "node" ? { x: 4000, y: 0 } : { x: 400, y: 0 };
  const start = await screen(page, origin), end = await screen(page, { x: origin.x + 277.25, y: 173.5 });
  const handle = page.getByTestId(kind === "node" ? "node-b" : "node-a");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(handle).toHaveAttribute("cy", "0");
  await expect.poll(async () => Number(await handle.getAttribute("cx"))).toBeCloseTo(kind === "node" ? 4277.25 : 277.25, 3);
  await page.keyboard.up("Shift");
  await expect.poll(async () => Number(await handle.getAttribute("cy"))).toBeCloseTo(173.5, 3);
  await page.keyboard.down("Shift");
  await expect(handle).toHaveAttribute("cy", "0");
  expect(await savedPlan(page)).toEqual(original);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  const moved = await savedPlan(page);
  const movedIds = new Set(kind === "node" ? ["b"] : kind === "wall" ? ["a", "b"] : original.nodes.map(node => node.id));
  for (const node of moved.nodes) {
    const before = original.nodes.find(item => item.id === node.id)!;
    expect(node.x).toBeCloseTo(before.x + (movedIds.has(node.id) ? 277.25 : 0), 3);
    expect(node.y).toBe(before.y);
  }
  expect(moved.walls).toEqual(original.walls);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("Shift locks vertical node movement with snapping disabled and does not toggle selection after dragging back", async ({ page }) => {
  const original = await load(page);
  await page.locator(".settings-menu > summary").click();
  await page.getByRole("button", { name: "Snap to geometry", exact: true }).click();
  await page.locator(".settings-menu > summary").click();
  const start = await screen(page, { x: 4000, y: 0 }), end = await screen(page, { x: 4173.5, y: -277.25 });
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId("node-b")).toHaveAttribute("cx", "4000");
  await expect.poll(async () => Number(await page.getByTestId("node-b").getAttribute("cy"))).toBeCloseTo(-277.25, 3);
  await page.mouse.move(start.x, start.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("node-b")).toHaveAttribute("aria-pressed", "true");
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("Shift only on release constrains the final wall coordinates before a queued preview runs", async ({ page }) => {
  const original = await load(page);
  const start = await screen(page, { x: 400, y: 0 }), end = await screen(page, { x: 700, y: 200 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.getByTestId("draft-canvas").evaluate((svg, end) => {
    svg.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, buttons: 1, clientX: end.x, clientY: end.y }));
    svg.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0, clientX: end.x, clientY: end.y, shiftKey: true }));
  }, end);
  await page.mouse.up();
  const moved = await savedPlan(page);
  expect(moved.nodes[0]).toMatchObject({ x: 300, y: 0 });
  expect(moved.nodes[1]).toMatchObject({ x: 4300, y: 0 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

for (const kind of ["dimension", "angle", "opening"]) test(`Shift-before-drag preserves the ${kind}'s existing attachment constraint`, async ({ page }) => {
  const original = await load(page);
  const scale = (await screen(page, { x: 0, y: 0 })).scale;
  let start: Point;
  let delta = { x: 40, y: 80 };
  if (kind === "opening") start = await screen(page, { x: 1000, y: 0 });
  else {
    const box = (await page.getByTestId(kind === "dimension" ? "dimension-first" : "angle-angle").boundingBox())!;
    start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (kind === "angle") {
      const { axis } = anglePosition(original, original.angleDimensions![0]);
      delta = { x: axis.x * 50 - axis.y * 20, y: axis.y * 50 + axis.x * 20 };
    }
  }
  await page.keyboard.down("Shift");
  await page.keyboard.down("Alt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  const moved = await savedPlan(page);
  expect(moved.nodes).toEqual(original.nodes);
  if (kind === "dimension") expect(moved.walls[0].dimensionOffset).toBeCloseTo(-500 + 80 / scale, 2);
  if (kind === "angle") expect(moved.angleDimensions![0].radius).toBeCloseTo(600 + 50 / scale, 2);
  if (kind === "opening") expect(moved.openings[0].offset).toBeCloseTo(1000 + 40 / scale, 2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});

test("Shift constrains panning without altering the plan", async ({ page }) => {
  const original = await load(page);
  const matrix = () => page.getByTestId("draft-canvas").evaluate(svg => {
    const m = svg.querySelector("g")!.getScreenCTM()!;
    return { x: m.e, y: m.f };
  });
  await page.getByRole("button", { name: "Pan tool", exact: true }).click();
  const before = await matrix();
  await page.keyboard.down("Shift");
  await page.mouse.move(200, 800);
  await page.mouse.down();
  await page.mouse.move(350, 870, { steps: 8 });
  await expect.poll(async () => (await matrix()).x).toBeCloseTo(before.x + 150, 2);
  await expect.poll(async () => (await matrix()).y).toBeCloseTo(before.y, 2);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await matrix()).y).toBeCloseTo(before.y + 70, 2);
  await page.keyboard.down("Shift");
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect((await matrix()).y).toBeCloseTo(before.y, 2);
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

for (const cancellation of ["Escape", "pointercancel", "lostpointercapture", "blur"]) test(`${cancellation} cancels a Shift-started drag and its pending modifier preview`, async ({ page }) => {
  const original = await load(page);
  const start = await screen(page, { x: 4000, y: 0 }), end = await screen(page, { x: 4300, y: -200 });
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId("node-b")).toHaveAttribute("cx", "4300");
  await expect(page.getByTestId("node-b")).toHaveAttribute("cy", "0");
  await page.getByTestId("draft-canvas").evaluate((svg, { end, cancellation }) => {
    svg.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 1, buttons: 1, clientX: end.x, clientY: end.y, shiftKey: false,
    }));
    if (cancellation === "Escape") svg.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    else if (cancellation === "blur") window.dispatchEvent(new Event("blur"));
    else svg.dispatchEvent(new PointerEvent(cancellation, { bubbles: true, pointerId: 1 }));
  }, { end, cancellation });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("node-b")).toHaveAttribute("cx", "4000");
  expect(await savedPlan(page)).toEqual(original);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
});

test("Shift held before mouse down still performs a node drag released before the next frame", async ({ page }) => {
  const original = await load(page);
  const start = await screen(page, { x: 4000, y: 0 }), end = await screen(page, { x: 4277, y: -900 });
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.getByTestId("draft-canvas").evaluate((svg, end) => {
    svg.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 1, buttons: 1, clientX: end.x, clientY: end.y, shiftKey: true,
    }));
    svg.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 1, button: 0, clientX: end.x, clientY: end.y, shiftKey: true,
    }));
  }, end);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect((await savedPlan(page)).nodes[1]).toMatchObject({ x: 4000, y: -900 });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await savedPlan(page)).toEqual(original);
});
