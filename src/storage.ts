import { restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { createDemoPlan, validatePlan, type Plan } from "./model";

export const STORAGE_KEY = "homedraw.project.v1";
export const SUPPORTED_SKETCH_TYPES = new Set(["rectangle", "diamond", "ellipse", "line", "arrow", "text", "freedraw"]);
export type Project = { format: "homedraw"; version: 1; plan: Plan; sketches: readonly ExcalidrawElement[] };
export const makeProject = (plan: Plan, sketches: readonly ExcalidrawElement[]): Project => ({
  format: "homedraw", version: 1, plan, sketches,
});
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "An unexpected error occurred.";

export function parseProject(text: string): Project {
  if (text.length > 10_000_000) throw new Error("This project is too large. The limit is 10 MB.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("format" in value) || value.format !== "homedraw"
    || !("version" in value) || value.version !== 1 || !("plan" in value)) {
    throw new Error("Please choose a version 1 Homedraw project (.homedraw.json).");
  }
  const plan = validatePlan(value.plan);
  if (!("sketches" in value) || !Array.isArray(value.sketches) || value.sketches.length > 5000) {
    throw new Error("The project's sketch layer is invalid or too large.");
  }
  for (const element of value.sketches) {
    if (!element || typeof element !== "object" || !SUPPORTED_SKETCH_TYPES.has(element.type)
      || typeof element.id !== "string" || ![element.x, element.y, element.width, element.height].every(Number.isFinite)
      || (element.type === "text" && typeof element.text !== "string")
      || (["line", "arrow", "freedraw"].includes(element.type) && (!Array.isArray(element.points)
        || !element.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))))) {
      throw new Error("The project contains an invalid sketch element. Images and embedded content are not supported.");
    }
  }
  const sketches = restoreElements(value.sketches, null).map(element => ({
    ...element, customData: undefined, link: null, locked: false,
  }));
  if (sketches.some(element => element.id.startsWith("plan-"))
    || new Set(sketches.map(element => element.id)).size !== sketches.length) {
    throw new Error("The project contains conflicting sketch element IDs.");
  }
  return makeProject(plan, sketches);
}

export function loadInitialProject(): { project: Project; error: string | null } {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return { project: saved ? parseProject(saved) : makeProject(createDemoPlan(), []), error: null };
  } catch (error) {
    return {
      project: makeProject(createDemoPlan(), []),
      error: `Your saved project could not be loaded: ${errorMessage(error)} Autosave is paused to protect the saved data. Open a project or start a new plan to resume.`,
    };
  }
}

export function downloadFile(content: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
