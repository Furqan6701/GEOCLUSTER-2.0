/**
 * Panel registry: every toolbox dock section is created here.
 * Order matters — the first entry is the first section in the dock.
 */

import { createAnalysisPanel } from "./analysis.js";
import { createClustersPanel } from "./clusters.js";
import { createOperationsPanel } from "./operations.js";
import { createSourcePanel } from "./source.js";

export function createPanels(ctx) {
  return [
    createSourcePanel(ctx),
    createOperationsPanel(ctx),
    createClustersPanel(ctx),
    createAnalysisPanel(ctx),
  ];
}
