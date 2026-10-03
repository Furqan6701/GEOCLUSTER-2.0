/**
 * Analysis section: 256-bin histogram, image statistics and the distance tool.
 *
 * The histogram is drawn straight from the API's integer bin counts. Every
 * display option — log scale, smoothing, cumulative, density, light/dark theme
 * — is recomputed in the browser from those same 256 numbers (js/histogram.js),
 * so changing one never causes another request. "Export PNG" paints the same
 * chart, with the same options, on a larger canvas.
 *
 * The distance tool measures image pixels in the viewer; the unit controls here
 * convert that measurement (js/measure.js) and, when the upload was downscaled,
 * also show the distance at the original resolution — labelled, so it is clear
 * which number is which.
 */

import { humanizeError } from "../errors.js";
import { drawHistogram, histogramFileName, SCALES, SMOOTHING_WINDOWS, describeOptions } from "../histogram.js";
import { UNITS, describeDistance, unitRateLabel } from "../measure.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, downloadBlob, el, icon, setChildren, toast, toolGroup } from "../ui.js";

const WIDTH = 520;
const HEIGHT = 170;
const EXPORT_SCALE = 2;

export function createAnalysisPanel(ctx) {
  const { session, bus, state } = ctx;

  const refreshButton = button("Histogram & stats", refresh, { variant: "primary", size: "small" });
  const canvas = el("canvas", { width: WIDTH, height: HEIGHT, class: "histogram-canvas" });
  const statsHost = el("div", {}, el("p", { class: "empty-note", text: "No statistics yet." }));
  const caption = el("p", { class: "note", text: "Load an image, then compute the histogram." });
  const optionsNote = el("p", { class: "note", text: "" });

  // ---------------------------------------------------------- display options
  const scaleSelect = el("select", { class: "select", id: "hist-scale", title: "Linear or logarithmic bar heights" }, [
    ...SCALES.map((value) => el("option", { value, text: value === "log" ? "Log scale" : "Linear scale" })),
  ]);
  const smoothingSelect = el("select", { class: "select", id: "hist-smoothing", title: "Moving-average smoothing over neighbouring bins" }, [
    ...SMOOTHING_WINDOWS.map((value) => el("option", {
      value: String(value),
      text: value === 0 ? "No smoothing" : `Smooth ${value}`,
    })),
  ]);
  const cumulativeToggle = el("input", { type: "checkbox", id: "hist-cumulative" });
  const densityToggle = el("input", { type: "checkbox", id: "hist-density" });
  const themeToggle = el("input", { type: "checkbox", id: "hist-theme" });
  const optionsRow = el("div", { class: "row center wrap", style: { marginTop: "6px" } }, [
    scaleSelect,
    smoothingSelect,
    el("label", { class: "checkbox", for: "hist-cumulative" }, [cumulativeToggle, "Cumulative"]),
    el("label", { class: "checkbox", for: "hist-density" }, [densityToggle, "Density"]),
    el("label", { class: "checkbox", for: "hist-theme" }, [themeToggle, "Light theme"]),
  ]);

  const exportButton = button("Export PNG", exportPng, { size: "small", title: "Save the histogram as it is shown now" });
  exportButton.prepend(icon("download", { size: 12 }));
  const optionsHost = el("div", { class: "row center", style: { marginTop: "6px" } }, [refreshButton, exportButton]);

  let lastBins = null;
  let lastStats = null;

  function options() {
    return {
      scale: scaleSelect.value === "log" ? "log" : "linear",
      smoothing: Number(smoothingSelect.value) || 0,
      cumulative: cumulativeToggle.checked,
      density: densityToggle.checked,
      theme: themeToggle.checked ? "light" : "dark",
    };
  }

  for (const node of [scaleSelect, smoothingSelect, cumulativeToggle, densityToggle, themeToggle]) {
    node.addEventListener("change", () => draw(lastBins));
  }

  async function refresh() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return;
    }
    refreshButton.disabled = true;
    refreshButton.textContent = "Working…";
    try {
      const [histogram, stats] = await session.withSession(async (sid) => {
        const bins = await ctx.api.histogram(sid, active.id);
        const values = await ctx.api.stats(sid, active.id);
        return [bins, values];
      });
      lastBins = histogram.bins ?? [];
      lastStats = stats;
      draw(lastBins);
      setChildren(statsHost, [
        el("div", { class: "stat-strip" }, [
          stat("min", stats.min),
          stat("max", stats.max),
          stat("mean", Number(stats.mean).toFixed(2)),
          stat("std", Number(stats.std).toFixed(2)),
        ]),
      ]);
      const total = lastBins.reduce((sum, value) => sum + value, 0);
      caption.textContent = `256 bins · ${total.toLocaleString()} pixels · image ${active.info?.width ?? "?"}×${active.info?.height ?? "?"}`;
      bus.emit("status", { message: `Histogram ready — mean ${Number(stats.mean).toFixed(2)}, std ${Number(stats.std).toFixed(2)}` });
    } catch (error) {
      report(error, "Analysis failed");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Histogram & stats";
    }
  }

  function stat(label, value) {
    return el("span", { class: "stat" }, [el("span", { text: label }), el("span", { text: String(value) })]);
  }

  /** Title line: the image and the options, so the exported PNG explains itself. */
  function chartTitle() {
    const active = activeImage(state);
    const name = active?.info?.name ?? "image";
    return `Histogram — ${name} · ${describeOptions(options())}`;
  }

  function draw(bins) {
    const context = canvas.getContext("2d");
    const settings = options();
    drawHistogram(context, {
      bins: bins ?? [],
      width: WIDTH,
      height: HEIGHT,
      theme: settings.theme,
      scale: settings.scale,
      smoothing: settings.smoothing,
      cumulative: settings.cumulative,
      density: settings.density,
      title: bins?.length ? chartTitle() : "",
      fontSize: 10,
    });
    if (bins?.length) {
      optionsNote.textContent = `${describeOptions(settings)} · ${settings.theme} canvas · computed in the browser from the 256 API bins`;
    } else {
      optionsNote.textContent = "Options apply to the next histogram.";
    }
  }

  /** Export what is on screen, at 2× so it survives a document or a slide. */
  async function exportPng() {
    if (!lastBins?.length) {
      toast("Compute the histogram first — the PNG is the chart as it is shown.", "warn");
      return { ok: false, reason: "no-histogram" };
    }
    const settings = options();
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = WIDTH * EXPORT_SCALE;
    exportCanvas.height = HEIGHT * EXPORT_SCALE;
    drawHistogram(exportCanvas.getContext("2d"), {
      bins: lastBins,
      width: exportCanvas.width,
      height: exportCanvas.height,
      theme: settings.theme,
      scale: settings.scale,
      smoothing: settings.smoothing,
      cumulative: settings.cumulative,
      density: settings.density,
      title: chartTitle(),
      fontSize: 10 * EXPORT_SCALE,
    });
    const blob = typeof exportCanvas.toBlob === "function"
      ? await new Promise((resolve) => exportCanvas.toBlob(resolve, "image/png"))
      : null;
    if (!blob) {
      toast("This browser could not turn the histogram canvas into a PNG.", "bad");
      return { ok: false, reason: "no-blob" };
    }
    const active = activeImage(state);
    const filename = histogramFileName(active?.info?.name ?? "image");
    downloadBlob(blob, filename);
    toast(`Histogram exported — ${exportCanvas.width}×${exportCanvas.height} PNG (${describeOptions(settings)})`, "ok");
    bus.emit("status", { message: `Histogram exported to ${filename}` });
    return { ok: true, blob, width: exportCanvas.width, height: exportCanvas.height, filename };
  }

  function report(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
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

  // The chat command "histogram" asks the panel to refresh (and the app
  // switches to this section when it sees the same event).
  bus.on("histogram:request", () => {
    refresh();
  });

  bus.on("image:loaded", ({ role }) => {
    if (role === "original") {
      lastBins = null;
      lastStats = null;
      draw(null);
      setChildren(statsHost, el("p", { class: "empty-note", text: "No statistics yet." }));
      caption.textContent = "Load an image, then compute the histogram.";
    }
  });

  draw(null);

  const section = createSection({
    id: "analysis",
    title: "Analysis",
    iconName: "chart",
    collapsed: true,
    body: [
      toolGroup("Histogram", [
        canvas,
        optionsRow,
        optionsHost,
        optionsNote,
        caption,
      ]),
      toolGroup("Statistics", [statsHost]),
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
    actions: { refresh, exportPng, describeMeasurement, lastBins: () => lastBins, options },
  };
}
