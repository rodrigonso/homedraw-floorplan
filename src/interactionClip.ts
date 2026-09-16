import ClipperLib from "clipper-lib";

export type HitBounds = readonly [number, number, number, number];
const PRECISION = 100;

export function interactionClip(width: number, height: number, holes: readonly HitBounds[]): string | undefined {
  if (!holes.length || width <= 0 || height <= 0) return undefined;
  const rectangle = ([left, top, right, bottom]: HitBounds): ClipperLib.Path =>
    [[left, top], [right, top], [right, bottom], [left, bottom]]
      .map(([x, y]) => ({ X: Math.round(x * PRECISION), Y: Math.round(y * PRECISION) }));
  const clipper = new ClipperLib.Clipper();
  clipper.AddPath(rectangle([0, 0, width, height]), ClipperLib.PolyType.ptSubject, true);
  const visible = holes.map(([left, top, right, bottom]): HitBounds =>
    [Math.max(0, left), Math.max(0, top), Math.min(width, right), Math.min(height, bottom)])
    .filter(([left, top, right, bottom]) => left < right && top < bottom);
  clipper.AddPaths(visible.map(rectangle), ClipperLib.PolyType.ptClip, true);
  const result: ClipperLib.Paths = [];
  if (!clipper.Execute(ClipperLib.ClipType.ctDifference, result,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error("Could not calculate text interaction regions.");
  }
  return result.map(path => `${path.map((p, index) =>
    `${index ? "L" : "M"}${p.X / PRECISION},${p.Y / PRECISION}`).join(" ")}Z`).join(" ");
}
