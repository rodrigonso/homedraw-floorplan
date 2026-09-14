import type { Page } from "@playwright/test";
import type { Plan } from "../src/model";

export async function setUnits(page: Page, units: Plan["units"]) {
  await page.locator(".settings-menu > summary").click();
  await page.getByLabel("Measurement units").selectOption(units);
  await page.locator(".settings-menu > summary").click();
}
