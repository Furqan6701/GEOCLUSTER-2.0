/**
 * Clusters section: K-Means and the classify (recolor + legend) step.
 *
 * K-Means mirrors the desktop: k clusters over the grayscale intensities, with
 * the algorithm returning ranges, counts and per-cluster assignments. After a
 * run there is exactly ONE table — the classification editor — where the user
 * renames clusters, picks colours, moves the min/max boundaries and sees what
 * share of the image each range covers, then presses Classify.
 *
 * The editor is the single source of truth for the legend the Map composer
 * uses (see `legendEntries()` and the "clusters:changed" bus event), so the
 * table and the map's legend cannot drift apart.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { formatPercentage } from "../map.js";
import { button, createSection, downloadBlob, el, numberInput, setChildren, toast, toolGroup } from "../ui.js";

/**
 * K-Means always runs with this many Lloyd iterations. The field was removed
 * from the panel (the algorithm converges long before the cap on real images,
 * and api/schemas.py allows up to 200), so the number is fixed here instead of
 * being another value to get wrong.
 */
export const KMEANS_MAX_ITER = 100;
/** Cluster count the panel accepts (api/schemas.py allows 2..20). */
export const KMEANS_MIN_K = 2;
export const KMEANS_MAX_K = 10;

/** Percentage of the classified pixels that a count represents. */
export function sharePercentage(count, total) {
  const value = Number(count);
  const sum = Number(total);
  if (!Number.isFinite(value) || !Number.isFinite(sum) || sum <= 0) return 0;
  return (value / sum) * 100;
}

export function createClustersPanel(ctx) {
  const { session, bus, state } = ctx;

  const kInput = numberInput({ value: 5, min: KMEANS_MIN_K, max: KMEANS_MAX_K, step: 1 });
  const runButton = button("Run K-Means", runKMeans, { variant: "primary", size: "small" });
  runButton.classList.add("block"); // full width on its own row
  ctx.gate.register(runButton, { requiresImage: true, label: "Run K-Means" });
  const runStatus = el("span", { class: "muted", text: "" });
  const editorHost = el("div", {}, el("p", { class: "empty-note", text: "Run K-Means to fill the table." }));

  let editorRows = [];

  // --------------------------------------------------------------- K-Means
  async function runKMeans() {
    const active = activeImage(state);
    if (!active) return toast("Load or fetch an image first.", "warn");
    const k = Math.round(Number(kInput.value));
    if (!Number.isFinite(k) || k < KMEANS_MIN_K || k > KMEANS_MAX_K) {
      return toast(`K must be between ${KMEANS_MIN_K} and ${KMEANS_MAX_K}.`, "warn");
    }

    setBusy(true);
    try {
      // max_iter is not a user-facing value any more: it is always sent, so
      // the request can never fall back to the schema default
      const result = await session.withImage(active.id, (sid, imageId) =>
        ctx.api.kmeans(sid, imageId, { k, maxIter: KMEANS_MAX_ITER }),
      );
      state.kmeans = { ...result, sourceImageId: active.id, sourceInfo: active.info };
      renderEditor(result);
      // K-Means always shows the clustered (recoloured) image; the raw label
      // map stays available as a download in the Files panel.
      showClusteredImage();
      toast(`K-Means finished in ${result.iterations} iteration(s)${result.converged ? " (converged)" : ""}.`, "ok");
      bus.emit("status", { message: `K-Means k=${result.k} · ${result.iterations} iterations${result.converged ? " · converged" : ""}` });
    } catch (error) {
      report(error, "K-Means failed");
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------- result display
  /**
   * Display the K-Means clustered image. There is no image/label toggle any
   * more: the recoloured image is the result, and the raw label map can be
   * downloaded from the Files panel (`downloadLabelMap`).
   */
  function showClusteredImage() {
    const result = state.kmeans;
    const imageId = result?.display_image_id;
    if (!imageId) return null;
    const base = result.sourceInfo ?? activeImage(state)?.info ?? {};
    session.useAsResultId(imageId, { ...base, source: "K-Means clustered image" });
    return imageId;
  }

  /**
   * Raw label map (one grey value per cluster) as a PNG download. The API
   * already stores it as the K-Means `labels_image_id`, so this asks the
   * session for that image and saves it — no second request is invented.
   */
  async function downloadLabelMap() {
    const labelId = state.kmeans?.labels_image_id;
    if (!labelId) return toast("Run K-Means first — the label map comes from its response.", "warn");
    try {
      const blob = await session.imageBlob(labelId);
      const sourceName = String(state.kmeans.sourceInfo?.name ?? "image").replace(/\.[^.]+$/, "");
      downloadBlob(blob, `labels-${sourceName}.png`);
      toast("Label map downloaded — one grey value per cluster.", "ok");
      return { ok: true, blob };
    } catch (error) {
      report(error, "Could not download the label map");
      return { ok: false, error };
    }
  }

  // -------------------------------------------------------- editor table
  function renderEditor(result) {
    const ranges = result.ranges ?? [];
    const assignments = result.assignments ?? {};
    const total = (result.counts ?? ranges.map((range) => range.count))
      .reduce((sum, value) => sum + Number(value || 0), 0);
    editorRows = ranges.map((range) => {
      const assignment = assignments[String(range.cluster)] ?? { name: `Cluster ${range.cluster}`, color: [128, 128, 128] };
      const minInput = numberInput({ value: range.min, min: 0, max: 255 });
      const maxInput = numberInput({ value: range.max, min: 0, max: 255 });
      const nameInput = el("input", { type: "text", value: String(assignment.name), class: "cluster-name" });
      const colorInput = el("input", { type: "color", value: rgbToHex(assignment.color), class: "cluster-color" });
      minInput.classList.add("cluster-bound");
      maxInput.classList.add("cluster-bound");
      const count = Number(range.count ?? 0);
      const share = el("span", { class: "cluster-share", text: formatPercentage(sharePercentage(count, total)) });
      const row = { cluster: range.cluster, minInput, maxInput, nameInput, colorInput, count, share, total };
      // renaming or recolouring feeds the Map composer's legend live
      nameInput.addEventListener("input", () => bus.emit("clusters:changed", { rows: legendEntries() }));
      colorInput.addEventListener("input", () => bus.emit("clusters:changed", { rows: legendEntries() }));
      return row;
    });

    setChildren(editorHost, [
      el("div", { class: "table-wrap" }, el("table", { class: "grid cluster-table" }, [
        el("thead", {}, el("tr", {}, [
          el("th", { text: "Color" }),
          el("th", { text: "Land cover" }),
          el("th", { class: "num", text: "Min" }),
          el("th", { class: "num", text: "Max" }),
          el("th", { class: "num", text: "% of pixels" }),
        ])),
        el("tbody", {}, editorRows.map((row) => el("tr", { dataset: { cluster: String(row.cluster) } }, [
          el("td", { class: "cluster-color-cell" }, row.colorInput),
          el("td", {}, row.nameInput),
          el("td", { class: "num" }, row.minInput),
          el("td", { class: "num" }, row.maxInput),
          el("td", { class: "num" }, row.share),
        ]))),
      ])),
      el("div", { class: "cluster-actions" }, [
        button("Classify", classify, { variant: "primary", size: "small" }),
        button("Reset ranges", resetRanges, { size: "small", variant: "ghost" }),
      ]),
    ]);
    bus.emit("clusters:changed", { rows: legendEntries() });
  }

  /**
   * The Map composer's legend editor changed a name or colour: write it back
   * into the table so the two editors cannot drift apart. Silence is fine —
   * the composer already rendered the change.
   */
  function setLegendRows(rows) {
    if (!Array.isArray(rows) || !editorRows.length) return false;
    let changed = false;
    for (const incoming of rows) {
      const row = editorRows.find((candidate) => candidate.cluster === incoming.cluster);
      if (!row) continue;
      const name = String(incoming.name ?? "");
      const hex = rgbToHex(incoming.color);
      if (name && row.nameInput.value !== name) {
        row.nameInput.value = name;
        changed = true;
      }
      if (hex && row.colorInput.value !== hex) {
        row.colorInput.value = hex;
        changed = true;
      }
    }
    if (changed) bus.emit("clusters:changed", { rows: legendEntries() });
    return changed;
  }

  /** Put every min/max back to the values the algorithm returned. */
  function resetRanges() {
    if (!state.kmeans) return;
    renderEditor(state.kmeans);
    toast("Ranges reset to the K-Means values.", "ok");
  }

  /** The editor as legend rows: what Classify will send and the map will draw. */
  function legendEntries() {
    return editorRows.map((row) => ({
      cluster: row.cluster,
      name: row.nameInput.value.trim() || `Cluster ${row.cluster}`,
      color: hexToRgb(row.colorInput.value),
      min: Math.round(Number(row.minInput.value)),
      max: Math.round(Number(row.maxInput.value)),
      count: row.count,
      percentage: Number(formatPercentage(sharePercentage(row.count, row.total)).replace("%", "")) || 0,
    }));
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
      assignments[row.cluster] = {
        name: row.nameInput.value.trim() || `Cluster ${row.cluster}`,
        color: hexToRgb(row.colorInput.value),
      };
    }

    setBusy(true);
    try {
      const result = await session.withImage(active.id, (sid, imageId) =>
        ctx.api.classify(sid, imageId, { ranges, assignments }),
      );
      session.useAsResultId(result.image_id, { ...(active.info ?? {}), source: "classify" });
      // the Map composer is built from this response: classified image + legend
      state.legend = result.legend ?? [];
      bus.emit("clusters:changed", { rows: legendEntries(), legend: state.legend });
      bus.emit("map:updated", {
        legend: state.legend,
        imageId: result.image_id,
        name: active.info?.name ?? result.image_id,
      });
      toast("Classification applied.", "ok");
      bus.emit("status", { message: `Classified ${Object.keys(ranges).length} clusters` });
    } catch (error) {
      report(error, "Classification failed");
    } finally {
      setBusy(false);
    }
  }

  /** The gate owns the disabled state; this only swaps the label. */
  function setBusy(busy) {
    ctx.gate.setBusy(busy, "kmeans");
    runButton.textContent = busy ? "Working…" : "Run K-Means";
    runStatus.textContent = busy ? "clustering…" : "";
  }

  function report(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  // the Files panel's "Download raw label map" button asks for it here, where
  // the K-Means response (and therefore the label image id) lives
  bus.on("labelmap:request", () => downloadLabelMap());

  bus.on("image:loaded", ({ role }) => {
    if (role === "original") {
      state.kmeans = null;
      editorRows = [];
      setChildren(editorHost, el("p", { class: "empty-note", text: "Run K-Means to fill the table." }));
      bus.emit("clusters:changed", { rows: [] });
    }
  });

  const section = createSection({
    id: "clusters",
    title: "Clusters",
    iconName: "layers",
    collapsed: true,
    body: [
      toolGroup("K-Means", [
        el("div", { class: "field", style: { marginBottom: "6px" } }, [
          el("label", { text: "Clusters (K)" }),
          kInput,
        ]),
        runButton,
        runStatus,
      ]),
      toolGroup("Classification editor", [editorHost]),
    ],
  });

  return {
    id: "clusters",
    label: "Clusters",
    section,
    actions: {
      runKMeans,
      classify,
      resetRanges,
      legendEntries,
      setLegendRows,
      showClusteredImage,
      downloadLabelMap,
    },
  };
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
