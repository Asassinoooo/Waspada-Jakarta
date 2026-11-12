// UI-V2-C: the lazy entry for the administrator workspace (`#admin/<tab>`). Its styles load with the workspace
// chunk. Each tab then loads its own chunk when it opens.
import "./admin-dashboard.css";
import "./admin-map.css";
import "./admin-workspace.css";

export { default } from "./AdminWorkspace.js";
