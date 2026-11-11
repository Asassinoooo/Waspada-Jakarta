// FLOW-VIS-01: the lazy entry for `#alur-agen`. The React Flow base styles and the page styles load
// only with this chunk, the same way admin-entry.ts loads the admin styles.
import "@xyflow/react/dist/base.css";
import "./pipeline-flow.css";
import { PipelineFlow } from "./PipelineFlow.js";

export default PipelineFlow;
