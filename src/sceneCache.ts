import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export type PlanShape = ExcalidrawElementSkeleton & { id: string };
type Entry = { signature: string; drawing: string; element: ExcalidrawElement; version: number; nonce: number };
const drawingSignature = ({ version, versionNonce, updated, index, ...drawing }: ExcalidrawElement) => JSON.stringify(drawing);

export function createSceneCache(convert: (shapes: PlanShape[]) => ExcalidrawElement[]) {
  let cache = new Map<string, Entry>();
  let elements: ExcalidrawElement[] = [];
  return {
    clear() { cache.clear(); elements = []; },
    render(shapes: PlanShape[]) {
      const next = new Map<string, Entry>();
      const changed: PlanShape[] = [];
      const signatures = new Map<string, string>();
      for (const shape of shapes) {
        const signature = JSON.stringify(shape);
        signatures.set(shape.id, signature);
        const previous = cache.get(shape.id);
        if (previous?.signature === signature) {
          const sameVersion = previous.element.version === previous.version && previous.element.versionNonce === previous.nonce;
          // Index repairs bump versions without changing what the canvas draws.
          if (sameVersion || drawingSignature(previous.element) === previous.drawing) {
            next.set(shape.id, sameVersion ? previous
              : { ...previous, version: previous.element.version, nonce: previous.element.versionNonce });
            continue;
          }
        }
        changed.push(shape);
      }
      // Excalidraw's shape/canvas caches use object identity, not element IDs.
      for (const converted of changed.length ? convert(changed) : []) {
        const previous = cache.get(converted.id)?.element;
        const element = {
          ...converted,
          version: (previous?.version ?? 0) + 1,
          // Let updateScene assign indices only to new parts, not the unchanged scene.
          index: previous?.index ?? null,
        };
        next.set(element.id, {
          signature: signatures.get(element.id)!, drawing: drawingSignature(element),
          element, version: element.version, nonce: element.versionNonce,
        });
      }
      const result = shapes.map(shape => {
        const entry = next.get(shape.id);
        if (!entry) throw new Error(`Could not render plan element ${shape.id}.`);
        return entry.element;
      });
      cache = next;
      if (result.length !== elements.length || result.some((element, i) => element !== elements[i])) elements = result;
      return elements;
    },
  };
}
