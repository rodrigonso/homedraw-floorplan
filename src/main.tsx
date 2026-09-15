import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { themeVariables } from "./theme";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

for (const [name, value] of Object.entries(themeVariables)) {
  document.documentElement.style.setProperty(name, value);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
