/**
 * Filters section: the six pixel operations the API exposes.
 *
 * Every operation returns a NEW image id; the original is never overwritten
 * (the result becomes the input for the next operation, like the desktop).
 *
 * Parameter contract (api/schemas.py — do not guess these):
 *   grayscale / negative / laplacian → no body at all (the API 422s on extras)
 *   brightness → {"value": int}    -255…255   (required)
 *   threshold  → {"value": int}       0…255   (required)
 *   meanfilter → {"window": int}      3…31, odd
 *
 * `run()` is the ONLY way an operation is dispatched, and it always takes the
 * parameters for the requested operation from `PARAM_FACTORIES` below. Every
 * entry point (the panel buttons, the Processing menu, the chat router) goes
 * through it, so an operation can never be sent without its parameters.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, el, numberInput, toast, toolGroup } from "../ui.js";

export const OPERATION_LABELS = Object.freeze({
  grayscale: "Grayscale",
  negative: "Negative",
  laplacian: "Laplacian",
  brightness: "Brightness",
  threshold: "Threshold",
  meanfilter: "Mean filter",
});

/** Operations whose endpoints require a JSON body. */
export const OPERATIONS_WITH_PARAMS = Object.freeze(["brightness", "threshold", "meanfilter"]);

/** Short, human label for what was applied — used in toasts and the status bar. */
export function describeOperation(operation, params = null) {
  const label = OPERATION_LABELS[operation] ?? operation;
  if (!params) return label;
  if (operation === "brightness") {
    const value = Number(params.value);
    return Number.isFinite(value) ? `${label} ${value > 0 ? "+" : ""}${value}` : label;
  }
  if (operation === "threshold") return `${label} ${params.value}`;
  if (operation === "meanfilter") return `${label} w=${params.window}`;
  return label;
}

export function createOperationsPanel(ctx) {
  const { session, bus, state } = ctx;

  const brightnessInput = numberInput({ value: 40, min: -255, max: 255, step: 1 });
  const thresholdInput = numberInput({ value: 128, min: 0, max: 255, step: 1 });
  const windowInput = numberInput({ value: 3, min: 3, max: 31, step: 2 });

  const buttons = [];
  const status = el("p", { class: "note", text: "Load an image to enable the filters." });

  function readNumber(input, low, high, name) {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < low || value > high) {
      toast(`The ${name} value must be between ${low} and ${high}.`, "warn");
      return null;
    }
    return Math.round(value);
  }

  function readOddWindow() {
    let value = Number(windowInput.value);
    if (!Number.isFinite(value) || value < 3 || value > 31) {
      toast("The mean-filter window must be between 3 and 31.", "warn");
      return null;
    }
    value = Math.round(value);
    if (value % 2 === 0) {
      value += 1;
      windowInput.value = String(value);
      toast(`The window must be odd — using ${value}.`, "warn");
    }
    return value;
  }

  /**
   * The single source of parameters per operation. The panel buttons, the
   * Processing menu and the chat commands all resolve through this table.
   */
  const PARAM_FACTORIES = {
    brightness: () => ({ value: readNumber(brightnessInput, -255, 255, "brightness") }),
    threshold: () => ({ value: readNumber(thresholdInput, 0, 255, "threshold") }),
    meanfilter: () => ({ window: readOddWindow() }),
  };

  /** Parameters for an operation from the panel's current inputs (null = none). */
  function paramsFor(operation) {
    const factory = PARAM_FACTORIES[operation];
    if (!factory) return null;
    const params = factory();
    if (!params) return undefined; // invalid — the reader already explained why
    if (Object.values(params).some((value) => value == null || !Number.isFinite(Number(value)))) {
      return undefined;
    }
    return params;
  }

  function makeButton(label, operation, extra = "") {
    const node = button(label, () => run(operation), { size: "small", title: extra });
    buttons.push(node);
    return node;
  }

  const grayscale = makeButton("Grayscale", "grayscale", "Convert to grayscale (0.299R + 0.587G + 0.114B)");
  const negative = makeButton("Negative", "negative", "Invert every channel: 255 − value");
  const laplacian = makeButton("Laplacian", "laplacian", "Edge detection with the OpenCV Laplacian kernel");
  const brightness = makeButton("Brightness", "brightness", "Add a constant, clipped to 0…255");
  const threshold = makeButton("Threshold", "threshold", "Pixels above the value become white");
  const meanfilter = makeButton("Mean filter", "meanfilter", "OpenCV blur with a square kernel");

  /**
   * Dispatch one operation. `paramsOverride` lets a caller supply the values
   * explicitly (the chat router does); otherwise they come from the panel.
   */
  async function run(operation, paramsOverride = null) {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return { ok: false, reason: "no-image" };
    }

    let params = null;
    if (OPERATIONS_WITH_PARAMS.includes(operation)) {
      params = paramsOverride ?? paramsFor(operation);
      if (params === undefined) return { ok: false, reason: "invalid-params" };
      // Belt and braces: never dispatch a parameterised operation without a body.
      if (!params || Object.values(params).some((value) => value == null)) {
        toast(`${OPERATION_LABELS[operation] ?? operation} needs its parameters — set them in the Filters panel.`, "warn");
        return { ok: false, reason: "missing-params" };
      }
    } else if (paramsOverride) {
      toast(`${OPERATION_LABELS[operation] ?? operation} does not take parameters.`, "warn");
      return { ok: false, reason: "unexpected-params" };
    }

    const label = describeOperation(operation, params);
    setBusy(true, label);
    try {
      const info = await session.withImage(active.id, (sid, imageId) =>
        ctx.api.runOperation(sid, imageId, operation, params),
      );
      // set before the image is registered: the undo history labels the state
      // with the operation that produced it
      state.lastOperation = { operation: label, imageId: info.image_id, at: Date.now() };
      session.useAsResult(info);
      applyFeedback(label, info);
      return { ok: true, info, label };
    } catch (error) {
      report(error, operation, label);
      return { ok: false, reason: "failed", error };
    } finally {
      setBusy(false);
    }
  }

  /** Visible feedback: the result viewport updates (via useAsResult), plus a
   *  labelled toast and a persistent status-bar entry. */
  function applyFeedback(label, info) {
    toast(`${label} applied → ${info.width}×${info.height}`, "ok");
    bus.emit("status", { message: `${label} applied — new image ${info.image_id}` });
    bus.emit("operation:applied", { label, info });
  }

  function setBusy(busy, operation = "") {
    state.busy = busy;
    for (const node of buttons) node.disabled = busy || !activeImage(state);
    status.textContent = busy
      ? `Running ${operation}…`
      : activeImage(state)
        ? "Operations apply to the current result (or the original when there is none)."
        : "Load an image to enable the filters.";
    bus.emit("busy", busy);
  }

  function report(error, operation, label) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    const text = humanizeError(error, { apiBase: ctx.api.base, operation });
    state.lastOperation = { operation: `${label} failed`, imageId: null, at: Date.now(), error: true };
    toast(`${label} failed — ${text}`, "bad", { timeout: 12000 });
    bus.emit("status", { message: `${label} failed: ${text}` });
  }

  function clearResult() {
    state.result = null;
    bus.emit("image:cleared", { role: "result" });
    bus.emit("status", { message: "Result cleared — operations now apply to the working image" });
  }

  const clearButton = button("Clear result", clearResult, { size: "small", variant: "ghost" });

  // parameter rows keep the control next to its Apply button (toolbox density)
  function paramRow(applyButton, input, label, operation) {
    const node = el("div", { class: "row center", dataset: { opRow: operation } }, [
      el("div", { class: "field", style: { marginBottom: "0" } }, [
        el("label", { text: label }),
        input,
      ]),
      applyButton,
    ]);
    rowByOperation.set(operation, node);
    return node;
  }

  const rowByOperation = new Map();

  /** Bring an operation's controls into view (used by the Processing menu). */
  function revealParams(operation) {
    const row = rowByOperation.get(operation);
    if (!row) return;
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1400);
    const input = row.querySelector("input");
    if (input) {
      input.focus();
      input.select?.();
    }
  }

  const section = createSection({
    id: "filters",
    title: "Filters",
    iconName: "filters",
    body: [
      toolGroup("Point operations", [
        el("div", { class: "btn-grid" }, [grayscale, negative, laplacian, clearButton]),
      ]),
      toolGroup("Brightness", [
        paramRow(brightness, brightnessInput, "Value (−255…255)", "brightness"),
        el("p", { class: "note", text: "Adds a constant, clipped to 0…255." }),
      ]),
      toolGroup("Threshold", [
        paramRow(threshold, thresholdInput, "Value (0…255)", "threshold"),
        el("p", { class: "note", text: "Pixels above the value become white." }),
      ]),
      toolGroup("Mean filter", [
        paramRow(meanfilter, windowInput, "Window (odd, 3…31)", "meanfilter"),
        el("p", { class: "note", text: "OpenCV blur with a square kernel." }),
      ]),
      status,
    ],
  });

  bus.on("image:loaded", () => setBusy(state.busy));
  bus.on("image:cleared", () => setBusy(state.busy));
  bus.on("session:reset", () => setBusy(false));
  setBusy(false);

  return {
    id: "filters",
    label: "Filters",
    section,
    actions: { run, clearResult, paramsFor, revealParams, describeOperation },
  };
}
