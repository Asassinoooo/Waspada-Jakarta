import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./experience.css";
import "./landing.css";
import "./public-polish.css";
import "./admin-dashboard.css";
import "./admin-map.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The app root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
