import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@excalidraw/mermaid-to-excalidraw": fileURLToPath(new URL("./src/disabledDiagrams.ts", import.meta.url)),
    },
  },
});
