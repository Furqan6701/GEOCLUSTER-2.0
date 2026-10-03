/**
 * Clusters section: K-Means and the classification editor.
 *
 * K-Means mirrors the desktop: k clusters over the grayscale intensities, with
 * the algorithm returning ranges, counts and per-cluster assignments. After a
 * run there is exactly ONE table — the classification editor.
 *
 * The editor's ranges are ALWAYS contiguous over 0..255 (item 11): the first
 * class starts at 0, the last one ends at 255, both locked and shown read-only,
 * and moving a boundary moves exactly one neighbour, live, on every keystroke —
 * there is no Apply step. All of that maths lives in js/clusterranges.js, a
 * pure, unit-tested module; this file only renders it.
 *
 * Nothing the user types while editing reaches the server and nothing lands in
 * the history: the % column is recomputed from the image's 256-bin histogram
 * (fetched ONCE per image) and the Result viewport is recoloured through a
 * 256-entry lookup table in the browser. Only "Generate map" talks to the API —
 * ONE classify request, ONE undo step — and then opens the map composer.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { formatPercentage } from "../map.js";
import { previewSize } from "../preview.js";
import {
  CHANNEL_MAX,
  CHANNEL_MIN,
  boundaries,
  buildLut,
  clampMaxEdit,
  clampMinEdit,
  colorsOf,
  countsFromBins,
  editMax,
  editMin,
  evenRanges,
  isMaxLocked,
  isMinLocked,
  maxEditBounds,
  moveBoundary,
  normalizeEntries,
  recolorPixels,
} from "../clusterranges.js";
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

/**
 * Land-cover preset names are the curated five-cluster palette; for any other
 * K the panel names the clusters "Class 1" … "Class K" instead of borrowing
 * land-cover words that do not describe the image.
 */
export const PRESET_NAME_K = 5;

export function defaultClassNames(k) {
  const count = Math.max(0, Math.round(Number(k) || 0));
  if (count === PRESET_NAME_K) return null; // use the API's land-cover presets
  return Array.from({ length: count }, (_value, index) => `Class ${index + 1}`);
}

/** The name a cluster starts with, for the given K. */
export function defaultNameFor(k, index, presetName) {
  const names = defaultClassNames(k);
  if (names) return names[index] ?? `Class ${index + 1}`;
  return String(presetName ?? `Class ${index + 1}`);
}

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

  /** The authoritative ranges: `[{cluster, min, max}]`, always contiguous. */
  let entries = [];
  /** One DOM handle set per entry, plus the K-Means counts as a fallback. */
  let rows = [];
  /** Segments / boundary handles of the 0..255 bar. */
  let barSegments = [];
  let barHandles = [];
  /** The image's 256-bin histogram — fetched ONCE, then only computed with. */
  let bins = null;
  let binsFor = null;
  let binsPending = null;
  /** The classified source image, decoded once for the live preview. */
  let sourceCache = { imageId: null, bitmap: null, pending: null };
  let previewToken = 0;

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
      // map stays available as a download in the File menu.
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
   * more: the recoloured image is the result, and the raw label map is
   * downloaded from the File menu (`downloadLabelMap`).
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
  /**
   * (Re)build the editor. `keepEdits` carries the names and colours the user
   * already typed into the next render — used by "Reset ranges", which must
   * only put the min/max values back.
   */
  function renderEditor(result, { keepEdits = false } = {}) {
    // the API always answers with ranges; the even split is only a safety net
    const ranges = result?.ranges?.length ? result.ranges : evenRanges(result?.k ?? 0);
    const assignments = result?.assignments ?? {};
    const previous = new Map(rows.map((row) => [row.cluster, row]));
    const counts = result?.counts ?? ranges.map((range) => range.count);
    const total = (counts ?? []).reduce((sum, value) => sum + Number(value || 0), 0);

    // the model: contiguous, 0..255, one value per class — never a gap
    entries = normalizeEntries(ranges);
    rows = entries.map((entry, index) => {
      const assignment = assignments[String(entry.cluster)] ?? {};
      const carried = keepEdits ? previous.get(entry.cluster) : null;
      const minInput = numberInput({ value: entry.min, min: CHANNEL_MIN, max: CHANNEL_MAX });
      const maxInput = numberInput({ value: entry.max, min: CHANNEL_MIN, max: CHANNEL_MAX });
      const nameInput = el("input", {
        type: "text",
        class: "cluster-name",
        // land-cover presets at K=5, "Class 1"…"Class K" for every other K
        value: String(carried?.nameInput.value ?? defaultNameFor(result?.k, index, assignment.name)),
        "aria-label": `Land cover for cluster ${index + 1}`,
      });
      const colorInput = el("input", {
        type: "color",
        class: "cluster-color",
        value: carried ? carried.colorInput.value : rgbToHex(assignment.color),
        "aria-label": `Colour for cluster ${index + 1}`,
      });
      minInput.classList.add("cluster-bound");
      maxInput.classList.add("cluster-bound");
      minInput.setAttribute("aria-label", `Minimum for cluster ${index + 1}`);
      maxInput.setAttribute("aria-label", `Maximum for cluster ${index + 1}`);
      const share = el("span", { class: "cluster-share", text: "—" });
      const row = {
        cluster: entry.cluster,
        minInput,
        maxInput,
        nameInput,
        colorInput,
        share,
        count: Number(counts?.[index] ?? 0),
        total,
        percentage: sharePercentage(counts?.[index], total),
      };

      minInput.addEventListener("input", () => handleTyped("min", index, minInput));
      maxInput.addEventListener("input", () => handleTyped("max", index, maxInput));
      minInput.addEventListener("blur", () => commitTyped("min", index, minInput));
      maxInput.addEventListener("blur", () => commitTyped("max", index, maxInput));
      for (const [field, kind] of [[minInput, "min"], [maxInput, "max"]]) {
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitTyped(kind, index, field);
          }
        });
      }
      // renaming feeds the Map composer's legend; recolouring also repaints
      nameInput.addEventListener("input", () => emitLegend());
      colorInput.addEventListener("input", () => {
        syncBar();
        showPreview();
        emitLegend();
      });
      return row;
    });

    setChildren(editorHost, [
      // no .table-wrap horizontal scroller: the two-line row layout below fits
      // the default sidebar width (see .cluster-table in styles.css)
      el("table", { class: "grid cluster-table" }, [
        el("thead", {}, el("tr", {}, [
          el("th", { class: "cluster-color-head", text: "Color" }),
          el("th", { text: "Land cover" }),
          el("th", { class: "num", text: "Min" }),
          el("th", { class: "num", text: "Max" }),
          el("th", { class: "num", text: "%", title: "% of pixels", "aria-label": "% of pixels" }),
        ])),
        el("tbody", {}, rows.map((row) => el("tr", { dataset: { cluster: String(row.cluster) } }, [
          el("td", { class: "cluster-color-cell" }, row.colorInput),
          el("td", {}, row.nameInput),
          el("td", { class: "num" }, row.minInput),
          el("td", { class: "num" }, row.maxInput),
          el("td", { class: "num" }, row.share),
        ]))),
      ]),
      buildBar(),
      el("div", { class: "cluster-actions" }, [
        button("Generate map", classify, { variant: "primary", size: "small" }),
        button("Reset ranges", resetRanges, { size: "small", variant: "ghost" }),
      ]),
    ]);

    syncFields();
    updateShares();
    syncBar();
    emitLegend();
    // the % column turns exact as soon as the histogram arrives — ONE request
    // per image, and none at all while the user edits
    ensureBins();
    // a fresh editor starts as "not edited": the Result viewport keeps showing
    // the last committed image until something actually changes
    bus.emit("preview:clear");
  }

  // ------------------------------------------------------- live linked edits
  /**
   * A keystroke in a Min/Max field. The value is applied — and the neighbour
   * follows — only while it is valid; an out-of-range keystroke is simply left
   * in the field so the user can keep typing, and is clamped on Enter/blur.
   */
  function handleTyped(kind, index, input) {
    const edit = kind === "min" ? editMin(entries, index, input.value) : editMax(entries, index, input.value);
    if (!edit.applied) return;
    entries = edit.entries;
    applyEdit(kind, index);
  }

  /** Enter or blur: clamp, always apply, and show the clamped value. */
  function commitTyped(kind, index, input) {
    if (!entries[index]) return;
    const value = kind === "min"
      ? clampMinEdit(entries, index, input.value)
      : clampMaxEdit(entries, index, input.value);
    input.value = String(value);
    if (value === entries[index][kind]) return; // already applied while typing
    const edit = kind === "min"
      ? editMin(entries, index, value, { commit: true })
      : editMax(entries, index, value, { commit: true });
    entries = edit.entries;
    applyEdit(kind, index);
  }

  /** Write the edited model back into the linked fields and the viewport. */
  function applyEdit(kind, index) {
    // exactly one neighbour moves: max(i) → min(i+1), min(i) → max(i−1)
    if (kind === "max" && rows[index + 1]) rows[index + 1].minInput.value = String(entries[index + 1].min);
    if (kind === "min" && rows[index - 1]) rows[index - 1].maxInput.value = String(entries[index - 1].max);
    entries.forEach((entry, position) => {
      const row = rows[position];
      if (!row) return;
      if (isMinLocked(entries, position)) row.minInput.value = String(CHANNEL_MIN);
      if (isMaxLocked(entries, position)) row.maxInput.value = String(CHANNEL_MAX);
    });
    updateShares();
    syncBar();
    showPreview();
    emitLegend();
  }

  /** Put the locked ends into their fields once, at render time. */
  function syncFields() {
    entries.forEach((entry, index) => {
      const row = rows[index];
      if (!row) return;
      row.minInput.readOnly = isMinLocked(entries, index);
      row.maxInput.readOnly = isMaxLocked(entries, index);
      if (row.minInput.readOnly) {
        row.minInput.classList.add("locked");
        row.minInput.title = "0 is fixed: the first class always starts at the darkest value";
      }
      if (row.maxInput.readOnly) {
        row.maxInput.classList.add("locked");
        row.maxInput.title = "255 is fixed: the last class always reaches the brightest value";
      }
    });
  }

  /**
   * The % column. Real bin counts when the histogram is here (they follow the
   * ranges live); the K-Means share as a fallback while it loads.
   */
  function updateShares() {
    const live = bins ? countsFromBins(entries, bins) : null;
    rows.forEach((row) => {
      const percentage = live ? live.percentages[row.cluster] ?? 0 : sharePercentage(row.count, row.total);
      row.percentage = percentage;
      if (live) row.count = live.counts[row.cluster] ?? 0;
      row.share.textContent = formatPercentage(percentage);
    });
  }

  /** The 256-bin histogram of the classified source image: ONCE per image. */
  function ensureBins() {
    const imageId = state.kmeans?.sourceImageId;
    if (!imageId || (binsFor === imageId && bins)) return binsPending;
    if (binsPending && binsFor === imageId) return binsPending;
    binsFor = imageId;
    bins = null;
    binsPending = session.withImage(imageId, (sid, id) => ctx.api.histogram(sid, id))
      .then((response) => {
        const values = response?.bins ?? response;
        if (!Array.isArray(values)) return null;
        bins = values.map((value) => Number(value) || 0);
        updateShares();
        emitLegend();
        return bins;
      })
      .catch((error) => {
        // the K-Means counts stay as the fallback — the editor keeps working
        if (error instanceof SessionExpiredError) report(error, "Histogram failed");
        return null;
      })
      .finally(() => { binsPending = null; });
    return binsPending;
  }

  // ------------------------------------------------------- live preview
  /**
   * Decode the classified source image once, without a request whenever the
   * viewport already holds it (the common case: K-Means ran on the image that
   * is on screen). The blob cache of the session covers the rest.
   */
  async function sourceBitmap() {
    const imageId = state.kmeans?.sourceImageId;
    if (!imageId) return null;
    if (sourceCache.imageId === imageId) return sourceCache.bitmap;
    const viewers = ctx.viewers ?? {};
    for (const [role, viewer] of [["original", viewers.original], ["result", viewers.result]]) {
      if (!viewer?.image) continue;
      if (state[role]?.info?.image_id !== imageId) continue;
      sourceCache = { imageId, bitmap: viewer.image, pending: null };
      return sourceCache.bitmap;
    }
    if (sourceCache.pending) return sourceCache.pending;
    if (typeof createImageBitmap !== "function") return null;
    sourceCache.pending = session.imageBlob(imageId)
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        sourceCache = { imageId, bitmap, pending: null };
        return bitmap;
      })
      .catch(() => {
        sourceCache.pending = null;
        return null;
      });
    return sourceCache.pending;
  }

  /** Recolour the source through the 256-entry LUT and show it as a preview. */
  async function showPreview() {
    const token = ++previewToken;
    const bitmap = await sourceBitmap();
    if (!bitmap || token !== previewToken) return false;
    const canvas = renderRangePreview(bitmap, buildLut(entries, colorMap()));
    if (!canvas || token !== previewToken) return false;
    bus.emit("preview:show", { canvas, operation: "classification" });
    return true;
  }

  /** The colours the editor currently shows, as `{cluster: [r,g,b]}`. */
  function colorMap() {
    return colorsOf(rows.map((row) => ({ cluster: row.cluster, color: hexToRgb(row.colorInput.value) })));
  }

  // ------------------------------------------------------- boundary bar
  /** The 0..255 bar: one segment per class, one draggable handle per boundary. */
  function buildBar() {
    barSegments = entries.map((entry, index) => el("span", {
      class: "cluster-bar-segment",
      title: `${entry.min}–${entry.max}`,
      "data-cluster": String(entry.cluster),
    }));
    barHandles = boundaries(entries).map((value, handle) => {
      const node = el("button", {
        type: "button",
        class: "cluster-handle",
        role: "slider",
        title: `Boundary ${handle + 1}: drag, or use the arrow keys`,
        "aria-label": `Boundary between class ${handle + 1} and ${handle + 2}`,
      });
      node.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (!step) return;
        event.preventDefault();
        const current = entries[handle]?.max;
        if (current == null) return;
        moveHandle(handle, current + step, { commit: true });
      });
      node.addEventListener("pointerdown", (event) => {
        if (typeof node.setPointerCapture === "function") node.setPointerCapture(event.pointerId);
        node.dataset.dragging = "1";
        event.preventDefault();
      });
      node.addEventListener("pointermove", (event) => {
        if (node.dataset.dragging !== "1") return;
        const track = node.parentElement;
        const rect = track?.getBoundingClientRect?.();
        if (!rect || !rect.width) return; // no layout (jsdom): dragging is a no-op
        const value = Math.round(((event.clientX - rect.left) / rect.width) * (CHANNEL_MAX + 1) - 0.5);
        moveHandle(handle, value);
      });
      const drop = () => {
        if (node.dataset.dragging !== "1") return;
        delete node.dataset.dragging;
        if (entries[handle]) moveHandle(handle, entries[handle].max, { commit: true });
      };
      node.addEventListener("pointerup", drop);
      node.addEventListener("pointercancel", drop);
      return node;
    });
    return el("div", { class: "cluster-bar", "aria-label": "Class boundaries from 0 to 255", title: "Drag a boundary to move it" },
      [...barSegments, ...barHandles]);
  }

  /**
   * Move one boundary from the bar. Unlike the table fields (where the user's
   * text is left alone until Enter/blur), the bar has no text: its own field is
   * written back immediately, then the shared edit path runs.
   */
  function moveHandle(handle, value, { commit = false } = {}) {
    const edit = moveBoundary(entries, handle, value, { commit });
    if (!edit.applied) return false;
    entries = edit.entries;
    const row = rows[handle];
    if (row) row.maxInput.value = String(entries[handle].max);
    applyEdit("max", handle);
    return true;
  }

  /** Keep the bar in step with the model (never rebuilds the handles). */
  function syncBar() {
    entries.forEach((entry, index) => {
      const segment = barSegments[index];
      if (segment) {
        segment.style.flexGrow = String(entry.max - entry.min + 1);
        segment.style.background = rows[index]?.colorInput.value ?? "#000";
        segment.title = `${entry.min}–${entry.max}${rows[index] ? ` · ${rows[index].nameInput.value}` : ""}`;
      }
    });
    barHandles.forEach((node, handle) => {
      const value = entries[handle]?.max;
      if (value == null) return;
      const bounds = maxEditBounds(entries, handle);
      node.style.left = `${((value + 0.5) / (CHANNEL_MAX + 1)) * 100}%`;
      node.setAttribute("aria-valuemin", String(bounds.low));
      node.setAttribute("aria-valuemax", String(bounds.high));
      node.setAttribute("aria-valuenow", String(value));
    });
  }

  /**
   * The Map composer's legend editor changed a name or colour: write it back
   * into the table so the two editors cannot drift apart. Silence is fine —
   * the composer already rendered the change.
   */
  function setLegendRows(rows_) {
    if (!Array.isArray(rows_) || !rows.length) return false;
    let changed = false;
    let recoloured = false;
    for (const incoming of rows_) {
      const row = rows.find((candidate) => candidate.cluster === incoming.cluster);
      if (!row) continue;
      const name = String(incoming.name ?? "");
      const hex = rgbToHex(incoming.color);
      if (name && row.nameInput.value !== name) {
        row.nameInput.value = name;
        changed = true;
      }
      if (hex && row.colorInput.value !== hex) {
        row.colorInput.value = hex;
        recoloured = true;
        changed = true;
      }
    }
    if (recoloured) {
      syncBar();
      showPreview();
    }
    if (changed) emitLegend();
    return changed;
  }

  /** Put every min/max back to the values the algorithm returned. */
  function resetRanges() {
    if (!state.kmeans) return;
    renderEditor(state.kmeans, { keepEdits: true });
    showPreview();
    toast("Ranges reset to the values K-Means found.", "ok");
  }

  /** The editor as legend rows: what Generate map sends and the map draws. */
  function legendEntries() {
    return rows.map((row, index) => ({
      cluster: row.cluster,
      name: row.nameInput.value.trim() || `Cluster ${row.cluster}`,
      color: hexToRgb(row.colorInput.value),
      min: entries[index]?.min ?? 0,
      max: entries[index]?.max ?? 0,
      count: row.count,
      percentage: Number(row.percentage.toFixed(4)) || 0,
    }));
  }

  function emitLegend() {
    bus.emit("clusters:changed", { rows: legendEntries() });
  }

  /**
   * "Generate map": commit the editor with ONE classify request (which is ONE
   * history entry — nothing else in this path touches the history) and open
   * the map composer from its response.
   */
  async function classify() {
    const active = state.kmeans ? { id: state.kmeans.sourceImageId, info: state.kmeans.sourceInfo } : activeImage(state);
    if (!active) return toast("Load or fetch an image first.", "warn");
    if (!entries.length) return toast("Run K-Means first so there are ranges to classify.", "warn");

    // any half-typed field is clamped to its valid value first, exactly as
    // blurring the field would do — the model is always contiguous
    commitPendingEdits();

    const ranges = {};
    const assignments = {};
    for (const row of rows) {
      const [min, max] = [row.minInput.value, row.maxInput.value].map((value) => Math.round(Number(value)));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < CHANNEL_MIN || max > CHANNEL_MAX || min > max) {
        return toast(`Cluster ${row.cluster}: stay between ${CHANNEL_MIN} and ${CHANNEL_MAX}.`, "warn");
      }
      ranges[row.cluster] = [min, max];
      assignments[row.cluster] = { name: row.nameInput.value.trim() || `Cluster ${row.cluster}`, color: hexToRgb(row.colorInput.value) };
    }

    setBusy(true);
    try {
      const result = await session.withImage(active.id, (sid, imageId) =>
        ctx.api.classify(sid, imageId, { ranges, assignments }),
      );
      session.useAsResultId(result.image_id, { ...(active.info ?? {}), source: "classify" });
      // the Map composer is built from this response: classified image + legend
      state.legend = result.legend ?? [];
      bus.emit("preview:clear"); // the committed image is replacing the preview
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

  /** Clamp every half-typed field, so the model matches what the user sees. */
  function commitPendingEdits() {
    rows.forEach((row, index) => {
      if (row.minInput.value !== String(entries[index]?.min)) {
        commitTyped("min", index, row.minInput);
      }
      if (row.maxInput.value !== String(entries[index]?.max)) {
        commitTyped("max", index, row.maxInput);
      }
    });
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

  // the File menu's "Export raw label map" asks for it here, where the K-Means
  // response (and therefore the label image id) lives
  bus.on("labelmap:request", () => downloadLabelMap());

  bus.on("image:loaded", ({ role }) => {
    if (role === "original") {
      state.kmeans = null;
      entries = [];
      rows = [];
      barSegments = [];
      barHandles = [];
      bins = null;
      binsFor = null;
      sourceCache = { imageId: null, bitmap: null, pending: null };
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

/**
 * Recolour a decoded source through a 256-entry LUT and return the preview
 * canvas, or null where this environment cannot draw (jsdom, hidden tab).
 */
function renderRangePreview(source, lut, { document: doc = globalThis.document } = {}) {
  if (!doc || !source) return null;
  const width = Number(source.width) || 0;
  const height = Number(source.height) || 0;
  if (!width || !height) return null;
  const target = previewSize(width, height);
  const canvas = doc.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, target.width, target.height);
  const pixels = context.getImageData?.(0, 0, target.width, target.height);
  if (!pixels?.data) return null;
  recolorPixels(pixels.data, lut);
  context.putImageData(pixels, 0, 0);
  canvas.dataset.previewScale = String(target.scale);
  return canvas;
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
