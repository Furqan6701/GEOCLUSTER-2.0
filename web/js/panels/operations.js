/**
 * Filters section: the six pixel operations the API exposes.
 *
 * Every operation returns a NEW image id; the original is never overwritten
 * (the result becomes the input for the next operation, like the desktop).
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, el, numberInput, toast, toolGroup } from "../ui.js";

export function createOperationsPanel(ctx) {
  const { session, bus, state } = ctx;

  const brightnessInput = numberInput({ value: 40, min: -255, max: 255, step: 1 });
  const thresholdInput = numberInput({ value: 128, min: 0, max: 255, step: 1 });
  const windowInput = numberInput({ value: 3, min: 3, max: 31, step: 2 });

  const buttons = [];
  const status = el("p", { class: "note", text: "Load an image to enable the filters." });

  function makeButton(label, operation, paramsFactory = null, extra = "") {
    const node = button(label, () => run(operation, paramsFactory), { size: "small", title: extra });
    buttons.push(node);
    return node;
  }

  const grayscale = makeButton("Grayscale", "grayscale", null, "Convert to grayscale (0.299R + 0.587G + 0.114B)");
  const negative = makeButton("Negative", "negative", null, "Invert every channel: 255 − value");
  const laplacian = makeButton("Laplacian", "laplacian", null, "Edge detection with the OpenCV Laplacian kernel");
  const brightness = makeButton("Brightness", "brightness", () => ({ value: readNumber(brightnessInput, -255, 255, "brightness") }), "Add a constant, clipped to 0…255");
  const threshold = makeButton("Threshold", "threshold", () => ({ value: readNumber(thresholdInput, 0, 255, "threshold") }), "Pixels above the value become white");
  const meanfilter = makeButton("Mean filter", "meanfilter", () => ({ window: readOddWindow() }), "OpenCV blur with a square kernel");

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

  async function run(operation, paramsFactory) {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return;
    }
    const params = paramsFactory ? paramsFactory() : null;
    if (paramsFactory && params === null) return; // validation already reported
    if (params && Object.values(params).some((value) => value == null)) return;

    setBusy(true, operation);
    try {
      const info = await session.withSession((sid) => ctx.api.runOperation(sid, active.id, operation, params));
      session.useAsResult(info);
      toast(`${operation} complete — new image ${info.image_id}`, "ok");
    } catch (error) {
      report(error, operation);
    } finally {
      setBusy(false);
    }
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

  function report(error, operation) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${operation} failed: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  function clearResult() {
    state.result = null;
    bus.emit("image:cleared", { role: "result" });
    bus.emit("status", { message: "Result cleared — operations now apply to the working image" });
  }

  const clearButton = button("Clear result", clearResult, { size: "small", variant: "ghost" });

  // parameter rows keep the control next to its Apply button (toolbox density)
  function paramRow(applyButton, input, label) {
    return el("div", { class: "row center" }, [
      el("div", { class: "field", style: { marginBottom: "0" } }, [
        el("label", { text: label }),
        input,
      ]),
      applyButton,
    ]);
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
        paramRow(brightness, brightnessInput, "Value (−255…255)"),
        el("p", { class: "note", text: "Adds a constant, clipped to 0…255." }),
      ]),
      toolGroup("Threshold", [
        paramRow(threshold, thresholdInput, "Value (0…255)"),
        el("p", { class: "note", text: "Pixels above the value become white." }),
      ]),
      toolGroup("Mean filter", [
        paramRow(meanfilter, windowInput, "Window (odd, 3…31)"),
        el("p", { class: "note", text: "OpenCV blur with a square kernel." }),
      ]),
      status,
    ],
  });

  bus.on("image:loaded", () => setBusy(state.busy));
  bus.on("image:cleared", () => setBusy(state.busy));
  bus.on("session:reset", () => setBusy(false));
  setBusy(false);

  return { id: "filters", label: "Filters", section, actions: { run, clearResult } };
}
