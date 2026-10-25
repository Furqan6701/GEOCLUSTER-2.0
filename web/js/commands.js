/**
 * Chat command mapping.
 *
 * Two kinds of command arrive from the backend:
 *   - the RULE-BASED router's deterministic commands, e.g.
 *       {"action": "run_operation", "operation": "negative"}
 *       {"action": "run_kmeans"}
 *       {"action": "open_histogram" | "open_compress" | "open_distance"}
 *       {"action": "fetch_satellite", "location": "F-8"}
 *   - the AI's chosen action: exactly the same names, but with the
 *     parameters the model picked, e.g.
 *       {"action": "run_operation", "operation": "meanfilter", "params": {"window": 5}}
 *       {"action": "run_kmeans", "params": {"k": 7}}
 * The backend validates every value against this same table before sending it;
 * `validateCommandParams()` is the client-side second check, so a command can
 * never reach a panel with a value the panel would reject.
 *
 * Commands without parameters are executed with the defaults below - they are
 * the numbers the matching UI control starts at, so the effect is the same as
 * clicking that button.
 */

export const OPERATION_DEFAULTS = Object.freeze({
  // max_iter is fixed app-wide (the panel sends the same value; the field was
  // removed) so every K-Means entry point behaves identically
  kmeans: Object.freeze({ k: 5, max_iter: 100 }),
  meanfilter: Object.freeze({ window: 3 }),
  threshold: Object.freeze({ value: 128 }),
  brightness: Object.freeze({ value: 20 }),
});

/**
 * The accepted range of every parameterised operation (mirrors the API schema
 * and the Filters panel sliders; the server validates against the same bounds).
 */
export const OPERATION_PARAM_SPECS = Object.freeze({
  brightness: Object.freeze({ value: Object.freeze({ min: -255, max: 255 }) }),
  threshold: Object.freeze({ value: Object.freeze({ min: 0, max: 255 }) }),
  meanfilter: Object.freeze({ window: Object.freeze({ min: 3, max: 31, odd: true }) }),
  kmeans: Object.freeze({ k: Object.freeze({ min: 2, max: 10 }) }),
});

/** Parameters for one operation, or null when it takes none. */
export function defaultParamsFor(operation) {
  const defaults = OPERATION_DEFAULTS[operation];
  return defaults ? { ...defaults } : null;
}

/**
 * The parameters a command wants, or null when the operation takes none.
 * Values the command did not carry fall back to the documented defaults.
 */
export function paramsForCommand(operation, params = null) {
  if (!OPERATION_PARAM_SPECS[operation]) return null;
  return validateCommandParams(operation, params) ?? defaultParamsFor(operation);
}

/**
 * The validated parameters for one operation, or null when they are missing or
 * out of range. Mirrors the server's whitelist check: whole numbers only, odd
 * windows snapped exactly like the panel's slider, nothing clamped silently.
 */
export function validateCommandParams(operation, params = null) {
  const specs = OPERATION_PARAM_SPECS[operation];
  if (!specs) return null;
  if (!params || typeof params !== "object") return null;
  const names = Object.keys(specs);
  if (Object.keys(params).some((name) => !names.includes(name))) return null;
  const values = {};
  for (const name of names) {
    if (!(name in params)) return null;
    const spec = specs[name];
    const raw = params[name];
    if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
    if (raw < spec.min || raw > spec.max) return null;
    values[name] = spec.odd && raw % 2 === 0 ? (raw + 1 <= spec.max ? raw + 1 : raw - 1) : raw;
  }
  return values;
}

/** One-line, human description of a command (used in the chat log). */
export function describeCommand(command) {
  const action = command?.action;
  switch (action) {
    case "run_operation": {
      if (command.params) return `run ${command.operation} (${JSON.stringify(command.params)})`;
      const params = defaultParamsFor(command.operation);
      return params
        ? `run ${command.operation} (defaults: ${JSON.stringify(params)})`
        : `run ${command.operation}`;
    }
    case "run_kmeans":
      return command.params?.k != null ? `run K-Means with k=${command.params.k}` : "run K-Means";
    case "classify_clusters":
      return "classify the clusters and build the map";
    case "open_map_composer":
      return "open the map composer";
    case "open_histogram":
      return "open the histogram";
    case "open_compress":
      return "compress the current image to .gch";
    case "open_distance":
      return "open the distance tool";
    case "export_png":
      return "export the current image as PNG";
    case "export_label_map":
      return "export the raw label map";
    case "undo":
      return "undo the last step";
    case "redo":
      return "redo the last step";
    case "clear_result":
      return "clear the result";
    case "fit_view":
      return "fit the image to the viewport";
    case "actual_size":
      return "show the image at actual size";
    case "zoom_in":
      return "zoom in";
    case "zoom_out":
      return "zoom out";
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
 * Every handler must be the SAME entry point the matching UI control uses, so
 * the undo history, the result viewport and the toasts behave exactly as if the
 * user had clicked that button or moved that slider.
 *
 * handlers: { runOperation, runKMeans, classifyClusters, openMapComposer,
 *             openHistogram, openCompress, openDistance, exportPng,
 *             exportLabelMap, undo, redo, clearResult, fitView, actualSize,
 *             zoomIn, zoomOut, fetchSatellite, describeError }
 */
export async function executeCommands(commands, handlers = {}) {
  const notes = [];
  for (const command of commands ?? []) {
    const action = command?.action;
    try {
      switch (action) {
        case "run_operation": {
          const operation = command.operation;
          if (operation === "kmeans") {
            // legacy shape: the desktop's router called K-Means an operation
            const k = command.params?.k;
            await handlers.runKMeans?.(k);
            notes.push(k != null ? `Ran K-Means with k=${k}.` : "Ran K-Means.");
            break;
          }
          const params = command.params ?? defaultParamsFor(operation);
          await handlers.runOperation?.(operation, params);
          notes.push(params ? `Ran ${operation} with ${JSON.stringify(params)}.` : `Ran ${operation}.`);
          break;
        }
        case "run_kmeans": {
          const k = command.params?.k;
          await handlers.runKMeans?.(k);
          notes.push(k != null ? `Ran K-Means with k=${k}.` : "Ran K-Means.");
          break;
        }
        case "classify_clusters":
          await handlers.classifyClusters?.();
          notes.push("Classification applied - the map composer is ready.");
          break;
        case "open_map_composer":
          await handlers.openMapComposer?.();
          notes.push("Map composer opened.");
          break;
        case "open_histogram":
          await handlers.openHistogram?.();
          notes.push("Histogram ready.");
          break;
        case "open_compress":
          await handlers.openCompress?.();
          notes.push("Compression started - the .gch file downloads when it finishes.");
          break;
        case "open_distance":
          await handlers.openDistance?.();
          notes.push("Distance tool enabled - click two points on a viewer.");
          break;
        case "export_png":
          await handlers.exportPng?.();
          notes.push("Exporting the current image as a PNG.");
          break;
        case "export_label_map":
          await handlers.exportLabelMap?.();
          notes.push("Exporting the raw label map.");
          break;
        case "undo":
          await handlers.undo?.();
          notes.push("Undone.");
          break;
        case "redo":
          await handlers.redo?.();
          notes.push("Redone.");
          break;
        case "clear_result":
          await handlers.clearResult?.();
          notes.push("Result cleared.");
          break;
        case "fit_view":
          await handlers.fitView?.();
          notes.push("Fitted to view.");
          break;
        case "actual_size":
          await handlers.actualSize?.();
          notes.push("Showing the image at actual size.");
          break;
        case "zoom_in":
          await handlers.zoomIn?.();
          notes.push("Zoomed in.");
          break;
        case "zoom_out":
          await handlers.zoomOut?.();
          notes.push("Zoomed out.");
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
