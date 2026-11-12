import "./design/tokens.css";
import "./design/components.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyStoredTheme } from "./ThemeToggle.js";
import "./styles.css";
import "./source-preview.css";
import "./source-point-map.css";
import "./context-sources.css";
import "./unified-source-explorer.css";
import "./experience.css";
import "./help-page.css";
import "./account.css";
import "./app-shell.css";
import "./embedding-3d.css";

applyStoredTheme();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The app root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
