import { describe, expect, it } from "vitest";
import {
  addRoom, createEmptyPlan, formatArea, formatLength, formatLengthInput, getLengthUnit,
  parseLength, parsePosition, setLengthUnit, validatePlan, type LengthUnits, type Plan,
} from "./model";
import { getMarqueeSelection, selectionBounds } from "./selection";

const preferences: LengthUnits = { metric: "cm", imperial: "in" };
const settings = (units: Plan["units"]) => ({ units, lengthUnits: preferences });

describe("length unit preferences", () => {
  it("keeps older projects and callers on meters or feet and inches", () => {
    for (const units of ["metric", "imperial"] as const) {
      const plan = { ...createEmptyPlan(), units };
      expect(validatePlan(plan)).not.toHaveProperty("lengthUnits");
      expect(getLengthUnit(plan)).toBe(units === "metric" ? "m" : "ft");
      expect(formatLength(3810, plan)).toBe(formatLength(3810, units));
      expect(parseLength("2", plan)).toBe(parseLength("2", units));
      expect(setLengthUnit(plan, getLengthUnit(plan))).toBe(plan);
    }
  });

  it("remembers a separate preference per system without changing geometry", () => {
    const original = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const cm = setLengthUnit(original, "cm");
    expect(cm).toEqual({ ...original, lengthUnits: { metric: "cm", imperial: "ft" } });
    const inches = setLengthUnit({ ...cm, units: "imperial" }, "in");
    expect(inches.lengthUnits).toEqual(preferences);
    expect(setLengthUnit(inches, "in")).toBe(inches);
    const metric = { ...inches, units: "metric" as const };
    expect(getLengthUnit(metric)).toBe("cm");
    expect(setLengthUnit(metric, "m").lengthUnits).toEqual({ metric: "m", imperial: "in" });
    expect(validatePlan(JSON.parse(JSON.stringify(inches)))).toEqual(inches);
    expect(original).not.toHaveProperty("lengthUnits");
    const normalized = validatePlan(inches);
    expect(normalized.lengthUnits).not.toBe(inches.lengthUnits);
  });

  it.each([
    undefined, null, [], "cm", {}, { metric: "cm" }, { imperial: "in" },
    { metric: "mm", imperial: "ft" }, { metric: "m", imperial: "cm" },
    { metric: "in", imperial: "ft" }, { metric: "cm", imperial: "in", extra: 1 },
  ])("rejects malformed preferences %#", lengthUnits => {
    expect(() => validatePlan({ ...createEmptyPlan(), lengthUnits })).toThrow(/units/i);
  });

  it.each(["", "mm", "in", "ft"])("rejects a non-metric choice %j in metric mode", unit => {
    expect(() => setLengthUnit(createEmptyPlan(), unit)).toThrow(/Choose/);
  });
  it.each(["", "mm", "m", "cm"])("rejects a non-imperial choice %j in imperial mode", unit => {
    expect(() => setLengthUnit({ ...createEmptyPlan(), units: "imperial" }, unit)).toThrow(/Choose/);
  });
});

describe("preferred-unit formatting and arithmetic", () => {
  it.each([
    [0, "0 cm", '0"'], [150, "15 cm", '5.9055"'], [3810, "381 cm", '150"'],
    [1234.567, "123.5 cm", '48.605"'], [25.4, "2.5 cm", '1"'],
  ])("formats %s mm in the selected units", (mm, cm, inches) => {
    expect(formatLength(mm, settings("metric"))).toBe(cm);
    expect(formatLength(mm, settings("imperial"))).toBe(inches);
  });

  it("keeps editor precision and parses signed editor values", () => {
    expect(formatLengthInput(1234.567, settings("metric"))).toBe("123.46 cm");
    expect(formatLengthInput(-1234.567, settings("metric"))).toBe("-123.46 cm");
    expect(formatLengthInput(1234.567, "metric")).toBe("1.2346 m");
    expect(formatLengthInput(-3810, settings("imperial"))).toBe('-150"');
    for (const units of ["metric", "imperial"] as const) for (const mm of [-100000, -150, 0, 25.4, 1234.567, 100000]) {
      expect(Math.abs(parsePosition(formatLengthInput(mm, settings(units)), settings(units)) - mm)).toBeLessThan(0.051);
    }
    expect(() => formatLength(-1, settings("metric"))).toThrow(/negative/);
    expect(() => formatLengthInput(Infinity, settings("imperial"))).toThrow(/finite/);
  });

  it.each([
    ["20 - 10", 100, 254], ["2 * (3 + 4)", 140, 355.6], ["1 m + 2", 1020, 1050.8],
    ["1 1/2", 15, 38.1], ["4 m / 2", 2000, 2000], ["20' - 10'", 3048, 3048],
    ['12\' 6 1/2" - 6 1/2"', 3657.6, 3657.6], ["1 m + 2 cm", 1020, 1020],
  ])("interprets bare values in the selected units without overriding explicit units: %s", (input, cm, inches) => {
    expect(parseLength(input, settings("metric"))).toBeCloseTo(cm, 7);
    expect(parseLength(input, settings("imperial"))).toBeCloseTo(inches, 7);
  });

  it("retains length limits and conventional area units", () => {
    expect(parsePosition("10 - 20", settings("metric"))).toBe(-100);
    expect(parsePosition("10 - 20", settings("imperial"))).toBe(-254);
    for (const units of ["metric", "imperial"] as const) {
      for (const text of ["10 - 20", "10 - 10", "1000000", "2 / 0"]) {
        expect(() => parseLength(text, settings(units))).toThrow();
      }
    }
    expect(formatArea(12000000, "metric")).toBe("12 m\u00b2");
    expect(formatArea(304.8 ** 2, "imperial")).toBe("1 ft\u00b2");
  });

  it("uses preferred labels when bounding and marquee-selecting thickness callouts", () => {
    const base = addRoom(createEmptyPlan(), { x: 0, y: 0 }, { x: 4000, y: 3000 }, 150);
    const plan: Plan = {
      ...base, ...settings("imperial"),
      thicknessDimensions: [{ id: "thickness", wallId: base.walls[0].id, offset: 1000 }],
    };
    const items = [{ kind: "thickness" as const, id: "thickness" }];
    const box = selectionBounds(plan, items)!;
    expect(getMarqueeSelection(plan, { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, true)).toEqual(items);
    expect(selectionBounds(plan, items, false)).toBeNull();
  });
});
