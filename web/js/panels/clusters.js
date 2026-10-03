/**
 * Clusters panel: K-Means and the classify (recolor + legend) step.
 *
 * K-Means mirrors the desktop: k clusters over the grayscale intensities,
 * with the algorithm returning ranges, centroids and per-cluster counts.
 * After a run the ranges/assignments from the API pre-fill the classify
 * editor, so users can rename clusters, pick colours and move the min/max
 * boundaries, then re-classify without re-running the algorithm.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, el, labelled, numberInput, setChildren, swatch, table, toast } from "../ui.js";

export function createClustersPanel(ctx) {
  const { session, bus, state } = ctx;

  const kInput = numberInput({ value: 5, min: 2, max: 20, step: 1 });
  const iterInput = numberInput({ value: 30, min: 1, max: 200, step: 1 });
  const runButton = button("Run K-Means", runKMeans, { variant: "primary", size: "small" });
  const summaryHost = el("div", { class: "card" }, el("p", { class: "muted", text: "No clustering yet." }));
  const editorHost = el("div", { class: "card" }, el("p", { class: "muted", text: "Run K-Means to edit cluster ranges and colours." }));
  const legendHost = el("div", { class: "card" }, el("p", { class: "muted", text: "The legend appears after classification." }));

  let editorRows = [];

  async function runKMeans() {
    const active = activeImage(state);
    if (!active) return toast("Load or fetch an image first.", "warn");
    const k = Math.round(Number(kInput.value));
    const maxIter = Math.round(Number(iterInput.value));
    if (!Number.isFinite(k) || k < 2 || k > 20) return toast("K must be between 2 and 20.", "warn");
    if (!Number.isFinite(maxIter) || maxIter < 1 || maxIter > 200) return toast("Max iterations must be between 1 and 200.", "warn");

    setBusy(true);
    try {
      const result = await session.withSession((sid) => ctx.api.kmeans(sid, active.id, { k, maxIter }));
      state.kmeans = { ...result, sourceImageId: active.id, sourceInfo: active.info };
      renderSummary(result);
      renderEditor(result);
      setChildren(legendHost, el("p", { class: "muted", text: "Adjust the table below, then press Classify." }));
      toast(`K-Means finished in ${result.iterations} iteration(s)${result.converged ? " (converged)" : ""}.`, "ok");
    } catch (error) {
      report(error, "K-Means failed");
    } finally {
      setBusy(false);
    }
  }

  function renderSummary(result) {
    const ranges = result.ranges ?? [];
    setChildren(summaryHost, [
      el("h3", { text: "Last run" }),
      el("div", { class: "row tight" }, [
        el("span", { class: "badge", text: `k = ${result.k}` }),
        el("span", { class: `badge ${result.converged ? "ok" : "warn"}`, text: result.converged ? "converged" : "max iterations" }),
        el("span", { class: "badge", text: `${result.iterations} iterations` }),
      ]),
      el("p", { class: "muted", text: `Centroids: ${(result.centroids ?? []).map((value) => Number(value).toFixed(2)).join(", ")}` }),
      table(
        ["Cluster", { text: "Min", num: true }, { text: "Max", num: true }, { text: "Pixels", num: true }],
        ranges.map((range) => [range.cluster, range.min, range.max, range.count]),
      ),
      el("div", { class: "row", style: { marginTop: "8px" } }, [
        button("Show clustered image", () => showImage(result.display_image_id, "kmeans display"), { size: "small" }),
        button("Show label map", () => showImage(result.labels_image_id, "kmeans labels"), { size: "small" }),
      ]),
    ]);
  }

  async function showImage(imageId, label) {
    if (!imageId) return;
    const base = state.kmeans?.sourceInfo ?? activeImage(state)?.info ?? {};
    session.useAsResultId(imageId, { ...base, source: label });
    toast(`Showing ${label} (${imageId}).`, "ok");
  }

  function renderEditor(result) {
    const ranges = result.ranges ?? [];
    const assignments = result.assignments ?? {};
    editorRows = ranges.map((range) => {
      const assignment = assignments[String(range.cluster)] ?? { name: `Cluster ${range.cluster}`, color: [128, 128, 128] };
      const minInput = numberInput({ value: range.min, min: 0, max: 255 });
      const maxInput = numberInput({ value: range.max, min: 0, max: 255 });
      const nameInput = el("input", { type: "text", value: String(assignment.name) });
      const colorInput = el("input", { type: "color", value: rgbToHex(assignment.color) });
      return { cluster: range.cluster, minInput, maxInput, nameInput, colorInput, count: range.count };
    });

    const rows = editorRows.map((row) => [
      row.cluster,
      row.minInput,
      row.maxInput,
      row.nameInput,
      colorInputCell(row.colorInput),
      row.count,
    ]);

    setChildren(editorHost, [
      el("h3", { text: "Classify clusters" }),
      table(["#", { text: "Min", num: true }, { text: "Max", num: true }, "Land cover", "Colour", { text: "Pixels", num: true }], rows),
      el("div", { class: "row", style: { marginTop: "8px" } }, [
        button("Classify", classify, { variant: "primary", size: "small" }),
        button("Reset to algorithm values", () => state.kmeans && renderEditor(state.kmeans), { size: "small", variant: "ghost" }),
      ]),
      el("p", { class: "muted", text: "Ranges are inclusive; pixels outside every range stay black." }),
    ]);
  }

  function colorInputCell(input) {
    const preview = el("span", { class: "swatch-preview" });
    const sync = () => {
      preview.style.background = input.value;
    };
    input.addEventListener("input", sync);
    sync();
    return el("span", { class: "row tight", style: { alignItems: "center", gap: "4px" } }, [input, preview]);
  }

  async function classify() {
    const active = state.kmeans ? { id: state.kmeans.sourceImageId, info: state.kmeans.sourceInfo } : activeImage(state);
    if (!active) return toast("Load or fetch an image first.", "warn");
    if (!editorRows.length) return toast("Run K-Means first so there are ranges to classify.", "warn");

    const ranges = {};
    const assignments = {};
    for (const row of editorRows) {
      const min = Math.round(Number(row.minInput.value));
      const max = Math.round(Number(row.maxInput.value));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 255) {
        return toast(`Cluster ${row.cluster}: stay between 0 and 255.`, "warn");
      }
      if (min > max) return toast(`Cluster ${row.cluster}: min must not exceed max.`, "warn");
      ranges[row.cluster] = [min, max];
      assignments[row.cluster] = { name: row.nameInput.value.trim() || `Cluster ${row.cluster}`, color: hexToRgb(row.colorInput.value) };
    }

    setBusy(true);
    try {
      const result = await session.withSession((sid) => ctx.api.classify(sid, active.id, { ranges, assignments }));
      session.useAsResultId(result.image_id, { ...(active.info ?? {}), source: "classify" });
      renderLegend(result.legend ?? []);
      toast("Classification applied.", "ok");
    } catch (error) {
      report(error, "Classification failed");
    } finally {
      setBusy(false);
    }
  }

  function renderLegend(legend) {
    setChildren(legendHost, [
      el("h3", { text: "Legend" }),
      table(
        ["", "Cluster", { text: "Range", num: true }, { text: "Pixels", num: true }, { text: "%", num: true }],
        legend.map((entry) => [
          swatch(entry.color),
          entry.name,
          `${entry.min}–${entry.max}`,
          entry.count,
          entry.percentage,
        ]),
      ),
      el("p", { class: "muted", text: `Total classified pixels: ${legend.reduce((sum, entry) => sum + entry.count, 0).toLocaleString()}` }),
    ]);
  }

  function setBusy(busy) {
    runButton.disabled = busy;
    runButton.textContent = busy ? "Working…" : "Run K-Means";
  }

  function report(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  bus.on("image:loaded", ({ role }) => {
    if (role === "original") {
      state.kmeans = null;
      setChildren(summaryHost, el("p", { class: "muted", text: "No clustering yet." }));
      setChildren(editorHost, el("p", { class: "muted", text: "Run K-Means to edit cluster ranges and colours." }));
      setChildren(legendHost, el("p", { class: "muted", text: "The legend appears after classification." }));
    }
  });

  const panel = el("div", { class: "panel", id: "panel-clusters", hidden: true }, [
    el("div", { class: "card" }, [
      el("h3", { text: "K-Means" }),
      el("div", { class: "row" }, [
        labelled("Clusters (K)", kInput),
        labelled("Max iterations", iterInput),
      ]),
      runButton,
      el("p", { class: "muted", text: "Clusters the grayscale intensities and returns labels, centroids and ranges." }),
    ]),
    summaryHost,
    editorHost,
    legendHost,
  ]);

  return { id: "clusters", label: "Clusters", node: panel };
}

function rgbToHex(color) {
  const [r, g, b] = (color ?? [0, 0, 0]).map((value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))));
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  const text = String(hex ?? "").replace("#", "");
  if (text.length !== 6) return [0, 0, 0];
  return [0, 2, 4].map((offset) => parseInt(text.slice(offset, offset + 2), 16) || 0);
}
