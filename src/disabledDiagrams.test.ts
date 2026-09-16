import { expect, it } from "vitest";
import { parseMermaidToExcalidraw } from "./disabledDiagrams";

it("explicitly rejects diagram conversion so the canvas can preserve pasted source as text", async () => {
  await expect(parseMermaidToExcalidraw("graph TD\n A --> B")).rejects.toThrow("Diagram conversion is not available in Homedraw");
});
