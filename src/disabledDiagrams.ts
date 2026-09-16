// The canvas falls back to plain text when optional diagram conversion is unavailable.
export const parseMermaidToExcalidraw: typeof import("@excalidraw/mermaid-to-excalidraw").parseMermaidToExcalidraw = async () => {
  throw new Error("Diagram conversion is not available in Homedraw. Paste renovation notes as text.");
};
