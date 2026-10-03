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
 * The distance tool measures image pixels in the viewer; the unit controls here
 * convert that measurement (js/measure.js) and, when the upload was downscaled,
 * also show the distance at the original resolution — labelled, so it is clear
 * which number is which.
 */

import { humanizeError } from "../errors.js";
import { UNITS, describeDistance, unitRateLabel } from "../measure.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, el, icon, setChildren, toast, toolGroup } from "../ui.js";

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
  const measureButton = button("Measure on the active viewport", () => bus.emit("distance:request"), { size: "small" });
  measureButton.prepend(icon("measure", { size: 12 }));

  const unitSelect = el("select", { class: "select", title: "Unit for the measured distance" }, [
    ...Object.values(UNITS).map((unit) => el("option", { value: unit.id, text: unit.label })),
  ]);
  const rateInput = el("input", {
    type: "number",
    class: "input",
    min: "0.0001",
    step: "any",
    placeholder: "—",
    title: "How many image pixels span one unit (your calibration)",
  });
  rateInput.style.maxWidth = "96px";
  const rateLabel = el("span", { class: "note", text: "px/unit" });
  const rateWrap = el("label", { class: "row center", style: { gap: "4px" } }, [rateInput, rateLabel]);
  const measureHost = el("div", {}, el("p", { class: "empty-note", text: "No measurement yet." }));

  state.measure = state.measure ?? { unit: "px", pxPerUnit: null };
  unitSelect.value = state.measure.unit ?? "px";
  if (state.measure.pxPerUnit) rateInput.value = String(state.measure.pxPerUnit);
  syncRateVisibility();

  function syncRateVisibility() {
    const unit = unitSelect.value;
    const needsRate = unit !== "px";
    rateWrap.hidden = !needsRate;
    rateLabel.textContent = unitRateLabel(unit) || "px/unit";
  }

  function readMeasureSettings() {
    const unit = unitSelect.value;
    const rate = Number(rateInput.value);
    state.measure = {
      unit,
      pxPerUnit: unit === "px" ? null : (Number.isFinite(rate) && rate > 0 ? rate : null),
    };
    return state.measure;
  }

  function settingsForRole(role) {
    const info = role === "original"
      ? state.original?.info
      : role === "result"
        ? state.result?.info
        : null;
    return { info, scale: Number(info?.scale) > 0 ? Number(info.scale) : 1 };
  }

  /** One measurement, described with the current settings. */
  function describeMeasurement({ pixels, role }) {
    const { info, scale } = settingsForRole(role);
    return describeDistance({
      pixels,
      unit: unitSelect.value,
      pxPerUnit: unitSelect.value === "px" ? null : Number(rateInput.value) || null,
      scale,
      info,
    });
  }

  function renderMeasurement({ pixels, role }, description) {
    const viewerName = role === "map" ? "Map" : role === "result" ? "Result" : "Original";
    setChildren(measureHost, [
      el("p", { class: "note", text: `Measured on the ${viewerName} viewport` }),
      ...description.lines.map((line, index) =>
        el("p", { class: index === 0 ? "measure-line" : "note", text: line })),
    ]);
  }

  for (const node of [unitSelect, rateInput]) {
    node.addEventListener("change", () => {
      syncRateVisibility();
      const settings = readMeasureSettings();
      if (lastMeasurement) {
        const description = describeMeasurement(lastMeasurement);
        renderMeasurement(lastMeasurement, description);
        bus.emit("status", { message: `Distance units: ${settings.unit === "px" ? "pixels" : description.primary}` });
      }
    });
  }

  let lastMeasurement = null;
  bus.on("viewer:distance", ({ distance, role }) => {
    if (!Number.isFinite(Number(distance))) return;
    lastMeasurement = { pixels: Number(distance), role };
    renderMeasurement(lastMeasurement, describeMeasurement(lastMeasurement));
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
        measureButton,
        el("div", { class: "row center wrap", style: { marginTop: "6px" } }, [unitSelect, rateWrap]),
        measureHost,
        el("p", { class: "note", text: "Two clicks on the active viewport measure the Euclidean pixel distance. Esc clears. Client-side only — the API has no distance endpoint." }),
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
