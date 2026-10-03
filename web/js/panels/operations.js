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
 * entry point (the panel, the Processing menu, the chat router) goes through
 * it, so an operation can never be sent without its parameters.
 *
 * Brightness, Threshold and Mean filter have no Apply button: their slider
 * drives the Result viewport live through a browser-side preview
 * (js/preview.js) and ONE request is sent when the slider is released. Further
 * releases of the same slider REPLACE that adjustment — it is always measured
 * against the image as it was before the first touch, so the undo history
 * keeps exactly one step for the whole adjustment.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, el, helpPopover, numberInput, toast, toolGroup } from "../ui.js";
import { preview as defaultPreview } from "../preview.js";

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

/**
 * Help texts, verbatim from the redesign brief. They sit next to the code that
 * implements the behaviour so the two can be compared:
 *   - brightness / threshold / mean filter mirror api/geocluster/filters.py;
 *   - "Clear result" is kept verbatim even though the viewport is emptied
 *     rather than re-showing the original — the mismatch is documented in
 *     docs/frontend-notes.md and in the Step 3 report.
 */
export const HELP_TEXTS = Object.freeze({
  filters: "Each filter is applied to the latest result, so filters can be combined. Use Undo to step back.",
  grayscale: "Converts the image to a single-band grayscale image using a luminance-weighted combination of the color channels.",
  negative: "Inverts pixel values to produce a photographic negative.",
  laplacian: "Edge detection filter that highlights areas of rapid intensity change, such as boundaries and fine detail.",
  brightness: "Shifts all pixel values by a constant amount from -255 to 255. Positive values brighten the image and negative values darken it. Results are limited to the valid 0 to 255 range.",
  threshold: "Each color value (red, green, blue) above the threshold is set to its maximum, and all others are set to zero.",
  meanfilter: "Smooths the image by averaging neighboring pixels.",
  clear: "Resets the result viewport to the original image. The undo history is not affected.",
});

/** Slider definitions: range, default and how the current value is shown. */
export const SLIDER_SPECS = Object.freeze({
  brightness: { label: "Value", min: -255, max: 255, step: 1, value: 40 },
  threshold: { label: "Value", min: 0, max: 255, step: 1, value: 128 },
  meanfilter: { label: "Kernel size", min: 3, max: 31, step: 2, value: 3, choice: (value) => `${value} x ${value}` },
});

/** How long a lone arrow-key press waits before it commits (a "short pause"). */
export const KEY_COMMIT_DELAY = 450;

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

/** Clamp to the slider range and keep the mean-filter window odd. */
export function snapSliderValue(operation, raw) {
  const spec = SLIDER_SPECS[operation];
  if (!spec) return null;
  let value = Number(raw);
  if (!Number.isFinite(value)) return null;
  value = Math.round(value);
  if (value < spec.min) value = spec.min;
  if (value > spec.max) value = spec.max;
  if (operation === "meanfilter" && value % 2 === 0) {
    value = value + 1 <= spec.max ? value + 1 : value - 1;
  }
  return value;
}

/** The request body for one operation's slider value. */
export function paramsForValue(operation, value) {
  if (operation === "brightness" || operation === "threshold") return { value: Math.round(Number(value)) };
  if (operation === "meanfilter") return { window: Math.round(Number(value)) };
  return null;
}

export function createOperationsPanel(ctx) {
  const { session, bus, state } = ctx;
  const preview = ctx.preview ?? defaultPreview;
  const history = ctx.history ?? null;

  const inputs = {
    brightness: numberInput({ value: SLIDER_SPECS.brightness.value, min: -255, max: 255, step: 1 }),
    threshold: numberInput({ value: SLIDER_SPECS.threshold.value, min: 0, max: 255, step: 1 }),
    meanfilter: numberInput({ value: SLIDER_SPECS.meanfilter.value, min: 3, max: 31, step: 2 }),
  };

  const buttons = [];
  const controls = {};
  const status = el("p", { class: "status-line", hidden: true });

  function readNumber(input, low, high, name) {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < low || value > high) {
      toast(`The ${name} value must be between ${low} and ${high}.`, "warn");
      return null;
    }
    return Math.round(value);
  }

  function readOddWindow() {
    let value = Number(inputs.meanfilter.value);
    if (!Number.isFinite(value) || value < 3 || value > 31) {
      toast("The mean-filter window must be between 3 and 31.", "warn");
      return null;
    }
    value = Math.round(value);
    if (value % 2 === 0) {
      value += 1;
      inputs.meanfilter.value = String(value);
      toast(`The window must be odd — using ${value}.`, "warn");
    }
    return value;
  }

  /**
   * The single source of parameters per operation. The panel, the Processing
   * menu and the chat commands all resolve through this table.
   */
  const PARAM_FACTORIES = {
    brightness: () => ({ value: readNumber(inputs.brightness, -255, 255, "brightness") }),
    threshold: () => ({ value: readNumber(inputs.threshold, 0, 255, "threshold") }),
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

  // ------------------------------------------------------- live adjustments
  /**
   * One slider adjustment at a time. `baseId` is the image the adjustment is
   * measured against — the image as it was before the first touch — so
   * re-releasing the same slider re-runs the operation on that same input and
   * this adjustment's previous history step is replaced instead of stacked.
   */
  let adjustment = null; // { operation, baseId, committedId }
  const committedValue = {
    brightness: SLIDER_SPECS.brightness.value,
    threshold: SLIDER_SPECS.threshold.value,
    meanfilter: SLIDER_SPECS.meanfilter.value,
  };
  let committing = null;
  let previewToken = 0;
  let previewFrame = null;
  let pendingPreview = null;

  function clearPreview() {
    previewToken += 1;
    if (previewFrame != null) {
      const cancel = globalThis.cancelAnimationFrame ?? globalThis.clearTimeout;
      cancel?.(previewFrame);
      previewFrame = null;
      pendingPreview = null;
    }
    bus.emit("preview:clear");
  }

  /**
   * Draw a preview of `params` over the adjustment's base image. The first
   * call downloads that PNG once (session.imageBlob caches the Blob); nothing
   * is sent to the server and no history entry is created.
   */
  function schedulePreview(operation, params) {
    pendingPreview = { operation, params };
    if (previewFrame != null) return;
    const requestFrame = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(() => fn(0), 16));
    const token = previewToken;
    previewFrame = requestFrame(async () => {
      previewFrame = null;
      const job = pendingPreview;
      pendingPreview = null;
      if (!job || token !== previewToken) return;
      const baseId = adjustment?.baseId ?? activeImage(state)?.id;
      if (!baseId) return;
      try {
        const blob = await session.imageBlob(baseId);
        if (token !== previewToken) return;
        const canvas = await preview.render(blob, job.operation, job.params);
        if (token !== previewToken || !canvas) return;
        bus.emit("preview:show", { canvas, operation: job.operation, params: job.params });
      } catch {
        // a preview that cannot be drawn simply does not appear; the release
        // still commits the real operation
      }
    });
  }

  /** End the adjustment: sliders go back to their defaults for the new image. */
  function endAdjustment({ reset = true, clear = true } = {}) {
    const owned = adjustment;
    adjustment = null;
    if (clear) clearPreview();
    if (owned && reset) {
      committedValue[owned.operation] = SLIDER_SPECS[owned.operation].value;
      controls[owned.operation]?.setValue(SLIDER_SPECS[owned.operation].value);
    }
  }

  function ensureAdjustment(operation) {
    if (adjustment?.operation === operation) return adjustment;
    endAdjustment(); // another slider was active — only one at a time
    adjustment = { operation, baseId: activeImage(state)?.id ?? null, committedId: null };
    return adjustment;
  }

  function dropHistoryEntry(imageId) {
    if (!history || !imageId) return false;
    const dropped = history.dropEntry(imageId);
    if (dropped) bus.emit("history:changed");
    return dropped;
  }

  /** One request per release — or per Enter/blur, or per key pause. */
  async function commit(operation, value) {
    const spec = SLIDER_SPECS[operation];
    const control = controls[operation];
    const snapped = snapSliderValue(operation, value);
    if (snapped == null) {
      control?.setValue(committedValue[operation]);
      return { ok: false, reason: "invalid-params" };
    }
    control?.setValue(snapped);
    if (snapped === committedValue[operation]) {
      // released at the starting value: no request, no history entry
      clearPreview();
      return { ok: false, reason: "unchanged" };
    }
    if (committing) await committing.catch(() => {}); // let the previous one land

    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      clearPreview();
      return { ok: false, reason: "no-image" };
    }

    const owned = adjustment?.operation === operation && adjustment.baseId;
    const targetId = owned ? adjustment.baseId : active.id;
    if (!owned) {
      if (adjustment) endAdjustment(); // a different slider owned the adjustment
      adjustment = { operation, baseId: targetId, committedId: null };
    }

    const params = paramsForValue(operation, snapped);
    const label = describeOperation(operation, params);
    setBusy(true, label);
    const task = (async () => {
      const info = await session.withImage(targetId, (sid, imageId) =>
        ctx.api.runOperation(sid, imageId, operation, params),
      );
      // REPLACE this slider's previous step instead of stacking another one
      const previous = adjustment?.committedId;
      if (previous && previous !== info.image_id) dropHistoryEntry(previous);
      adjustment = { operation, baseId: targetId, committedId: info.image_id };
      committedValue[operation] = snapped;
      state.lastOperation = { operation: label, imageId: info.image_id, at: Date.now() };
      session.useAsResult(info); // records exactly one history step
      applyFeedback(label, info);
      return { ok: true, info, label };
    })();
    committing = task;
    try {
      return await task;
    } catch (error) {
      report(error, operation, label);
      // the image did not change: put the slider back where the image is
      adjustment = null;
      committedValue[operation] = spec.value;
      control?.setValue(spec.value);
      clearPreview();
      return { ok: false, reason: "failed", error };
    } finally {
      committing = null;
      setBusy(false);
    }
  }

  // -------------------------------------------------------- slider controls
  function createSlider(operation) {
    const spec = SLIDER_SPECS[operation];
    const sliderId = `filter-${operation}-slider`;
    const range = el("input", {
      type: "range",
      class: "slider",
      id: sliderId,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.value,
    });
    const number = inputs[operation];
    number.classList.add("slider-number");
    number.setAttribute("aria-label", `${spec.label} value`);
    const label = el("label", { class: "slider-label", for: sliderId, text: spec.label });
    const choice = spec.choice ? el("span", { class: "slider-choice", text: spec.choice(spec.value) }) : null;
    const node = el("div", { class: "slider-row", dataset: { slider: operation } }, [label, range, number, choice]);

    let keyboard = false;
    let timer = null;
    const stopTimer = () => {
      if (timer == null) return;
      clearTimeout(timer);
      timer = null;
    };

    function setValue(value) {
      const text = String(value);
      range.value = text;
      number.value = text;
      if (choice) choice.textContent = spec.choice(value);
    }

    /** What the number field says, clamped/snapped, with a warning if needed. */
    function readNumberField() {
      const raw = Number(number.value);
      if (!Number.isFinite(raw)) return committedValue[operation];
      const snapped = snapSliderValue(operation, raw);
      if (raw < spec.min || raw > spec.max) {
        toast(`The ${spec.label.toLowerCase()} must be between ${spec.min} and ${spec.max}.`, "warn");
      } else if (snapped !== Math.round(raw)) {
        toast(`The ${spec.label.toLowerCase()} must be odd — using ${snapped}.`, "warn");
      }
      return snapped;
    }

    function cancelGesture() {
      stopTimer();
      setValue(committedValue[operation]);
      clearPreview();
    }

    range.addEventListener("pointerdown", () => {
      keyboard = false;
      stopTimer();
    });
    range.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        cancelGesture();
        event.preventDefault();
        return;
      }
      keyboard = true;
    });
    range.addEventListener("input", () => {
      const value = Number(range.value);
      setValue(value);
      ensureAdjustment(operation);
      schedulePreview(operation, paramsForValue(operation, value));
      if (keyboard) {
        // arrow keys: preview while pressed, commit once the key pauses
        stopTimer();
        timer = setTimeout(() => {
          timer = null;
          commit(operation, value);
        }, KEY_COMMIT_DELAY);
      }
    });
    range.addEventListener("change", () => {
      // pointer release (or the end of a keyboard step): commit exactly once
      keyboard = false;
      stopTimer();
      commit(operation, Number(range.value));
    });
    number.addEventListener("input", () => {
      // mirror the typed value on the slider; the commit waits for Enter/blur
      const raw = Number(number.value);
      if (!Number.isFinite(raw)) return;
      const clamped = Math.min(Math.max(raw, spec.min), spec.max);
      range.value = String(clamped);
      if (choice) choice.textContent = spec.choice(snapSliderValue(operation, raw) ?? spec.value);
    });
    number.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit(operation, readNumberField());
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelGesture();
      }
    });
    number.addEventListener("blur", () => commit(operation, readNumberField()));

    const control = {
      operation,
      node,
      range,
      number,
      choice,
      spec,
      value: () => Number(range.value),
      setValue,
    };
    controls[operation] = control;
    return control;
  }

  // ------------------------------------------------------------- dispatchers
  /**
   * Dispatch one operation. `paramsOverride` lets a caller supply the values
   * explicitly (the chat router does); otherwise they come from the panel.
   * Anything that is not a slider release ends the live adjustment first.
   */
  async function run(operation, paramsOverride = null, { slider = false } = {}) {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return { ok: false, reason: "no-image" };
    }

    let params = null;
    if (OPERATIONS_WITH_PARAMS.includes(operation)) {
      // read the panel first: a menu entry must send the value on screen
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

    // any action that is not a slider release ends the live adjustment
    if (!slider) endAdjustment();
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

  /** Visible feedback: the result viewport updates (via useAsResult) plus a
   *  labelled toast and a persistent status-bar entry. */
  function applyFeedback(label, info) {
    toast(`${label} applied → ${info.width}×${info.height}`, "ok");
    bus.emit("status", { message: `${label} applied — new image ${info.image_id}` });
    bus.emit("operation:applied", { label, info });
  }

  function setBusy(busy, operation = "") {
    state.busy = busy;
    for (const node of buttons) node.disabled = busy || !activeImage(state);
    for (const control of Object.values(controls)) {
      control.range.disabled = busy;
      control.number.disabled = busy;
    }
    const text = busy
      ? `Running ${operation}…`
      : activeImage(state)
        ? ""
        : "Load an image to enable the filters.";
    status.textContent = text;
    status.hidden = !text;
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
    endAdjustment();
    state.result = null;
    bus.emit("image:cleared", { role: "result" });
    bus.emit("status", { message: "Result cleared — operations now apply to the working image" });
  }

  /** Bring an operation's controls into view (used by the Processing menu). */
  function revealParams(operation) {
    const control = controls[operation];
    if (!control) return;
    control.node.classList.add("flash");
    setTimeout(() => control.node.classList.remove("flash"), 1400);
    control.range.focus();
    control.range.select?.();
  }

  // ------------------------------------------------------------------- DOM
  function makeButton(label, operation, extra = "") {
    const node = button(label, () => run(operation), { size: "small", title: extra });
    buttons.push(node);
    return node;
  }

  /** An action button with its own "?" popover (point operations). */
  function helpCell(node, helpKey, title) {
    return el("div", { class: "op-cell" }, [
      node,
      helpPopover(HELP_TEXTS[helpKey], { label: `About ${title}` }).node,
    ]);
  }

  const grayscale = makeButton("Grayscale", "grayscale");
  const negative = makeButton("Negative", "negative");
  const laplacian = makeButton("Laplacian", "laplacian");
  const clearButton = button("Clear result", () => clearResult(), { size: "small", variant: "ghost" });

  function sliderGroup(key, title) {
    const control = createSlider(key);
    return toolGroup(title, [control.node], {
      actions: [helpPopover(HELP_TEXTS[key], { label: `About ${title}` }).node],
    });
  }

  const section = createSection({
    id: "filters",
    title: "Filters",
    iconName: "filters",
    actions: [helpPopover(HELP_TEXTS.filters, { label: "About the Filters panel" }).node],
    body: [
      toolGroup("Point operations", [
        el("div", { class: "btn-grid" }, [
          helpCell(grayscale, "grayscale", "Grayscale"),
          helpCell(negative, "negative", "Negative"),
          helpCell(laplacian, "laplacian", "Laplacian"),
          helpCell(clearButton, "clear", "Clear result"),
        ]),
      ]),
      sliderGroup("brightness", "Brightness"),
      sliderGroup("threshold", "Threshold"),
      sliderGroup("meanfilter", "Mean filter"),
      status,
    ],
  });

  // ------------------------------------------------------------- bus wiring
  bus.on("image:loaded", ({ info }) => {
    // our own commit belongs to the adjustment: it must not end it
    if (info?.image_id && adjustment?.committedId === info.image_id) return;
    endAdjustment();
  });
  bus.on("image:cleared", () => endAdjustment());
  bus.on("session:reset", () => endAdjustment());
  bus.on("operation:applied", ({ info }) => {
    if (info?.image_id && adjustment?.committedId === info.image_id) return;
    endAdjustment();
  });

  setBusy(false);

  return {
    id: "filters",
    label: "Filters",
    section,
    actions: {
      run,
      clearResult,
      paramsFor,
      describeOperation,
      revealParams,
      endAdjustment,
      adjustment: () => (adjustment ? { ...adjustment } : null),
      committed: () => ({ ...committedValue }),
      controls: () => controls,
      help: (key) => HELP_TEXTS[key] ?? null,
    },
  };
}
