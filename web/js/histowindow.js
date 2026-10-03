/**
 * Floating histogram windows (items 9 and 13).
 *
 * The Analysis panel keeps a single "Histogram" button — it opens the window
 * for the ACTIVE viewport's image, and if that image already has a window it
 * opens the other viewport's image instead, so Original-vs-Result is two
 * clicks. Each viewport footer also carries its own small Histogram button for
 * that viewport's image (js/viewer.js). Every press opens a separate NON-modal,
 * opaque window that floats over the page.
 *
 * Each window is independent: its own image, its own options, its own export.
 * Windows are draggable by their title bar and RESIZABLE from their bottom-right
 * grip, are always clamped inside the page (never past the bottom or side
 * edges), close with their ✕ or Escape while focused, are keyboard accessible
 * (arrow keys move, Tab stays inside) and tile side by side so a new one never
 * hides an existing one. At most four are open.
 *
 * Bins are fetched ONCE per image (the API's 256 counts) and cached; every
 * option — scale, smoothing, display, theme, compare — is recomputed in the
 * browser from those numbers, so changing an option never causes a request.
 * The Channel dropdown adds Gray (the API series) plus Red / Green / Blue /
 * RGB overlay for colour images, computed here from the decoded pixels
 * (see channelHistograms in js/histogram.js) — still no API change.
 */

import { previewSize } from "./preview.js";
import {
  CHANNEL_OPTIONS,
  COMPARE_COLOR,
  DISPLAY_MODES,
  SCALE_OPTIONS,
  SMOOTHING_RANGE,
  THEME_OPTIONS,
  binStats,
  channelLabel,
  channelOptionsFor,
  describeOptions,
  displayFlags,
  drawHistogram,
  formatStats,
  histogramFileName,
  seriesForChannel,
  channelHistograms,
} from "./histogram.js";
import { SessionExpiredError } from "./session.js";
import { downloadBlob, el, icon, toast } from "./ui.js";

/** Chart size on screen; exports are drawn at EXPORT_SCALE times that. */
export const WINDOW_CHART = Object.freeze({ width: 560, height: 260 });
export const EXPORT_SCALE = 2;
/** How many windows may be open at once. */
export const MAX_WINDOWS = 4;
export const WINDOW_SIZE = Object.freeze({ width: 560, height: 420, margin: 16, gap: 12 });
/** Resizing limits: big enough to read, small enough to stay on the page. */
export const MIN_WINDOW = Object.freeze({ width: 380, height: 240 });
export const MAX_WINDOW = Object.freeze({ width: 1600, height: 1200 });
/** Longest side of the decoded copy used for browser-side channel histograms. */
export const CHANNEL_SAMPLE_MAX = 2048;
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
    /** image id → {gray,red,green,blue,count} from the DECODED pixels. */
    this.channelCache = new Map();
    /** in-flight decodes, so two windows on one image share one decode. */
    this.channelPending = new Map();
    this.nextId = 1;
    this.layer = null;
    this._onKeyDown = (event) => this._handleKey(event);
    // a smaller window must never leave a window hanging off the page
    this._onViewportResize = () => this.reclampAll();
    (this.doc.defaultView ?? globalThis).addEventListener?.("resize", this._onViewportResize);
  }

  get count() {
    return this.windows.length;
  }

  isFull() {
    return this.windows.length >= this.limit;
  }

  /**
   * The image a window is open for right now, so the sidebar button can choose
   * the other viewport instead of opening the same image twice (item 13).
   */
  hasWindowFor(targetId) {
    return this.windows.some((win) => win.targetId === String(targetId ?? ""));
  }

  /**
   * The ACTIVE viewport's image, and the other viewport's image. "Active" is
   * whoever was last clicked or focused (state.activeRole, kept by app.js);
   * with nothing loaded anywhere this falls back to the working image.
   */
  viewportPair() {
    const activeRole = this.state?.activeRole === "result" ? "result" : "original";
    const otherRole = activeRole === "result" ? "original" : "result";
    const pick = (role) => {
      const entry = this.state?.[role];
      return entry?.id ? { id: String(entry.id), role, info: entry.info ?? null } : null;
    };
    const active = pick(activeRole);
    const other = pick(otherRole);
    return { activeRole, otherRole, active, other };
  }

  /**
   * The sidebar button: the active viewport's image; if that already has a
   * window, the other viewport's image instead — two clicks cover both.
   */
  openFromPanel() {
    const { active, other } = this.viewportPair();
    if (active && !this.hasWindowFor(active.id)) return this.open({ targetId: active.id });
    if (other && !this.hasWindowFor(other.id)) return this.open({ targetId: other.id });
    // both viewports already have a window: open one more for the active image
    return this.open({ targetId: active?.id ?? other?.id ?? null });
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

  /**
   * The rectangles the open windows occupy: their real (possibly resized) size
   * at their current position — the tiling, clamping and the tests all use this
   * one source.
   */
  rects() {
    return this.windows.map((win) => {
      const bounds = this.sizeOf(win);
      return {
        id: win.id,
        left: Number.parseFloat(win.root.style.left) || 0,
        top: Number.parseFloat(win.root.style.top) || 0,
        width: bounds.width,
        height: bounds.height,
      };
    });
  }

  /** The current size of a window (style first, then the defaults). */
  sizeOf(win) {
    const width = Number.parseFloat(win?.root?.style?.width) || WINDOW_SIZE.width;
    const height = Number.parseFloat(win?.root?.style?.height) || WINDOW_SIZE.height;
    return { width, height };
  }

  /** The page area a window has to stay inside (margin included). */
  viewport() {
    const win_ = this.doc.defaultView ?? globalThis;
    return {
      width: Number(win_.innerWidth) || 1280,
      height: Number(win_.innerHeight) || 800,
      margin: WINDOW_SIZE.margin,
    };
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
    const { width: viewportWidth, height: viewportHeight, margin } = this.viewport();
    const gap = WINDOW_SIZE.gap;
    this.fitSize(win); // never wider/taller than the page allows
    const { width, height } = this.sizeOf(win);
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
    this._move(win, spot.left, spot.top);
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
    const displayField = select("Display", DISPLAY_MODES, "counts", "display");
    const themeField = select("Theme", THEME_OPTIONS, "dark", "theme");
    const compareField = select("Compare", [{ key: "off", label: "Off" },
      ...allTargets.map((entry) => ({ key: entry.id, label: entry.title }))], "off", "compare");
    // Channel: Gray (the API series) + the browser-computed colour channels.
    // A grayscale image only offers Gray, so the option list is rebuilt per image.
    const channelField = select("Channel", channelOptionsFor(chosen.info), "gray", "channel");

    /**
     * Smoothing is a SLIDER (item 13): 0 = off … 10, labelled only "Smoothing",
     * with no number shown next to it. The window is the label of its own field.
     */
    const smoothingInput = el("input", {
      type: "range",
      class: "histo-slider",
      id: `histo-smoothing-${id}`,
      min: String(SMOOTHING_RANGE.min),
      max: String(SMOOTHING_RANGE.max),
      step: String(SMOOTHING_RANGE.step),
      value: String(SMOOTHING_RANGE.value),
      "aria-label": "Smoothing",
    });
    const smoothingField = el("label", { class: "histo-field histo-field-slider" }, [
      el("span", { class: "histo-label", text: "Smoothing" }),
      smoothingInput,
    ]);
    smoothingField.htmlFor = smoothingInput.id;

    const exportButton = el("button", { type: "button", class: "btn small histo-export", text: "Export PNG" });
    exportButton.prepend(icon("download", { size: 12 }));
    const controls = el("div", { class: "histo-controls" }, [
      imageField.label,
      channelField.label,
      scaleField.label,
      smoothingField,
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

    const resizeGrip = el("span", {
      class: "histo-resize", "aria-hidden": "true",
      title: "Drag to resize this window",
    });
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
      resizeGrip,
    ]);
    // an explicit size keeps the tiling and clamping maths honest (the body scrolls)
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
        channel: channelField.node,
        scale: scaleField.node,
        smoothing: smoothingInput,
        display: displayField.node,
        theme: themeField.node,
        compare: compareField.node,
      },
      targetId: chosen.id,
      targetInfo: chosen.info ?? null,
      bins: null,
      compareBins: null,
      histograms: null,     // browser-computed channel counts for this image
      channelPending: null,
      busy: false,
    };

    // small public surface on each window record: tests and the panel can
    // drive a window without reaching into its private helpers
    win.exportPng = () => this._export(win);
    win.setImage = (targetId) => this._load(win, targetId);
    win.redraw = () => this._draw(win);
    win.options = () => this._options(win);
    win.resizeTo = (width, height) => this.resize(win, width, height);

    closeButton.addEventListener("click", () => this.close(id));
    win.fields.image.addEventListener("change", () => this._load(win, win.fields.image.value));
    win.fields.compare.addEventListener("change", () => void this._loadCompare(win));
    win.fields.channel.addEventListener("change", () => void this._loadChannel(win));
    for (const key of ["scale", "display", "theme"]) {
      win.fields[key].addEventListener("change", () => this._draw(win));
    }
    // the slider redraws while dragging: it is pure browser maths, no request
    smoothingInput.addEventListener("input", () => this._draw(win));
    smoothingInput.addEventListener("change", () => this._draw(win));
    this._resize(win, resizeGrip);
    exportButton.addEventListener("click", () => this._export(win));
    root.addEventListener("mousedown", () => this._raise(win));
    this._drag(win);
    return win;
  }

  _options(win) {
    const flags = displayFlags(win.fields.display.value);
    return {
      scale: win.fields.scale.value === "log" ? "log" : "linear",
      smoothing: Number(win.fields.smoothing.value) || 0,
      theme: win.fields.theme.value === "light" ? "light" : "dark",
      channel: win.fields.channel.value || "gray",
      ...flags,
    };
  }

  /**
   * The bins the window shows for its channel: the API's gray series for Gray,
   * the browser's own counts for Red / Green / Blue, and null for the RGB
   * overlay (which draws three coloured outlines instead of one filled series).
   */
  _binsFor(win, channel) {
    if (channel === "gray" || channel == null) return win.bins ?? [];
    if (channel === "rgb") return null;
    return win.histograms?.[channel] ? Array.from(win.histograms[channel]) : [];
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
    // the RGB overlay draws its three channels; Gray/R/G/B draw one filled series
    const series = seriesForChannel(options.channel, win.histograms);
    const bins = this._binsFor(win, options.channel);
    drawHistogram(context, {
      bins: bins ?? [],
      ...WINDOW_CHART,
      ...options,
      title: `${target?.title ?? "image"} · ${describeOptions(options)}`,
      compare,
      series,
    });
    const stats = binStats(bins ?? win.bins);
    const rows = formatStats(stats);
    win.statsHost.replaceChildren(...rows.flatMap((row) => [
      el("dt", { class: "histo-stat-label", text: row.label }),
      el("dd", { class: "histo-stat-value", text: row.text }),
    ]));
    const total = bins?.length ?? 0;
    const sampled = win.channelSample && win.channelSample.scale < 1
      ? ` · channel counts sampled at ${win.channelSample.width}×${win.channelSample.height}`
      : "";
    win.status.textContent = win.busy
      ? "Loading the 256 bins…"
      : win.channelPending
        ? "Reading the image's channels…"
        : bins || series.length
          ? `${total || 256} bins · ${stats.count.toLocaleString()} pixels${sampled} · every option recomputed here, no new requests`
          : "No histogram yet.";
    if (series.length) {
      win.status.textContent = `RGB overlay · ${stats.count.toLocaleString()} pixels${sampled} · computed in the browser, no new requests`;
    }
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
    this._syncTargetControls(win, target);
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
      if (win.fields.channel.value !== "gray") void this._loadChannel(win);
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

  /**
   * The Channel dropdown: Gray needs nothing (the API's bins are already
   * there); every other channel is computed here from the decoded image, so
   * switching channels never causes a request.
   */
  async _loadChannel(win) {
    const channel = win.fields.channel.value;
    if (channel === "gray") {
      win.channelPending = null;
      this._draw(win);
      return { ok: true, cached: true };
    }
    const cached = this.channelCache.get(win.targetId);
    if (cached) {
      win.histograms = cached;
      win.channelPending = null;
      this._draw(win);
      return { ok: true, cached: true };
    }
    const pending = this._decodeChannels(win.targetId);
    win.channelPending = pending;
    this._draw(win);
    const histograms = await pending;
    win.channelPending = null;
    if (win.targetId !== histograms?.imageId) {
      // the user switched image while decoding: reload for the new one
      return this._loadChannel(win);
    }
    win.histograms = histograms;
    this._draw(win);
    return histograms ? { ok: true, cached: false } : { ok: false };
  }

  /** Decode an image once (shared by every window) and count its channels. */
  _decodeChannels(imageId) {
    const key = String(imageId ?? "");
    if (this.channelCache.has(key)) return Promise.resolve(this.channelCache.get(key));
    if (this.channelPending.has(key)) return this.channelPending.get(key);
    const job = (async () => {
      const doc = this.doc;
      const decode = doc.defaultView?.createImageBitmap ?? globalThis.createImageBitmap;
      if (!doc || typeof decode !== "function" || !this.session) return null;
      try {
        const blob = await this.session.imageBlob(key);
        const bitmap = await decode(blob);
        try {
          const width = Number(bitmap?.width) || 0;
          const height = Number(bitmap?.height) || 0;
          if (!width || !height) return null;
          const target = previewSize(width, height, CHANNEL_SAMPLE_MAX);
          const canvas = doc.createElement("canvas");
          canvas.width = target.width;
          canvas.height = target.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return null;
          context.drawImage(bitmap, 0, 0, target.width, target.height);
          const pixels = context.getImageData?.(0, 0, target.width, target.height);
          if (!pixels?.data) return null;
          const histograms = channelHistograms(pixels.data);
          histograms.imageId = key;
          histograms.sample = { width: target.width, height: target.height, scale: target.scale };
          this.channelCache.set(key, histograms);
          return histograms;
        } finally {
          bitmap?.close?.();
        }
      } catch {
        return null; // no pixels available: the window keeps its other options
      }
    })().finally(() => this.channelPending.delete(key));
    this.channelPending.set(key, job);
    return job;
  }

  /**
   * Point the Image/Channel controls at the image a window is showing and
   * recompute what the new image offers (a grayscale image has no Red/Green/
   * Blue, so those options disappear instead of drawing empty charts).
   */
  _syncTargetControls(win, target) {
    const info = target?.info ?? null;
    win.targetInfo = info;
    const options = channelOptionsFor(info);
    const allowed = new Set(options.map((entry) => entry.key));
    const current = win.fields.channel.value;
    win.fields.channel.replaceChildren(...options.map((entry) =>
      el("option", { value: entry.key, text: entry.label })));
    win.fields.channel.value = allowed.has(current) ? current : "gray";
    win.histograms = this.channelCache.get(win.targetId) ?? null;
    win.channelSample = win.histograms?.sample ?? null;
    if (win.fields.channel.value !== "gray" || win.histograms) void this._loadChannel(win);
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
    if (!win.bins?.length && !win.histograms) {
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
      bins: this._binsFor(win, options.channel) ?? [],
      width: exportCanvas.width,
      height: exportCanvas.height,
      ...options,
      title: `${target?.title ?? "image"} · ${describeOptions(options)}`,
      fontSize: 10 * EXPORT_SCALE,
      compare: compareTarget && win.compareBins?.length
        ? { bins: win.compareBins, label: compareTarget.title, color: COMPARE_COLOR }
        : null,
      series: seriesForChannel(options.channel, win.histograms),
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
    // a modal dialog owns the keyboard while it is open (item 14): Escape must
    // close the dialog, not the window behind it
    if (this.doc.querySelector?.(".app-dialog")) return;
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

  /**
   * Move a window, clamped so the WHOLE window stays on the page — including
   * the bottom edge (the old clamp allowed it to hang 40 px below the fold).
   */
  _move(win, left, top) {
    const { width: viewportWidth, height: viewportHeight, margin } = this.viewport();
    const { width, height } = this.sizeOf(win);
    const maxLeft = Math.max(0, viewportWidth - width - margin);
    const maxTop = Math.max(0, viewportHeight - height - margin);
    win.root.style.left = `${Math.round(Math.min(Math.max(0, left), maxLeft))}px`;
    win.root.style.top = `${Math.round(Math.min(Math.max(0, top), maxTop))}px`;
  }

  /** Keep a window's current position legal after the page or it changed size. */
  reclamp(win) {
    if (!win) return null;
    this._move(win, Number.parseFloat(win.root.style.left) || 0, Number.parseFloat(win.root.style.top) || 0);
    return this.rect(win);
  }

  /** Re-clamp every open window (called when the browser window is resized). */
  reclampAll() {
    for (const win of this.windows) this.reclamp(win);
    return this.windows.length;
  }

  rect(win) {
    const bounds = this.sizeOf(win);
    return {
      id: win?.id,
      left: Number.parseFloat(win?.root?.style?.left) || 0,
      top: Number.parseFloat(win?.root?.style?.top) || 0,
      width: bounds.width,
      height: bounds.height,
    };
  }

  /**
   * How large a window MAY be: between MIN_WINDOW and the page itself (so a
   * small window can never force the window off the edges).
   */
  sizeBounds() {
    const { width: viewportWidth, height: viewportHeight, margin } = this.viewport();
    return {
      minWidth: Math.min(MIN_WINDOW.width, Math.max(200, viewportWidth - margin * 2)),
      maxWidth: Math.max(240, Math.min(MAX_WINDOW.width, viewportWidth - margin * 2)),
      minHeight: Math.min(MIN_WINDOW.height, Math.max(160, viewportHeight - margin * 2)),
      maxHeight: Math.max(200, Math.min(MAX_WINDOW.height, viewportHeight - margin * 2)),
    };
  }

  /** Shrink a window (if needed) so it fits the page at all. */
  fitSize(win) {
    const bounds = this.sizeBounds();
    const { width, height } = this.sizeOf(win);
    const next = {
      width: Math.max(bounds.minWidth, Math.min(bounds.maxWidth, width)),
      height: Math.max(bounds.minHeight, Math.min(bounds.maxHeight, height)),
    };
    win.root.style.width = `${Math.round(next.width)}px`;
    win.root.style.height = `${Math.round(next.height)}px`;
    return this.sizeOf(win);
  }

  /** Resize a window to `width` × `height`, clamped, then re-clamped in place. */
  resize(win, width, height) {
    if (!win) return null;
    const bounds = this.sizeBounds();
    const next = {
      width: Math.max(bounds.minWidth, Math.min(bounds.maxWidth, Number(width) || WINDOW_SIZE.width)),
      height: Math.max(bounds.minHeight, Math.min(bounds.maxHeight, Number(height) || WINDOW_SIZE.height)),
    };
    win.root.style.width = `${Math.round(next.width)}px`;
    win.root.style.height = `${Math.round(next.height)}px`;
    this.reclamp(win);
    return this.rect(win);
  }

  /** The bottom-right grip: drag it to resize (pointer, then keyboard). */
  _resize(win, grip) {
    const win_ = this.doc.defaultView ?? globalThis;
    let start = null;
    const onDown = (event) => {
      this._raise(win);
      const bounds = this.sizeOf(win);
      start = { x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height };
      if (typeof grip.setPointerCapture === "function") grip.setPointerCapture(event.pointerId);
      event.preventDefault();
      win_.addEventListener("mousemove", onMove);
      win_.addEventListener("mouseup", onUp);
    };
    const onMove = (event) => {
      if (!start) return;
      this.resize(win, start.width + (event.clientX - start.x), start.height + (event.clientY - start.y));
    };
    const onUp = () => {
      start = null;
      win_.removeEventListener("mousemove", onMove);
      win_.removeEventListener("mouseup", onUp);
    };
    grip.addEventListener("mousedown", onDown);
    // keyboard resizing keeps the grip usable without a pointer (and testable)
    grip.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? MOVE_STEP_BIG : MOVE_STEP;
      const bounds = this.sizeOf(win);
      const moves = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const delta = moves[event.key];
      if (!delta) return;
      event.preventDefault();
      this.resize(win, bounds.width + delta[0], bounds.height + delta[1]);
    });
  }
}
