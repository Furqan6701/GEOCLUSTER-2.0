/**
 * Map composer modal.
 *
 * A large in-page dialog (not a docked viewport): the live preview sits in the
 * middle, the properties sidebar on the right, and every change recomposes the
 * SAME canvas the export uses — so the PNG always matches what is on screen.
 *
 * Modal behaviour: `role="dialog"` + `aria-modal`, Escape closes it, Tab is
 * trapped inside, focus returns to whatever opened it, and the background is
 * inert to the pointer.
 */

import { downloadBlob, el, icon, setChildren, toggleButton } from "./ui.js";
import { mapCanvasToBlob } from "./map.js";
import {
  CORNERS, EXPORT_SCALES, LEGEND_PLACEMENTS, MAP_DEFAULTS, MAP_FONTS, NORTH_STYLES, SCALE_UNITS,
  TEXT_SIZE_RANGE, TITLE_ALIGNS, composeStudioMap,
  formatLength, groundWidthMeters, hasGroundScale, normalizeSettings, roundScaleLength, titleFromName,
} from "./mapstudio.js";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class MapStudio {
  constructor({ bus = null, doc = globalThis.document, previewHost = null, mount = null } = {}) {
    this.bus = bus;
    this.doc = doc;
    this.previewHost = previewHost;
    this.settings = null;
    this.context = null;
    this.canvas = null;
    this.opener = null;
    this.image = null;
    this.info = null;
    this.name = "";
    this.source = "";
    this._savedLegendRows = [];

    this.fields = {};
    this.root = this._build();
    (mount ?? doc.body).append(this.root);
    this.dialog = this.root.querySelector(".map-modal-dialog");

    this.dialog.addEventListener("keydown", (event) => this._onKeyDown(event));
    this.root.querySelector(".map-modal-backdrop").addEventListener("click", () => this.close());
    this.dialog.addEventListener("mousedown", (event) => {
      if (event.target === this.dialog) this.close();
    });
    // keep the composer's header below the page toolbar at every window size
    this._onViewportResize = () => this._fitToViewport();
    (this.doc.defaultView ?? globalThis).addEventListener?.("resize", this._onViewportResize);
  }

  /**
   * Reserve the height of the chrome above the dialog (header + toolbar), so
   * the dialog's own header can never overlap the toolbar. CSS keeps a
   * fallback of the same value in case the measurement cannot run.
   */
  _fitToViewport() {
    const win = this.doc.defaultView ?? globalThis;
    const height = Number(win.innerHeight) || 0;
    if (!height) return;
    const header = this.doc.querySelector(".app-header");
    const headerHeight = Number(header?.getBoundingClientRect?.().height) || 0;
    const fallback = height < 700 ? 40 : 104;
    const top = headerHeight > 0 ? Math.round(headerHeight + 8) : fallback;
    this.root.style?.setProperty?.("--map-modal-top", `${Math.min(top, Math.max(40, height - 200))}px`);
  }

  // ------------------------------------------------------------------ markup
  _build() {
    const closeButton = el("button", {
      type: "button", class: "icon-btn", "aria-label": "Close the Map composer", title: "Close (Esc)",
    }, icon("close", { size: 16 }));
    closeButton.addEventListener("click", () => this.close());

    const previewHost = el("div", { class: "map-preview-host" });
    const body = el("div", { class: "map-modal-body" }, [
      previewHost,
      el("aside", { class: "map-props", "aria-label": "Map properties" }, [
        this._group("Text", this._titleControls()),
        this._group("Legend", this._legendControls()),
        this._group("Scale bar", this._scaleControls()),
        this._group("North arrow", this._arrowControls()),
        this._group("Map", this._mapControls()),
      ]),
    ]);

    const exportButtons = EXPORT_SCALES.map((scale) => {
      const node = el("button", {
        type: "button", class: "btn small", text: `PNG ${scale}x`, dataset: { scale: String(scale) },
      });
      node.addEventListener("click", () => void this.download(scale));
      return node;
    });

    const footer = el("footer", { class: "map-modal-foot" }, [
      el("p", {
        class: "map-modal-note", id: "map-modal-note",
        text: "The preview IS the exported canvas. Legend names and colours stay in sync with the Clusters table.",
      }),
      el("div", { class: "map-export", role: "group", "aria-label": "Export the map as PNG" }, exportButtons),
    ]);

    return el("div", { class: "map-modal", hidden: true, role: "presentation" }, [
      el("div", { class: "map-modal-backdrop", "aria-hidden": "true" }),
      el("div", {
        class: "map-modal-dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "map-modal-title",
        "aria-describedby": "map-modal-note",
      }, [
        el("header", { class: "map-modal-head" }, [
          el("h2", { id: "map-modal-title", text: "Map composer" }),
          el("span", { class: "map-modal-sub", text: "" }, []),
          closeButton,
        ]),
        body,
        footer,
      ]),
    ]);
  }

  _group(title, children) {
    return el("section", { class: "map-group" }, [
      el("h3", { class: "map-group-title", text: title }),
      ...children,
    ]);
  }

  _field(labelText, control, hint = null) {
    const label = el("label", { class: "map-field" }, [
      el("span", { class: "map-field-label", text: labelText }),
      control,
    ]);
    if (hint) label.append(el("span", { class: "map-field-hint", text: hint }));
    return label;
  }

  _select(options, value, onChange, key) {
    const node = el("select", { class: "map-input" });
    for (const option of options) node.append(el("option", { value: option.key, text: option.label }));
    node.value = value;
    node.addEventListener("change", () => onChange(node.value));
    if (key) this.fields[key] = node;
    return node;
  }

  _number(value, onChange, { key, min = null, max = null, step = 1 } = {}) {
    const node = el("input", { type: "number", class: "map-input", value: value == null ? "" : String(value) });
    if (min != null) node.min = String(min);
    if (max != null) node.max = String(max);
    node.step = String(step);
    node.addEventListener("change", () => onChange(node.value === "" ? null : Number(node.value)));
    node.addEventListener("input", () => onChange(node.value === "" ? null : Number(node.value)));
    if (key) this.fields[key] = node;
    return node;
  }

  _text(value, onInput, { key, placeholder = "" } = {}) {
    const node = el("input", { type: "text", class: "map-input", value: String(value ?? ""), placeholder });
    node.addEventListener("input", () => onInput(node.value));
    if (key) this.fields[key] = node;
    return node;
  }

  _checkbox(labelText, checked, onChange, key) {
    const input = el("input", { type: "checkbox", class: "map-check" });
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));
    if (key) this.fields[key] = input;
    return el("label", { class: "map-check-row" }, [input, el("span", { text: labelText })]);
  }

  /** One font for the whole canvas, then a size per piece of text. */
  _titleControls() {
    const size = (key, fallback, set) => this._number(fallback, (value) => this._update((settings) => {
      set(settings, Math.max(TEXT_SIZE_RANGE.min, Math.min(TEXT_SIZE_RANGE.max, Math.round(Number(value) || fallback))));
    }), { key, min: TEXT_SIZE_RANGE.min, max: TEXT_SIZE_RANGE.max });
    return [
      this._field("Font", this._select(
        MAP_FONTS.map((family) => ({ key: family, label: family })),
        MAP_DEFAULTS.font,
        (value) => this._update((settings) => { settings.font = value; }),
        "font",
      )),
      this._field("Title", this._text("", (value) => this._update((settings) => { settings.title = value; }), { key: "title" })),
      this._field("Title size (px)", size("titleSize", MAP_DEFAULTS.titleSize,
        (settings, value) => { settings.titleSize = value; })),
      this._checkbox("Bold title", MAP_DEFAULTS.titleBold,
        (value) => this._update((settings) => { settings.titleBold = value; }), "titleBold"),
      this._field("Title alignment", this._select(
        TITLE_ALIGNS.map((entry) => ({ key: entry.key, label: entry.label })),
        MAP_DEFAULTS.titleAlign,
        (value) => this._update((settings) => { settings.titleAlign = value; }),
        "titleAlign",
      )),
      this._field("Subtitle (optional)", this._text("", (value) => this._update((settings) => { settings.subtitle = value; }), { key: "subtitle" })),
      this._field("Subtitle size (px)", size("subtitleSize", MAP_DEFAULTS.subtitleSize,
        (settings, value) => { settings.subtitleSize = value; })),
      this._field("Credit line", this._text("", (value) => this._update((settings) => {
        settings.credit = value;
        settings.creditTouched = true;       // the user decided: keep it
      }), { key: "credit" })),
      this._field("Credit size (px)", size("creditSize", MAP_DEFAULTS.creditSize,
        (settings, value) => { settings.creditSize = value; })),
    ];
  }

  _legendControls() {
    const rowsHost = el("div", { class: "map-legend-rows" });
    this.fields.legendRows = rowsHost;
    return [
      this._checkbox("Show legend", true, (value) => this._update((settings) => { settings.legend.visible = value; }), "legendVisible"),
      this._field("Legend title", this._text("Legend", (value) => this._update((settings) => { settings.legend.title = value; }), { key: "legendTitle" })),
      this._field("Placement", this._select(
        LEGEND_PLACEMENTS.map((entry) => ({ key: entry.key, label: entry.label })),
        MAP_DEFAULTS.legend.placement,
        (value) => this._update((settings) => { settings.legend.placement = value; }),
        "legendPlacement",
      )),
      this._checkbox("Show percentages", true, (value) => this._update((settings) => { settings.legend.showPercentages = value; }), "legendPercent"),
      this._field("Legend text size (px)", this._number(MAP_DEFAULTS.legend.fontSize, (value) => this._update((settings) => {
        settings.legend.fontSize = Math.max(TEXT_SIZE_RANGE.min, Math.min(TEXT_SIZE_RANGE.max, Math.round(Number(value) || MAP_DEFAULTS.legend.fontSize)));
      }), { key: "legendFont", min: TEXT_SIZE_RANGE.min, max: TEXT_SIZE_RANGE.max })),
      el("p", { class: "map-field-hint", text: "Class names and colours are edited here or in the Clusters table — they stay in sync." }),
      rowsHost,
    ];
  }

  _scaleControls() {
    this.fields.scaleNote = el("p", { class: "map-field-hint", text: "" });
    this.fields.manualScale = el("div", { class: "map-manual-scale", hidden: true }, [
      this._field("Image width =", this._number(null, (value) => this._update((settings) => {
        settings.scaleBar.imageWidth = value;
      }), { key: "imageWidth", min: 0 }), "used when the image has no ground scale"),
      this._field("Unit", this._select(
        Object.keys(SCALE_UNITS).map((unit) => ({ key: unit, label: unit })),
        "m",
        (value) => this._update((settings) => { settings.scaleBar.imageWidthUnit = value; }),
        "imageWidthUnit",
      )),
    ]);
    return [
      this._checkbox("Show scale bar", true, (value) => this._update((settings) => { settings.scaleBar.visible = value; }), "scaleVisible"),
      this._field("Total length", this._number(null, (value) => this._update((settings) => {
        settings.scaleBar.length = value == null ? null : Math.max(0, value);
      }), { key: "scaleLength", min: 0, step: "any" }), "blank = a round length for this image"),
      this._field("Divisions", this._number(4, (value) => this._update((settings) => {
        settings.scaleBar.divisions = Math.max(1, Math.min(10, Math.round(Number(value) || 4)));
      }), { key: "scaleDivisions", min: 1, max: 10 })),
      this._field("Unit", this._select(
        Object.keys(SCALE_UNITS).map((unit) => ({ key: unit, label: unit })),
        "m",
        (value) => this._update((settings) => { settings.scaleBar.unit = value; }),
        "scaleUnit",
      )),
      this._field("Label size (px)", this._number(MAP_DEFAULTS.scaleBar.fontSize, (value) => this._update((settings) => {
        settings.scaleBar.fontSize = Math.max(TEXT_SIZE_RANGE.min, Math.min(TEXT_SIZE_RANGE.max, Math.round(Number(value) || MAP_DEFAULTS.scaleBar.fontSize)));
      }), { key: "scaleFont", min: TEXT_SIZE_RANGE.min, max: TEXT_SIZE_RANGE.max })),
      this.fields.scaleNote,
      this.fields.manualScale,
    ];
  }

  _arrowControls() {
    return [
      this._checkbox("Show north arrow", true, (value) => this._update((settings) => {
        settings.northArrow.visible = value;
        settings.northArrowTouched = true;   // the user decided: keep it
      }), "arrowVisible"),
      this._field("Style", this._select(NORTH_STYLES, "classic", (value) => this._update((settings) => { settings.northArrow.style = value; }), "arrowStyle")),
      this._field("Size (px)", this._number(MAP_DEFAULTS.northArrow.size, (value) => this._update((settings) => {
        settings.northArrow.size = Math.max(12, Math.min(160, Math.round(Number(value) || MAP_DEFAULTS.northArrow.size)));
      }), { key: "arrowSize", min: 12, max: 160 })),
      this._field("Position", this._select(CORNERS, "tr", (value) => this._update((settings) => { settings.northArrow.position = value; }), "arrowPosition")),
    ];
  }

  _color(value, onInput, key) {
    const node = el("input", { type: "color", class: "map-input map-color", value: String(value ?? "#000000") });
    node.addEventListener("input", () => onInput(node.value));
    if (key) this.fields[key] = node;
    return node;
  }

  _mapControls() {
    this.fields.coordToggle = this._checkbox("Corner coordinates", false, (value) => this._update((settings) => {
      settings.cornerCoordinates = value;
    }), "coords");
    const coordsWrap = el("div", {}, [this.fields.coordToggle]);
    this.fields.coordsWrap = coordsWrap;
    return [
      this._field("Background", this._color("#0d1115", (value) => this._update((settings) => { settings.background = value; }), "background")),
      this._checkbox("Border around the image", true, (value) => this._update((settings) => { settings.border = value; }), "border"),
      coordsWrap,
    ];
  }

  // ------------------------------------------------------------------- state
  /** Settings for the current session, kept between opens. */
  getSettings() {
    return this.settings;
  }

  isOpen() {
    return this.root != null && !this.root.hidden;
  }

  /** Compose the preview canvas from the current settings. */
  render() {
    if (!this.settings) return null;
    const image = this.image;
    if (!image) {
      setChildren(this.previewHost ?? this.root.querySelector(".map-preview-host"),
        el("p", { class: "empty-note", text: "Load or classify an image first — the composer needs pixels." }));
      this.canvas = null;
      return null;
    }
    const { canvas } = composeStudioMap({
      image, settings: this.settings, info: this.info, scale: 1, documentRef: this.doc,
    });
    this.canvas = canvas;
    this._paintPreview(canvas);
    return canvas;
  }

  _paintPreview(canvas) {
    const host = this.previewHost ?? this.root.querySelector(".map-preview-host");
    setChildren(host, canvas);
    canvas.className = "map-preview-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Map preview: ${titleFromName(this.name)}`);
    this._syncNote();
    this._renderLegendRows();
  }

  _syncNote() {
    const metres = groundWidthMeters({ info: this.info, settings: this.settings });
    const note = this.fields.scaleNote;
    const manual = this.fields.manualScale;
    if (!note || !manual) return;
    if (metres) {
      note.textContent = hasGroundScale(this.info)
        ? `Ground width ≈ ${formatLength(metres, "km")} (${formatLength(
          metres / 1000 > 1 ? 1000 : 1, metres / 1000 > 1 ? "km" : "m")}).`
        : "Using the width you entered (the API has no ground scale for this image).";
      manual.hidden = true;
      const suggested = roundScaleLength(metres, this.settings.scaleBar.unit);
      if (this.fields.scaleLength && this.settings.scaleBar.length == null) {
        this.fields.scaleLength.placeholder = `${suggested}`;
      }
    } else {
      note.textContent = "No ground scale for this image — enter its width, or the bar is labelled \"not to scale\".";
      manual.hidden = false;
    }
    if (this.fields.coordToggle) {
      const hasBox = hasGroundScale(this.info);
      this.fields.coordsWrap.hidden = !hasBox;
      this.fields.coordToggle.disabled = !hasBox;
    }
  }

  /** Legend rows: colour + name editable, synced with the Clusters table. */
  _renderLegendRows() {
    const host = this.fields.legendRows;
    if (!host || !this.settings) return;
    const rows = this.settings.legend?.rows ?? [];
    if (!rows.length) {
      setChildren(host, el("p", { class: "empty-note", text: "No classes yet — run K-Means and Classify." }));
      return;
    }
    setChildren(host, rows.map((row, index) => {
      const color = el("input", { type: "color", class: "map-legend-color", value: rgbToHex(row.color) });
      color.addEventListener("input", () => this._editLegendRow(index, { color: hexToRgb(color.value) }));
      const name = el("input", { type: "text", class: "map-legend-name", value: String(row.name ?? "") });
      name.addEventListener("input", () => this._editLegendRow(index, { name: name.value }));
      return el("div", { class: "map-legend-row" }, [
        color,
        name,
        el("span", { class: "map-legend-pct", text: percentLabel(row.percentage) }),
      ]);
    }));
  }

  _editLegendRow(index, patch) {
    const rows = this.settings.legend.rows;
    if (!rows[index]) return;
    rows[index] = { ...rows[index], ...patch };
    this.render();
    // tell the Clusters table so the two editors cannot drift apart
    this.bus?.emit?.("map:legend-rows", { rows: rows.map((row) => ({ ...row })) });
  }

  /** Called with the clusters table's rows when the user edits them. */
  setLegendRows(rows) {
    if (!this.settings || !Array.isArray(rows)) return;
    const next = rows.map((row) => ({
      cluster: row.cluster,
      name: row.name,
      color: Array.isArray(row.color) ? row.color : hexToRgb(row.color),
      percentage: Number(row.percentage) || 0,
    }));
    if (JSON.stringify(next) === JSON.stringify(this.settings.legend.rows)) return;
    this.settings.legend.rows = next;
    if (this.isOpen()) this.render();
  }

  /** Used by the Analysis menu's "Map legend" entry. */
  setLegendVisible(visible) {
    if (!this.settings) return false;
    this.settings.legend.visible = Boolean(visible);
    if (this.isOpen()) this.render();
    this.bus?.emit?.("status", { message: `Map legend ${this.settings.legend.visible ? "shown" : "hidden"}` });
    return this.settings.legend.visible;
  }

  _update(mutate) {
    if (!this.settings) return;
    mutate(this.settings);
    this.render();
  }

  // -------------------------------------------------------------------- open
  /**
   * Open the composer.
   * @param {object} options
   *   image       bitmap/canvas/<img> to draw (required for a non-empty preview)
   *   info        the image's metadata, incl. `bbox` / `meters_per_pixel`
   *   rows        legend rows ({name, color, percentage})
   *   name        source image name (the default title is its stem)
   *   source      "upload" | "satellite" | "operation:…" | …
   *   opener      element to restore focus to on close
   */
  open({ image = null, info = null, rows = [], name = "", source = "", opener = null } = {}) {
    const persisted = this.settings;
    this.image = image;
    this.info = info ?? this.info;
    this.name = name || this.name;
    this.source = source || this.source;
    if (image) this._savedLegendRows = rows.length ? rows : this._savedLegendRows;
    // remember whatever opened us, but never remember a node inside the modal
    const candidate = opener ?? this.doc.activeElement ?? null;
    this.opener = candidate && !this.root.contains(candidate) ? candidate : this.opener;
    this.settings = normalizeSettings(
      { ...(persisted ?? {}), legend: { ...(persisted?.legend ?? {}), rows: rows.length ? rows : (persisted?.legend?.rows ?? this._savedLegendRows) } },
      { name: this.name, source: this.source, info: this.info },
    );
    if (!rows.length && this.settings.legend.rows.length) this._savedLegendRows = this.settings.legend.rows;
    this.dialog.querySelector(".map-modal-sub").textContent = this.name ? `image: ${this.name}` : "";
    this._fitToViewport();
    this.root.hidden = false;
    this.dialog.setAttribute("aria-hidden", "false");
    this._applyFields();
    this.render();
    const first = this.dialog.querySelector(FOCUSABLE);
    if (first && typeof first.focus === "function") first.focus();
    this.bus?.emit?.("map:studio", { open: true });
    this.bus?.emit?.("status", { message: "Map composer open — the preview is exactly what the PNG contains" });
    return this.settings;
  }

  /** Push the settings into the controls (used on open). */
  _applyFields() {
    const s = this.settings;
    const f = this.fields;
    const set = (node, value) => { if (node) node.value = value == null ? "" : String(value); };
    set(f.font, s.font);
    set(f.title, s.title);
    set(f.titleSize, s.titleSize);
    if (f.titleBold) f.titleBold.checked = s.titleBold !== false;
    set(f.titleAlign, s.titleAlign);
    set(f.subtitle, s.subtitle);
    set(f.subtitleSize, s.subtitleSize);
    set(f.credit, s.credit);
    set(f.creditSize, s.creditSize);
    if (f.legendVisible) f.legendVisible.checked = Boolean(s.legend.visible);
    set(f.legendTitle, s.legend.title);
    set(f.legendPlacement, s.legend.placement);
    if (f.legendPercent) f.legendPercent.checked = s.legend.showPercentages !== false;
    set(f.legendFont, s.legend.fontSize);
    if (f.scaleVisible) f.scaleVisible.checked = Boolean(s.scaleBar.visible);
    set(f.scaleLength, s.scaleBar.length == null ? "" : s.scaleBar.length);
    set(f.scaleDivisions, s.scaleBar.divisions);
    set(f.scaleFont, s.scaleBar.fontSize);
    set(f.scaleUnit, s.scaleBar.unit);
    set(f.imageWidth, s.scaleBar.imageWidth == null ? "" : s.scaleBar.imageWidth);
    set(f.imageWidthUnit, s.scaleBar.imageWidthUnit);
    if (f.arrowVisible) f.arrowVisible.checked = Boolean(s.northArrow.visible);
    set(f.arrowStyle, s.northArrow.style);
    set(f.arrowSize, s.northArrow.size);
    set(f.arrowPosition, s.northArrow.position);
    set(f.background, s.background);
    if (f.border) f.border.checked = Boolean(s.border);
    if (f.coords) f.coords.checked = Boolean(s.cornerCoordinates);
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen()) return false;
    this.root.hidden = true;
    this.dialog.setAttribute("aria-hidden", "true");
    if (restoreFocus) {
      const opener = this.opener;
      if (opener && typeof opener.focus === "function" && this.doc.contains?.(opener)) opener.focus();
    }
    this.bus?.emit?.("map:studio", { open: false });
    this.bus?.emit?.("status", { message: "Map composer closed" });
    return true;
  }

  /** Escape closes; Tab cycles inside the dialog. */
  _onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...this.dialog.querySelectorAll(FOCUSABLE)]
      .filter((node) => !node.disabled && node.closest("[hidden]") == null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.doc.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ------------------------------------------------------------------ export
  composeAt(scale = 1) {
    if (!this.image) return null;
    return composeStudioMap({
      image: this.image, settings: this.settings, info: this.info, scale, documentRef: this.doc,
    });
  }

  async export(scale = 1) {
    const composed = this.composeAt(scale);
    if (!composed) return null;
    const blob = await mapCanvasToBlob(composed.canvas);
    return {
      blob,
      canvas: composed.canvas,
      width: composed.width,
      height: composed.height,
      scale,
      filename: `${titleFromName(this.settings?.title || this.name)}-map@${scale}x.png`,
    };
  }

  async download(scale = 1) {
    const result = await this.export(scale);
    if (!result) return null;
    downloadBlob(result.blob, result.filename);
    return result;
  }

  /** What is currently on the preview canvas (tests + export path). */
  getCanvas() {
    return this.canvas;
  }
}

function percentLabel(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return amount >= 10 ? `${amount.toFixed(1)}%` : `${amount.toFixed(2)}%`;
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

export { MAP_DEFAULTS };
