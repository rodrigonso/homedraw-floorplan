type Quantity = { value: number; measured: boolean };
export type LengthUnit = "m" | "cm" | "ft" | "in";
type MeasurementUnit = LengthUnit | "angle";

const DECIMAL = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const MIXED = String.raw`\d+\s+\d+\s*\/\s*\d+`;
const AMOUNT = String.raw`(?:${MIXED}|\d+\s*\/\s*\d+|${DECIMAL})`;
const END = String.raw`(?=\s*(?:[+\-*/()]|$))`;
const METRIC = new RegExp(`^(${AMOUNT})\\s*(mm|cm|m|millimeters?|millimetres?|centimeters?|centimetres?|meters?|metres?)${END}`);
const FEET = new RegExp(`^(${AMOUNT})\\s*(?:ft|feet|foot|')\\s*(?:(${AMOUNT})\\s*(?:in|inches|inch|"))?${END}`);
const INCHES = new RegExp(`^(${AMOUNT})\\s*(?:in|inches|inch|")${END}`);
const DEGREES = new RegExp(`^(${AMOUNT})\\s*(?:\\u00b0|deg(?:ree(?:s)?)?)${END}`);
const SCALAR = new RegExp(`^(${MIXED}|${DECIMAL})${END}`);

function amount(input: string): number {
  const fraction = input.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (!fraction) return Number(input);
  const denominator = Number(fraction[3]), numerator = Number(fraction[2]);
  if (denominator === 0) throw new Error("Cannot divide by zero.");
  if (fraction[1] && numerator >= denominator) {
    throw new Error("Use a proper fraction after a whole number, such as 6 1/2.");
  }
  return Number(fraction[1] ?? 0) + numerator / denominator;
}

function finite(quantity: Quantity): Quantity {
  if (!Number.isFinite(quantity.value)) throw new Error("The measurement must have a finite result.");
  return quantity;
}

export function evaluateMeasurement(input: string, units: MeasurementUnit): number {
  const example = units === "angle" ? "90 deg - 15 deg" : "20' - 10' or 4 m / 2";
  const invalid = () => new Error(`Enter a valid measurement or expression, such as ${example}.`);
  if (typeof input !== "string" || input.length > 120) throw invalid();
  const text = input.trim().toLowerCase().replace(/\u2032/g, "'").replace(/\u2033/g, '"');
  const defaultScale = { m: 1000, cm: 10, ft: 304.8, in: 25.4, angle: 1 }[units];
  let cursor = 0;
  const skipSpace = () => { while (cursor < text.length && /\s/.test(text[cursor])) cursor++; };
  const take = (character: string) => {
    skipSpace();
    if (text[cursor] !== character) return false;
    cursor++;
    return true;
  };
  const measuredValue = (quantity: Quantity) => quantity.value * (quantity.measured ? 1 : defaultScale);

  function literal(): Quantity {
    skipSpace();
    const rest = text.slice(cursor);
    let match: RegExpMatchArray | null;
    let value: number, measured = true;
    if (units === "angle" && (match = rest.match(DEGREES))) {
      value = amount(match[1]);
    } else if (units !== "angle" && (match = rest.match(METRIC))) {
      const unit = match[2];
      value = amount(match[1]) * (unit === "mm" || unit.startsWith("milli") ? 1 : unit === "cm" || unit.startsWith("centi") ? 10 : 1000);
    } else if (units !== "angle" && (match = rest.match(FEET))) {
      value = amount(match[1]) * 304.8 + (match[2] ? amount(match[2]) * 25.4 : 0);
    } else if (units !== "angle" && (match = rest.match(INCHES))) {
      value = amount(match[1]) * 25.4;
    } else if ((match = rest.match(SCALAR))) {
      value = amount(match[1]);
      measured = false;
    } else {
      throw invalid();
    }
    cursor += match[0].length;
    return finite({ value, measured });
  }

  function primary(): Quantity {
    if (!take("(")) return literal();
    const result = sum();
    if (!take(")")) throw new Error("Close each parenthesis in the measurement.");
    return result;
  }

  function unary(): Quantity {
    // One optional sign per operand; consecutive signs such as "--2" are invalid.
    let sign = 1;
    if (take("-")) sign = -1;
    else take("+");
    const result = primary();
    return { ...result, value: result.value * sign };
  }

  function product(): Quantity {
    let left = unary();
    while (true) {
      const operator = take("*") ? "*" : take("/") ? "/" : null;
      if (!operator) return left;
      const right = unary();
      if (operator === "*") {
        if (left.measured && right.measured) throw new Error("Multiply a measurement by a unitless number, not another measurement.");
        left = finite({ value: left.value * right.value, measured: left.measured || right.measured });
      } else {
        if (right.value === 0) throw new Error("Cannot divide by zero.");
        if (!left.measured && right.measured) throw new Error("Cannot divide a unitless number by a measurement.");
        left = finite({ value: left.value / right.value, measured: left.measured && !right.measured });
      }
    }
  }

  function sum(): Quantity {
    let left = product();
    while (true) {
      const operator = take("+") ? "+" : take("-") ? "-" : null;
      if (!operator) return left;
      const right = product(), measured = left.measured || right.measured;
      // Bare addends use the field's units; bare multipliers/divisors stay scalar.
      const a = measured ? measuredValue(left) : left.value;
      const b = measured ? measuredValue(right) : right.value;
      left = finite({ value: operator === "+" ? a + b : a - b, measured });
    }
  }

  const result = sum();
  skipSpace();
  if (cursor !== text.length) throw invalid();
  return finite({ value: measuredValue(result), measured: true }).value;
}
