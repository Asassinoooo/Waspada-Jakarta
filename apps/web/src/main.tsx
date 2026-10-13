import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./source-preview.css";
import "./source-point-map.css";
import "./context-sources.css";
import "./unified-source-explorer.css";
import "./experience.css";
import "./help-page.css";
import "./landing.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The app root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
