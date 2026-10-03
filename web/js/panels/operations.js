/**
 * Filters panel: the six pixel operations the API exposes.
 *
 * Every operation returns a NEW image id; the original is never overwritten
 * (the result becomes the input for the next operation, like the desktop).
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, el, labelled, numberInput, toast } from "../ui.js";

export function createOperationsPanel(ctx) {
  const { session, bus, state } = ctx;

  const brightnessInput = numberInput({ value: 40, min: -255, max: 255, step: 1 });
  const thresholdInput = numberInput({ value: 128, min: 0, max: 255, step: 1 });
  const windowInput = numberInput({ value: 3, min: 3, max: 31, step: 2 });

  const buttons = [];
  const status = el("p", { class: "muted", text: "Load an image to enable the filters." });

  function makeButton(label, operation, paramsFactory = null, extra = "") {
    const node = button(label, () => run(operation, paramsFactory), { size: "small", title: extra });
    buttons.push(node);
    return node;
  }

  const grayscale = makeButton("Grayscale", "grayscale");
  const negative = makeButton("Negative", "negative");
  const laplacian = makeButton("Laplacian", "laplacian");
  const brightness = makeButton("Brightness", "brightness", () => ({ value: readNumber(brightnessInput, -255, 255, "brightness") }));
  const threshold = makeButton("Threshold", "threshold", () => ({ value: readNumber(thresholdInput, 0, 255, "threshold") }));
  const meanfilter = makeButton("Mean filter", "meanfilter", () => ({ window: readOddWindow() }));

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

  const clearResult = button(
    "Clear result",
    () => {
      state.result = null;
      bus.emit("image:cleared", { role: "result" });
    },
    { size: "small", variant: "ghost" },
  );

  const panel = el("div", { class: "panel", id: "panel-filters", hidden: true }, [
    el("div", { class: "card" }, [
      el("h3", { text: "Point operations" }),
      el("div", { class: "btn-grid" }, [grayscale, negative, laplacian, clearResult]),
    ]),
    el("div", { class: "card" }, [
      el("h3", { text: "Brightness" }),
      labelled("Value (−255…255)", brightnessInput, "Adds a constant, clipped to 0…255."),
      brightness,
    ]),
    el("div", { class: "card" }, [
      el("h3", { text: "Threshold" }),
      labelled("Value (0…255)", thresholdInput, "Pixels above the value become white."),
      threshold,
    ]),
    el("div", { class: "card" }, [
      el("h3", { text: "Mean filter" }),
      labelled("Window (odd, 3…31)", windowInput, "OpenCV blur with a square kernel."),
      meanfilter,
    ]),
    status,
  ]);

  bus.on("image:loaded", () => setBusy(state.busy));
  bus.on("image:cleared", () => setBusy(state.busy));
  bus.on("session:reset", () => setBusy(false));
  setBusy(false);

  return { id: "filters", label: "Filters", node: panel };
}
