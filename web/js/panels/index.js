/**
 * Panel registry: every sidebar tab is created here.
 * Order matters — the first entry is the default tab.
 */

import { createAnalysisPanel } from "./analysis.js";
import { createClustersPanel } from "./clusters.js";
import { createFilesPanel } from "./files.js";
import { createOperationsPanel } from "./operations.js";
import { createSourcePanel } from "./source.js";

export function createPanels(ctx) {
  return [
    { id: "source", label: "Source", node: createSourcePanel(ctx) },
    createOperationsPanel(ctx),
    createClustersPanel(ctx),
    createAnalysisPanel(ctx),
    createFilesPanel(ctx),
  ];
}
