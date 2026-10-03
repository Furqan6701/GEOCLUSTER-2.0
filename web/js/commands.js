/**
 * Chat command mapping.
 *
 * The backend router answers with structured commands:
 *   {"action": "run_operation", "operation": "kmeans"}
 *   {"action": "open_histogram" | "open_compress" | "open_distance"}
 *   {"action": "fetch_satellite", "location": "F-8"}
 *
 * Operations that need parameters (kmeans/brightness/threshold/meanfilter) are
 * executed with the defaults below — the router carries no numbers. The desktop
 * asked the user for them in dialogs; here the same numbers can be edited in
 * the Filters/Clusters panels, and the chat notes which defaults it used.
 */

export const OPERATION_DEFAULTS = Object.freeze({
  kmeans: Object.freeze({ k: 5, max_iter: 30 }),
  meanfilter: Object.freeze({ window: 3 }),
  threshold: Object.freeze({ value: 128 }),
  brightness: Object.freeze({ value: 20 }),
});

export const COMMAND_ACTIONS = Object.freeze({
  run_operation: "run an operation",
  open_histogram: "open the histogram",
  open_compress: "compress the image",
  open_distance: "measure a distance",
  fetch_satellite: "fetch satellite imagery",
});

/** Parameters for one operation, or null when it takes none. */
export function defaultParamsFor(operation) {
  const defaults = OPERATION_DEFAULTS[operation];
  return defaults ? { ...defaults } : null;
}

/** One-line, human description of a command (used in the chat log). */
export function describeCommand(command) {
  const action = command?.action;
  switch (action) {
    case "run_operation": {
      const params = defaultParamsFor(command.operation);
      return params
        ? `run ${command.operation} (defaults: ${JSON.stringify(params)})`
        : `run ${command.operation}`;
    }
    case "open_histogram":
      return "open the histogram";
    case "open_compress":
      return "compress the current image to .gch";
    case "open_distance":
      return "open the distance tool";
    case "fetch_satellite":
      return `fetch satellite imagery for ${command.location ?? "(no location)"}`;
    default:
      return `unknown action "${action ?? "(missing)"}"`;
  }
}

/**
 * Execute a list of commands through the provided handlers.
 * Returns human-readable notes (never throws: failures become notes).
 *
 * handlers: { runOperation, openHistogram, openCompress, openDistance,
 *             fetchSatellite, describeError }
 */
export async function executeCommands(commands, handlers = {}) {
  const notes = [];
  for (const command of commands ?? []) {
    const action = command?.action;
    try {
      switch (action) {
        case "run_operation": {
          const operation = command.operation;
          const params = defaultParamsFor(operation);
          await handlers.runOperation?.(operation, params);
          notes.push(params ? `Ran ${operation} with ${JSON.stringify(params)}.` : `Ran ${operation}.`);
          break;
        }
        case "open_histogram":
          await handlers.openHistogram?.();
          notes.push("Histogram ready.");
          break;
        case "open_compress":
          await handlers.openCompress?.();
          notes.push("Compression started — the .gch file downloads when it finishes.");
          break;
        case "open_distance":
          await handlers.openDistance?.();
          notes.push("Distance tool enabled — click two points on a viewer.");
          break;
        case "fetch_satellite":
          await handlers.fetchSatellite?.(command.location);
          notes.push(`Satellite fetch requested for ${command.location}.`);
          break;
        default:
          notes.push(`Nothing handles "${action}" yet.`);
      }
    } catch (error) {
      const text = handlers.describeError ? handlers.describeError(error) : String(error?.message ?? error);
      notes.push(`${describeCommand(command)} failed: ${text}`);
    }
  }
  return notes;
}
