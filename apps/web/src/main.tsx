import "./design/tokens.css";
import "./design/components.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, routeFromHash } from "./App.js";
import { startEarlyEventListLoad } from "./api-client.js";
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
// UI-V3: the refined visual layer loads last so it can refine every surface above.
import "./design/v3.css";
// GUI-04: the unified design layer loads last.
import "./design/v4.css";

applyStoredTheme();
// PERF-07: the map and list need the first event page; start it before the first render, on those routes only.
if (routeFromHash(window.location.hash).screen === "discover") startEarlyEventListLoad();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The app root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
