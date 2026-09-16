import { describe, expect, it } from "vitest";
import { parseAngle, parseLength, parsePosition, type Plan } from "./model";

describe("measurement arithmetic", () => {
  it.each([
    ["20' - 10'", 3048], ["20'-10'", 3048], ["20\u2032 - 10\u2032", 3048],
    ['12\' 6 1/2" - 2\' 3 1/4"', 3130.55], ['6 1/2" + 1/2"', 177.8],
    ["4 m + 20 cm - 5 mm", 4195], ['1 ft + 6" + 100 mm', 557.2],
    ["4 METRES - 20 CENTIMETERS", 3800], ["2 * 3 m + 100 mm", 6100],
    ["(3 m + 200 mm) / 2", 1600], ["2 * (3 m - 50 cm)", 5000],
    ["6 ft / 2 / 3", 304.8], ["6 ft / (2 / 3)", 2743.2],
    ["6 ft / 2 * 3", 2743.2], ["2 * 6 1/2 in", 330.2],
    ["-1 m + 3 m", 2000], ["-(1 m - 3 m)", 2000], ["+1 m", 1000],
    ["2 m + -50 cm", 1500], ["2 m - -50 cm", 2500],
    ["400 m - 399 m", 1000], ["0 m + 1 mm", 1],
    ["(6 m / 2 m) * 1 ft", 914.4], ["1/2 in * 2", 25.4], ["2 / 3 m", 2000 / 3],
  ])("evaluates unit-aware expression %s in either unit system", (input, expected) => {
    for (const units of ["metric", "imperial"] as const) expect(parseLength(input, units)).toBeCloseTo(expected, 7);
  });

  it.each([
    ["20 - 10", "metric", 10000], ["20 - 10", "imperial", 3048],
    ["2 + 3 * 4", "metric", 14000], ["(2 + 3) * 4", "metric", 20000],
    ["12 / 2 / 3", "imperial", 609.6], ["1/2/3", "metric", 1000 / 6],
    ["1 m + 2", "metric", 3000], ["1 m + 2", "imperial", 1609.6],
    ['10\' - 6"', "metric", 2895.6], ["2 * (1 + 1) m", "metric", null],
    ["1 1/2 + 1/2", "imperial", 609.6], ["(6 m / 2 m) + 1", "metric", 4000],
  ] satisfies [string, Plan["units"], number | null][])("handles field units and precedence: %s (%s)", (input, units, expected) => {
    if (expected === null) expect(() => parseLength(input, units)).toThrow();
    else expect(parseLength(input, units)).toBeCloseTo(expected, 7);
  });

  it.each([
    ["20' - 20'", 0], ["1 m - 2 m", -1000], ["-(2 m + 50 cm)", -2500],
    ['-12\' -6"', -3810], ["+1 1/2 m", 1500], ["-0 m", 0],
  ])("supports signed and zero position results: %s", (input, expected) => {
    expect(parsePosition(input, "metric")).toBeCloseTo(expected, 7);
    expect(Object.is(parsePosition(input, "metric"), -0)).toBe(false);
    if (expected <= 0) expect(() => parseLength(input, "metric")).toThrow();
  });

  it.each([
    ["180 - 90", 90], ["90 deg + 22.5 degrees", 112.5], ["360 / 4", 90],
    ["(90\u00b0 + 45\u00b0) / 2", 67.5], ["2 * 45 deg", 90], ["+75.25 DEGREE", 75.25],
    ["1/2", 0.5], ["1/2 deg + 1 deg", 1.5], ["450 - 180", 270], ["-45 + 90", 45],
  ])("evaluates angle expression %s", (input, expected) => {
    expect(parseAngle(input)).toBe(expected);
  });

  it.each([
    "", " ", "()", "(1 + 2", "1 + 2)", "1 +", "*2", "2 ** 3", "2 // 3",
    "1 + ()", "2(3)", "(2)3", "2 ^ 3", "2 % 3", "2 = 3", "2,5",
    "--1", "+-1", "2 + --1", "4e3", "0x10", "4.2.3", "NaN", "Infinity",
    "Math.max(1, 2)", "alert(1)", "1;2", "1 /* test */ + 2", "1 + garbage", "9".repeat(121),
  ])("rejects malformed expressions without partial parsing: %s", input => {
    expect(() => parseLength(input, "metric")).toThrow();
    expect(() => parsePosition(input, "imperial")).toThrow();
    expect(() => parseAngle(input)).toThrow();
  });

  it.each(["4 m / 0", '1/0"', "1 / (2 - 2)", "1 / -0", "1 m / (2 m - 2 m)"])(
    "rejects division by zero: %s", input => expect(() => parseLength(input, "metric")).toThrow(/zero/),
  );

  it.each(["2 m * 3 m", '2 ft * 3"', "2 / (3 m)", "1 m + 45 deg", "1 m 20 cm", "12ft 6", "6 2/1 in"])(
    "rejects incompatible or ambiguous lengths: %s", input => expect(() => parseLength(input, "metric")).toThrow(),
  );

  it.each(["180 + 180", "90 - 90", "1 - 2", "90 m + 20", "90 deg * 2 deg", "90 / 0"])(
    "retains angle limits and units: %s", input => expect(() => parseAngle(input)).toThrow(),
  );

  it("validates final scalar bounds, permits bounded parentheses, and limits input size", () => {
    expect(() => parsePosition("200 m + 200 m", "metric")).toThrow(/coordinate limit/);
    expect(() => parsePosition("-200 m - 200 m", "metric")).toThrow(/coordinate limit/);
    expect(parseLength("(".repeat(50) + "1 m" + ")".repeat(50), "metric")).toBe(1000);
    expect(() => parseLength(" ".repeat(120) + "1", "metric")).toThrow();
    expect(() => parseLength(("9".repeat(39) + "*").repeat(2) + "9".repeat(39), "metric")).toThrow();
  });
});
