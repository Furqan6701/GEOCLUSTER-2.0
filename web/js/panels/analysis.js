/**
 * Analysis section: the Histogram button and the distance tool.
 *
 * The panel itself holds no chart: "Histogram" opens a floating, non-modal
 * window (js/histowindow.js) that owns the chart, its options and its export.
 * Windows are independent, draggable, keyboard accessible and tile side by
 * side, up to four at once; each one remembers which image it shows and every
 * option is recomputed in the browser from the API's 256 bins, so changing an
 * option never causes another request.
 *
 * The distance tool measures image pixels in the viewer (two clicks; Esc
 * clears). The controls here are the unit and the ground length of one pixel
 * (js/measure.js), prefilled from `meters_per_pixel` for satellite imagery and
 * defaulting to pixels otherwise. The latest measurement is one line —
 * "Distance: 450.20 px" — plus a Clear button, and the original-resolution
 * pixel count is mentioned only when the upload was downscaled.
 */

import {
  UNITS, UNIT_ORDER, defaultMeasureSettings, describeDistance, isGroundUnit, pixelSizeFor, toMeters,
} from "../measure.js";
import { activeImage } from "../state.js";
import { button, createSection, el, icon, toast, toolGroup } from "../ui.js";

export function createAnalysisPanel(ctx) {
  const { bus, state } = ctx;

  const histogramButton = button("Histogram", openHistogram, {
    variant: "primary", size: "small", title: "Open a floating histogram window (up to four at once)",
  });
  histogramButton.prepend(icon("chart", { size: 12 }));

  /** Open one more window for the working image. */
  function openHistogram() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return null;
    }
    return ctx.histograms ? ctx.histograms.open({ targetId: active.id }) : null;
  }

  // ------------------------------------------------------------- distance
  // Unit + the ground length of one pixel; the latest measurement in ONE line.
  const unitSelect = el("select", {
    class: "select", id: "measure-unit", title: "Unit for the measured distance",
  }, UNIT_ORDER.map((id) => el("option", { value: id, text: UNITS[id].label })));
  const pixelSizeInput = el("input", {
    type: "number", class: "input", min: "0", step: "any", id: "measure-pixel-size",
    placeholder: "—", title: "Ground length of one image pixel, in the chosen unit",
  });
  pixelSizeInput.style.maxWidth = "104px";
  const pixelSizeUnit = el("span", { class: "note", text: "" });
  const pixelSizeWrap = el("label", { class: "row center", style: { gap: "4px" } }, [
    el("span", { class: "note", text: "Pixel size" }), pixelSizeInput, pixelSizeUnit,
  ]);
  const resultLine = el("p", { class: "measure-line", role: "status", "aria-live": "polite", text: "" });
  const clearButton = button("Clear", clearMeasurement, { size: "small", variant: "ghost" });

  /**
   * Prefill both controls from the image itself: satellite imagery (anything
   * carrying `meters_per_pixel`) starts in metres — kilometres for a coarse
   * mosaic — with its own pixel size; every other image starts in pixels. This
   * runs for each image that arrives, because the pixel size describes THAT
   * image; edits the user makes apply until the next image loads.
   */
  function applyDefaults(info) {
    const defaults = defaultMeasureSettings(info);
    state.measure = { unit: defaults.unit, pixelSize: defaults.pixelSize, satellite: defaults.satellite };
    unitSelect.value = defaults.unit;
    pixelSizeInput.value = Number.isFinite(Number(defaults.pixelSize)) ? String(defaults.pixelSize) : "";
    syncPixelSizeVisibility();
    return defaults;
  }

  applyDefaults(activeImage(state)?.info ?? null);

  function syncPixelSizeVisibility() {
    const unit = unitSelect.value;
    pixelSizeWrap.hidden = !isGroundUnit(unit);
    pixelSizeUnit.textContent = isGroundUnit(unit) ? `${UNITS[unit].suffix}/pixel` : "";
    // remembered so a unit change can convert the number instead of re-reading it
    pixelSizeUnit.dataset.unit = unit;
  }

  function readMeasureSettings() {
    const unit = unitSelect.value;
    const size = Number(pixelSizeInput.value);
    state.measure = {
      unit,
      pixelSize: isGroundUnit(unit) && Number.isFinite(size) && size > 0 ? size : null,
      satellite: state.measure?.satellite === true,
    };
    return state.measure;
  }

  /** The info of whichever viewport the measurement came from. */
  function infoFor(role) {
    if (role === "original") return state.original?.info ?? null;
    if (role === "result") return state.result?.info ?? null;
    return activeImage(state)?.info ?? null;
  }

  function describeMeasurement({ pixels, role }) {
    const info = infoFor(role);
    return describeDistance({
      pixels,
      unit: unitSelect.value,
      pixelSize: state.measure?.pixelSize ?? null,
      scale: Number(info?.scale) > 0 ? Number(info.scale) : 1,
      info,
    });
  }

  /** ONE line, e.g. "Distance: 450.20 px"; the panel has no other text. */
  function renderMeasurement({ pixels, role }, description) {
    if (description?.ok === false && description.reason === "no-distance") {
      resultLine.textContent = "";
      return;
    }
    resultLine.textContent = description.line;
    resultLine.dataset.role = role ?? "";
    bus.emit("status", { message: description.line });
  }

  function clearMeasurement() {
    lastMeasurement = null;
    resultLine.textContent = "";
    bus.emit("distance:clear", {});
  }

  for (const node of [unitSelect, pixelSizeInput]) {
    node.addEventListener("change", () => {
      const unit = unitSelect.value;
      const ground = isGroundUnit(unit);
      const previous = pixelSizeUnit.dataset.unit ?? "";
      if (node === unitSelect) {
        // switching the unit must not change the GROUND size one pixel spans:
        // convert the number, or take the image's own scale when there is one
        const metres = previous && isGroundUnit(previous)
          ? toMeters(Number(pixelSizeInput.value), previous)
          : null;
        const known = metres != null && ground
          ? metres / UNITS[unit].meters
          : pixelSizeFor(infoFor(lastMeasurement?.role), unit);
        if (ground && known != null) pixelSizeInput.value = String(Number(known.toPrecision(6)));
      }
      syncPixelSizeVisibility();
      readMeasureSettings();
      if (lastMeasurement) renderMeasurement(lastMeasurement, describeMeasurement(lastMeasurement));
    });
  }
  pixelSizeUnit.dataset.unit = unitSelect.value;

  let lastMeasurement = null;
  bus.on("viewer:distance", ({ distance, role }) => {
    if (!Number.isFinite(Number(distance))) return;
    lastMeasurement = { pixels: Number(distance), role };
    renderMeasurement(lastMeasurement, describeMeasurement(lastMeasurement));
  });

  // the viewer's own Esc, or another window's Clear, empties the line too
  bus.on("viewer:distance-cleared", () => {
    lastMeasurement = null;
    resultLine.textContent = "";
  });

  // A fresh image brings its own ground scale: prefill both controls again.
  bus.on("image:loaded", ({ info }) => {
    applyDefaults(info ?? null);
  });

  // The chat command "histogram" asks for a window (the app switches to this
  // section when it sees the same event).
  bus.on("histogram:request", () => {
    openHistogram();
  });

  const section = createSection({
    id: "analysis",
    title: "Analysis",
    iconName: "chart",
    collapsed: true,
    body: [
      toolGroup("Histogram", [histogramButton]),
      toolGroup("Distance", [
        el("div", { class: "row center wrap", style: { gap: "6px" } }, [unitSelect, pixelSizeWrap]),
        el("div", { class: "row center wrap", style: { marginTop: "6px", gap: "6px" } }, [clearButton]),
        resultLine,
      ]),
    ],
  });

  return {
    id: "analysis",
    label: "Analysis",
    section,
    actions: { openHistogram, describeMeasurement },
  };
}
