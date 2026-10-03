/**
 * Floating histogram windows (item 9).
 *
 * The Analysis panel keeps a single "Histogram" button; every press opens a
 * separate NON-modal, opaque window that floats over the page. Each window is
 * independent: its own image, its own options, its own export. Windows are
 * draggable by their title bar, close with their ✕ or Escape while focused,
 * are keyboard accessible (arrow keys move, Tab stays inside) and tile side by
 * side so a new one never hides an existing one. At most four are open.
 *
 * Bins are fetched ONCE per image (the API's 256 counts) and cached; every
 * option — scale, smoothing, display, theme, compare — is recomputed in the
 * browser from those numbers, so changing an option never causes a request.
 */

import {
  COMPARE_COLOR,
  DISPLAY_MODES,
  SCALE_OPTIONS,
  SMOOTHING_LEVELS,
  THEME_OPTIONS,
  binStats,
  describeOptions,
  displayFlags,
  drawHistogram,
  formatStats,
  histogramFileName,
} from "./histogram.js";
import { SessionExpiredError } from "./session.js";
import { downloadBlob, el, icon, toast } from "./ui.js";

/** Chart size on screen; exports are drawn at EXPORT_SCALE times that. */
export const WINDOW_CHART = Object.freeze({ width: 560, height: 260 });
export const EXPORT_SCALE = 2;
/** How many windows may be open at once. */
export const MAX_WINDOWS = 4;
export const WINDOW_SIZE = Object.freeze({ width: 560, height: 420, margin: 16, gap: 12 });
/** Cascade offset used only when the screen has no free slot left. */
export const CASCADE_STEP = 26;
export const MOVE_STEP = 16;
export const MOVE_STEP_BIG = 64;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The images a histogram can be drawn for, in the required order: the original,
 * the result, then every state the undo history knows.
 */
export function histogramTargets({ state, history } = {}) {
  const entries = history?.entries ?? [];
  // the history knows which step produced an image; prefer its label so the
  // Original / Result rows are named the same way as the history rows
  const labels = new Map();
  for (const entry of entries) {
    if (entry?.imageId) labels.set(String(entry.imageId), entry.label ?? "");
  }
  const seen = new Set();
  const targets = [];
  const push = (id, info, fallback, kind) => {
    const key = String(id ?? "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    const label = labels.get(key) ?? fallback;
    targets.push({ id: key, info: info ?? null, label: label ?? "", kind, title: targetTitle(info, label) });
  };
  push(state?.original?.id, state?.original?.info, "original", "original");
  push(state?.result?.id, state?.result?.info, "result", "result");
  for (const entry of entries) {
    push(entry.imageId, entry.info, entry.label, "history");
  }
  return targets;
}

export const TITLE_MAX = 56;

/** Strip punctuation/case so "K-Means display" and "kmeans-display" match. */
function plain(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Keep a long chained name readable: head#…tail. */
export function clipTitle(title, maxLength = TITLE_MAX) {
  const text = String(title ?? "");
  if (text.length <= maxLength) return text;
  const parts = text.split("#");
  if (parts.length > 2) {
    const short = `${parts[0]}#…${parts.at(-1)}`;
    return short.length <= maxLength ? short : `${short.slice(0, maxLength - 1)}…`;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * "Histogram: sample.jpg#negative" — the image's name plus the step that
 * produced it. The API already chains the step into derived names
 * (`sample.jpg#negative`), so the suffix is only added when it is missing.
 */
export function targetTitle(info, label = "", { maxLength = TITLE_MAX } = {}) {
  const name = String(info?.name ?? "").trim() || "image";
  const suffix = String(label ?? "").trim();
  if (!suffix) return clipTitle(name, maxLength);
  const slug = suffix.replace(/^(Opened|Result —)\s*/i, "").trim();
  if (!slug || plain(name).includes(plain(slug))) return clipTitle(name, maxLength);
  // "Negative" → "sample.jpg#negative", matching the history buttons' wording
  const title = `${name}#${slug.charAt(0).toLowerCase()}${slug.slice(1)}`;
  return clipTitle(title, maxLength);
}

export class HistogramWindows {
  constructor({ bus = null, state = null, session = null, api = null, doc = globalThis.document, history = null, mount = null, limit = MAX_WINDOWS } = {}) {
    this.bus = bus;
    this.state = state;
    this.session = session;
    this.api = api;
    this.history = history;
    this.doc = doc;
    this.mount = mount ?? doc.body;
    this.limit = limit;
    /** Open windows, oldest first: { id, targetId, root, canvas, bins, ... }. */
    this.windows = [];
    /** image id → 256 bins (never fetched twice for the same image). */
    this.binsCache = new Map();
    this.nextId = 1;
    this.layer = null;
    this._onKeyDown = (event) => this._handleKey(event);
  }

  get count() {
    return this.windows.length;
  }

  isFull() {
    return this.windows.length >= this.limit;
  }

  /** Open a window; without a targetId it uses the working image. */
  open({ targetId = null } = {}) {
    if (this.isFull()) {
      toast(`${this.limit} histogram windows are open — close one first.`, "warn");
      return null;
    }
    const targets = histogramTargets({ state: this.state, history: this.history });
    if (!targets.length) {
      toast("Load or fetch an image first.", "warn");
      return null;
    }
    const chosen = targets.find((entry) => entry.id === targetId) ?? targets.find((entry) => entry.kind === "result") ?? targets[0];
    const id = this.nextId;
    this.nextId += 1;
    const layer = this._ensureLayer();
    const win = this._buildWindow(id, targets, chosen, targets);
    this._place(win);
    this.windows.push(win);
    layer.append(win.root);
    win.canvas = win.root.querySelector(".histo-canvas");
    const focusTarget = win.root.querySelector(".histo-bar");
    if (typeof focusTarget?.focus === "function") focusTarget.focus();
    this._load(win, chosen.id);
    this.bus?.emit?.("histogram:window", { open: true, id, count: this.count });
    return win;
  }

  close(id = null) {
    const win = id == null ? this.windows.at(-1) : this.windows.find((entry) => entry.id === id);
    if (!win) return false;
    this.windows = this.windows.filter((entry) => entry !== win);
    win.root.remove();
    if (!this.windows.length && this.layer) {
      this.doc.removeEventListener("keydown", this._onKeyDown, true);
      this.layer.remove();
      this.layer = null;
    }
    this.bus?.emit?.("histogram:window", { open: false, id: win.id, count: this.count });
    return true;
  }

  closeAll() {
    for (const win of [...this.windows]) this.close(win.id);
    return this.count === 0;
  }

  /** Is a value inside a window (used by the tests to look for overlap)? */
  rects() {
    return this.windows.map((win) => ({
      id: win.id,
      left: Number.parseFloat(win.root.style.left) || 0,
      top: Number.parseFloat(win.root.style.top) || 0,
      width: WINDOW_SIZE.width,
      height: WINDOW_SIZE.height,
    }));
  }

  // ------------------------------------------------------------------ private
  _ensureLayer() {
    if (this.layer) return this.layer;
    const layer = el("div", { class: "histo-layer", role: "presentation" });
    (this.mount ?? this.doc.body).append(layer);
    // capture phase: Escape must reach the window even from a select inside it
    this.doc.addEventListener("keydown", this._onKeyDown, true);
    this.layer = layer;
    return layer;
  }

  /**
   * Tile a new window into the first free slot of a grid that starts at the top
   * left — a new window NEVER covers one that is already open. Only when the
   * screen has no free slot left does it cascade the last one a little.
   */
  _place(win) {
    const win_ = this.doc.defaultView ?? globalThis;
    const viewportWidth = Number(win_.innerWidth) || 1280;
    const viewportHeight = Number(win_.innerHeight) || 800;
    const { width, height, margin, gap } = WINDOW_SIZE;
    const rects = this.rects();
    const columns = Math.max(1, Math.floor((viewportWidth - margin - gap) / (width + gap)));
    const rows = Math.max(1, Math.floor((viewportHeight - margin - gap) / (height + gap)) + 1);
    const overlaps = (spot) => rects.some((other) =>
      spot.left < other.left + other.width && spot.left + width > other.left &&
      spot.top < other.top + other.height && spot.top + height > other.top);
    let spot = null;
    for (let row = 0; row < rows && !spot; row += 1) {
      for (let column = 0; column < columns && !spot; column += 1) {
        const candidate = { left: margin + column * (width + gap), top: margin + row * (height + gap) };
        if (candidate.left + width > viewportWidth - margin) continue;
        if (candidate.top + height > viewportHeight - margin) continue;   // must fit on screen
        if (!overlaps(candidate)) spot = candidate;
      }
    }
    if (!spot) {
      const last = rects.at(-1) ?? { left: margin, top: margin };
      spot = { left: last.left + CASCADE_STEP, top: last.top + CASCADE_STEP };
    }
    win.root.style.left = `${Math.max(0, Math.round(spot.left))}px`;
    win.root.style.top = `${Math.max(0, Math.round(spot.top))}px`;
  }

  _buildWindow(id, targets, chosen, allTargets) {
    const titleId = `histo-title-${id}`;
    const closeButton = el("button", {
      type: "button", class: "icon-btn histo-close", "aria-label": "Close this histogram window",
      title: "Close (Esc)",
    }, icon("close", { size: 14 }));
    const bar = el("header", {
      class: "histo-bar", tabindex: "0",
      "aria-label": "Move this window with the arrow keys",
      title: "Drag to move · arrow keys move 16 px (Shift 64 px)",
    }, [
      el("h3", { class: "histo-title", id: titleId, text: `Histogram: ${chosen.title}` }),
      closeButton,
    ]);

    const select = (labelText, options, value, key) => {
      const node = el("select", { class: "select histo-select", id: `histo-${key}-${id}` }, options.map((entry) =>
        el("option", { value: entry.key, text: entry.label })));
      node.value = value;
      const label = el("label", { class: "histo-field" }, [el("span", { class: "histo-label", text: labelText }), node]);
      label.htmlFor = node.id;
      return { node, label };
    };

    const imageField = select("Image", allTargets.map((entry) => ({ key: entry.id, label: entry.title })), chosen.id, "image");
    const scaleField = select("Scale", SCALE_OPTIONS, "linear", "scale");
    const smoothingField = select("Smoothing", SMOOTHING_LEVELS, "off", "smoothing");
    const displayField = select("Display", DISPLAY_MODES, "counts", "display");
    const themeField = select("Theme", THEME_OPTIONS, "dark", "theme");
    const compareField = select("Compare", [{ key: "off", label: "Off" },
      ...allTargets.map((entry) => ({ key: entry.id, label: entry.title }))], "off", "compare");

    const exportButton = el("button", { type: "button", class: "btn small histo-export", text: "Export PNG" });
    exportButton.prepend(icon("download", { size: 12 }));
    const controls = el("div", { class: "histo-controls" }, [
      imageField.label,
      scaleField.label,
      smoothingField.label,
      displayField.label,
      themeField.label,
      compareField.label,
      el("div", { class: "histo-actions" }, exportButton),
    ]);

    const canvas = el("canvas", {
      class: "histo-canvas", width: WINDOW_CHART.width, height: WINDOW_CHART.height,
      role: "img", "aria-label": "Histogram chart",
    });
    const statsHost = el("dl", { class: "histo-stats", "aria-label": "Statistics" });
    const status = el("p", { class: "histo-status", role: "status", text: "" });

    const root = el("section", {
      class: "histo-window", role: "dialog", "aria-modal": "false", "aria-labelledby": titleId,
      "aria-label": `Histogram window for ${chosen.title}`,
      dataset: { window: String(id) },
    }, [
      bar,
      el("div", { class: "histo-body" }, [
        controls,
        el("div", { class: "histo-main" }, [canvas, statsHost]),
        status,
      ]),
    ]);
    // an explicit height keeps the tiling maths honest (the body scrolls)
    root.style.width = `${WINDOW_SIZE.width}px`;
    root.style.height = `${WINDOW_SIZE.height}px`;

    const win = {
      id,
      root,
      bar,
      canvas,
      statsHost,
      status,
      title: root.querySelector(".histo-title"),
      fields: {
        image: imageField.node,
        scale: scaleField.node,
        smoothing: smoothingField.node,
        display: displayField.node,
        theme: themeField.node,
        compare: compareField.node,
      },
      targetId: chosen.id,
      bins: null,
      compareBins: null,
      busy: false,
    };

    // small public surface on each window record: tests and the panel can
    // drive a window without reaching into its private helpers
    win.exportPng = () => this._export(win);
    win.setImage = (targetId) => this._load(win, targetId);
    win.redraw = () => this._draw(win);
    win.options = () => this._options(win);

    closeButton.addEventListener("click", () => this.close(id));
    win.fields.image.addEventListener("change", () => this._load(win, win.fields.image.value));
    win.fields.compare.addEventListener("change", () => void this._loadCompare(win));
    for (const key of ["scale", "smoothing", "display", "theme"]) {
      win.fields[key].addEventListener("change", () => this._draw(win));
    }
    exportButton.addEventListener("click", () => this._export(win));
    root.addEventListener("mousedown", () => this._raise(win));
    this._drag(win);
    return win;
  }

  _options(win) {
    const flags = displayFlags(win.fields.display.value);
    return {
      scale: win.fields.scale.value === "log" ? "log" : "linear",
      smoothing: win.fields.smoothing.value,
      theme: win.fields.theme.value === "light" ? "light" : "dark",
      ...flags,
    };
  }

  _draw(win) {
    const context = win.canvas.getContext("2d");
    const options = this._options(win);
    const target = this._target(win.targetId);
    const compareId = win.fields.compare.value;
    const compareTarget = compareId === "off" ? null : this._target(compareId);
    const compare = compareTarget && win.compareBins?.length
      ? { bins: win.compareBins, label: compareTarget.title, color: COMPARE_COLOR }
      : null;
    drawHistogram(context, {
      bins: win.bins ?? [],
      ...WINDOW_CHART,
      ...options,
      title: `${target?.title ?? "image"} · ${describeOptions(options)}`,
      compare,
    });
    const stats = binStats(win.bins);
    const rows = formatStats(stats);
    win.statsHost.replaceChildren(...rows.flatMap((row) => [
      el("dt", { class: "histo-stat-label", text: row.label }),
      el("dd", { class: "histo-stat-value", text: row.text }),
    ]));
    const total = win.bins?.length ?? 0;
    win.status.textContent = win.busy
      ? "Loading the 256 bins…"
      : win.bins
        ? `${total} bins · ${stats.count.toLocaleString()} pixels · every option recomputed here, no new requests`
        : "No histogram yet.";
    return rows;
  }

  _target(id) {
    return histogramTargets({ state: this.state, history: this.history })
      .find((entry) => entry.id === id) ?? null;
  }

  /** Fetch (or reuse) the bins for one image and redraw the window. */
  async _load(win, targetId) {
    const target = this._target(targetId);
    if (!target) {
      // the image left the session (evicted or cleared): say so, keep the window
      win.targetId = targetId;
      win.bins = null;
      if (win.title) win.title.textContent = `Histogram: ${targetId}`;
      win.status.textContent = "That image is no longer in the session.";
      this._draw(win);
      toast("That image is no longer in the session — pick another one.", "warn");
      return { ok: false, reason: "missing-target" };
    }
    win.targetId = targetId;
    if (win.title) win.title.textContent = `Histogram: ${target.title}`;
    const cached = this.binsCache.get(targetId);
    if (cached) {
      win.bins = cached;
      await this._loadCompare(win);
      return { ok: true, bins: cached, cached: true };
    }
    win.busy = true;
    this._draw(win);
    try {
      const histogram = await this.session.withSession(async (sid) => this.api.histogram(sid, targetId));
      win.bins = histogram?.bins ?? [];
      this.binsCache.set(targetId, win.bins);
      win.busy = false;
      await this._loadCompare(win);
      return { ok: true, bins: win.bins, cached: false };
    } catch (error) {
      win.busy = false;
      win.bins = null;
      this._draw(win);
      win.status.textContent = error instanceof SessionExpiredError
        ? error.message
        : "Could not read that image's histogram.";
      toast(`Histogram failed: ${error instanceof SessionExpiredError ? error.message : "the API refused the request."}`,
        "bad", { timeout: 12000 });
      return { ok: false, error };
    }
  }

  /** The second image of the Compare switch (its own one-off fetch, cached). */
  async _loadCompare(win) {
    const id = win.fields.compare.value;
    if (id === "off") {
      win.compareBins = null;
      this._draw(win);
      return { ok: true, compare: false };
    }
    if (this.binsCache.has(id)) {
      win.compareBins = this.binsCache.get(id);
      this._draw(win);
      return { ok: true, compare: true };
    }
    try {
      const histogram = await this.session.withSession(async (sid) => this.api.histogram(sid, id));
      win.compareBins = histogram?.bins ?? [];
      this.binsCache.set(id, win.compareBins);
      this._draw(win);
      return { ok: true, compare: true };
    } catch (error) {
      win.compareBins = null;
      win.fields.compare.value = "off";
      this._draw(win);
      toast("Compare needs a histogram for the second image — the API refused it.", "bad", { timeout: 12000 });
      return { ok: false, error };
    }
  }

  /** Export what the window shows, at 2× so it survives a slide or a report. */
  async _export(win) {
    if (!win.bins?.length) {
      toast("This window has no histogram to export yet.", "warn");
      return { ok: false, reason: "no-histogram" };
    }
    const options = this._options(win);
    const target = this._target(win.targetId);
    const compareTarget = win.fields.compare.value === "off" ? null : this._target(win.fields.compare.value);
    const exportCanvas = this.doc.createElement("canvas");
    exportCanvas.width = WINDOW_CHART.width * EXPORT_SCALE;
    exportCanvas.height = WINDOW_CHART.height * EXPORT_SCALE;
    drawHistogram(exportCanvas.getContext("2d"), {
      bins: win.bins,
      width: exportCanvas.width,
      height: exportCanvas.height,
      ...options,
      title: `${target?.title ?? "image"} · ${describeOptions(options)}`,
      fontSize: 10 * EXPORT_SCALE,
      compare: compareTarget && win.compareBins?.length
        ? { bins: win.compareBins, label: compareTarget.title, color: COMPARE_COLOR }
        : null,
    });
    const blob = typeof exportCanvas.toBlob === "function"
      ? await new Promise((resolve) => exportCanvas.toBlob(resolve, "image/png"))
      : null;
    if (!blob) {
      toast("This browser could not turn the histogram canvas into a PNG.", "bad");
      return { ok: false, reason: "no-blob" };
    }
    const filename = histogramFileName(target?.info?.name ?? target?.title ?? "image");
    downloadBlob(blob, filename);
    toast(`Histogram exported — ${exportCanvas.width}×${exportCanvas.height} PNG`, "ok");
    return { ok: true, blob, width: exportCanvas.width, height: exportCanvas.height, filename };
  }

  _raise(win) {
    if (this.windows.at(-1) === win) return;
    this.windows = [...this.windows.filter((entry) => entry !== win), win];
    if (this.layer) this.layer.append(win.root);
  }

  _handleKey(event) {
    const win = this.windows.find((entry) => entry.root.contains(event.target));
    if (!win) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close(win.id);
      return;
    }
    if (event.key === "Tab") {
      const nodes = [...win.root.querySelectorAll(FOCUSABLE)]
        .filter((node) => !node.disabled && node.closest("[hidden]") == null);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes.at(-1);
      if (event.shiftKey && (event.target === first || !win.root.contains(event.target))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  /** Drag by the title bar; arrow keys move the focused window too. */
  _drag(win) {
    const win_ = this.doc.defaultView ?? globalThis;
    let offset = null;
    const onDown = (event) => {
      if (event.target.closest?.(".histo-close")) return;
      this._raise(win);
      offset = {
        x: event.clientX - (Number.parseFloat(win.root.style.left) || 0),
        y: event.clientY - (Number.parseFloat(win.root.style.top) || 0),
      };
      event.preventDefault();
      win_.addEventListener("mousemove", onMove);
      win_.addEventListener("mouseup", onUp);
    };
    const onMove = (event) => {
      if (!offset) return;
      this._move(win, event.clientX - offset.x, event.clientY - offset.y);
    };
    const onUp = () => {
      offset = null;
      win_.removeEventListener("mousemove", onMove);
      win_.removeEventListener("mouseup", onUp);
    };
    win.bar.addEventListener("mousedown", onDown);
    win.bar.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? MOVE_STEP_BIG : MOVE_STEP;
      const moves = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const delta = moves[event.key];
      if (!delta) return;
      event.preventDefault();
      const left = (Number.parseFloat(win.root.style.left) || 0) + delta[0];
      const top = (Number.parseFloat(win.root.style.top) || 0) + delta[1];
      this._move(win, left, top);
    });
  }

  _move(win, left, top) {
    const win_ = this.doc.defaultView ?? globalThis;
    const viewportWidth = Number(win_.innerWidth) || 1280;
    const viewportHeight = Number(win_.innerHeight) || 800;
    const maxLeft = Math.max(0, viewportWidth - WINDOW_SIZE.width - 4);
    const maxTop = Math.max(0, viewportHeight - 40);
    win.root.style.left = `${Math.round(Math.min(Math.max(0, left), maxLeft))}px`;
    win.root.style.top = `${Math.round(Math.min(Math.max(0, top), maxTop))}px`;
  }
}
