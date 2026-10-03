/**
 * Canvas image viewer — a real image-processing viewport, not a dashboard card.
 *
 * Behaviour that matters for the GeoCluster workflow:
 *   - fit-to-view on load, including small images (satellite tiles are only
 *     260×260, so they are scaled *up* to fill the pane);
 *   - smoothing is disabled as soon as the zoom reaches 1:1 or beyond, so
 *     zoomed-in pixels are crisp nearest-neighbour squares;
 *   - wheel zoom anchored at the cursor, drag to pan, 1:1 and fit buttons;
 *   - pixel readout (x, y, rgb, gray) under the cursor;
 *   - optional distance tool: two clicks measure a Euclidean pixel distance
 *     (client-side; the API has no distance endpoint);
 *   - optional mirroring: when two viewers are synchronised, camera changes
 *     are applied to the partner viewer.
 *
 * The viewport (the dark pane) is distinct from the image (the framed
 * rectangle drawn inside it). The zoom label, the cursor readout and the tool
 * badges in the header make viewport / image / zoom / tool state obvious.
 */

import { button, el, fmtNumber, icon } from "./ui.js";
import { humanizeError } from "./errors.js";

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

export class Viewer {
  constructor(root, { title = "Viewer", role = "viewer", bus = null, placeholder = "", footerExtras = [] } = {}) {
    this.root = root;
    this.title = title;
    this.placeholder = placeholder || `No image loaded — ${title} viewport`;
    this.role = role;
    this.bus = bus;
    this.image = null;
    this.name = "";
    this.description = "";
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.distanceMode = false;
    this.points = [];
    this.panEnabled = true;
    this.pixelReadout = true;
    this.footerExtras = footerExtras ?? [];
    this.mirror = null;          // partner viewer when synchronised
    this.syncEnabled = false;
    this.active = false;
    this._drag = null;
    this._pixelData = null;
    this._pixelCanvas = null;
    this._applyingMirror = false;
    /** Offscreen canvas showing an uncommitted filter preview (null = none). */
    this.previewCanvas = null;
    this._build();

    this._onResize = () => this.render();
    this._resizeObserver = new ResizeObserver(this._onResize);
    this._resizeObserver.observe(this.canvasWrap);

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.distanceMode) this.clearDistance();
    });
  }

  // ------------------------------------------------------------------- DOM
  _build() {
    this.canvas = el("canvas", { class: "viewer-canvas", "aria-label": `${this.role} image` });
    this.canvasWrap = el("div", { class: "viewer-canvas-wrap" }, this.canvas);

    this.nameLabel = el("span", { class: "viewer-name", text: "no image" });
    this.metaLabel = el("span", { class: "meta", text: "—" });
    this.modeBadge = el("span", { class: "badge viewer-mode", text: "Pixel" });
    this.zoomLabel = el("span", { class: "zoom-label", text: "—" });
    this.previewBadge = el("span", { class: "badge viewer-preview", text: "preview", hidden: true });
    this.readout = el("span", { class: "readout", text: "x: —, y: —, value: —" });

    this.fitButton = button("Fit", () => this.fit(), { size: "small", title: "Fit the image to the pane" });
    this.oneToOneButton = button("1:1", () => this.zoomTo(1), { size: "small", title: "Zoom to 100%" });
    this.zoomOutButton = button("−", () => this.zoomBy(1 / 1.25), { size: "small", title: "Zoom out" });
    this.zoomInButton = button("+", () => this.zoomBy(1.25), { size: "small", title: "Zoom in" });
    this.distanceButton = button("Distance", () => this.toggleDistance(), {
      size: "small",
      title: "Measure a pixel distance (Esc to clear)",
    });
    this.distanceButton.prepend(icon("measure", { size: 11 }));

    const viewer = el("div", { class: "viewer" }, [
      el("div", { class: "viewer-head" }, [
        el("h2", { text: this.title }),
        this.nameLabel,
        this.modeBadge,
        this.previewBadge,
        this.metaLabel,
      ]),
      this.canvasWrap,
      el("div", { class: "viewer-foot" }, [
        this.zoomOutButton,
        this.fitButton,
        this.oneToOneButton,
        this.zoomInButton,
        this.distanceButton,
        ...this.footerExtras,
        this.zoomLabel,
        this.readout,
      ]),
    ]);
    this.node = viewer;
    this.root.append(viewer);

    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("wheel", (event) => this._onWheel(event), { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this._onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this._onPointerUp(event));
    this.canvas.addEventListener("pointerleave", () => this._clearReadout());
    this.canvas.addEventListener("dblclick", () => this.fit());
    this.root.addEventListener("pointerdown", () => this.setActive(true));

    this._updateLabels();
    this.render();
  }

  // ------------------------------------------------------------- activation
  setActive(value) {
    const next = Boolean(value);
    if (next === this.active) return;
    this.active = next;
    this.node.classList.toggle("active", next);
    if (next) this.bus?.emit("viewer:active", { role: this.role, viewer: this });
  }

  // ------------------------------------------------------------------- tools
  setPanEnabled(enabled) {
    this.panEnabled = Boolean(enabled);
    this.canvasWrap.classList.toggle("tool-pan-off", !this.panEnabled);
    if (!this.panEnabled) {
      this._drag = null;
      this.canvas.classList.remove("panning");
    } else {
      this.canvasWrap.classList.remove("tool-pan-off");
    }
    this._updateModeBadge();
  }

  setPixelReadout(enabled) {
    this.pixelReadout = Boolean(enabled);
    this.canvasWrap.classList.toggle("tool-pixel-off", !this.pixelReadout);
    if (!this.pixelReadout) this._clearReadout();
    this._updateModeBadge();
  }

  /** Mirror camera changes to the partner viewer (used by the Sync control). */
  setMirror(partner, enabled = true) {
    this.mirror = partner;
    this.syncEnabled = Boolean(enabled) && Boolean(partner);
  }

  _updateModeBadge() {
    const mode = this.distanceMode ? "Measure" : this.pixelReadout ? "Pixel" : this.panEnabled ? "Pan" : "View";
    this.modeBadge.textContent = mode;
    this.modeBadge.className = `badge viewer-mode ${this.distanceMode ? "warn" : ""}`.trim();
  }

  // ---------------------------------------------------------------- image
  async setBlob(blob, description = "") {
    const bitmap = await createImageBitmap(blob);
    this.setBitmap(bitmap, description);
  }

  /** Load a blob and report load failures through the UI (never throw at boot). */
  async loadBlob(blob, { name = "", description = "" } = {}) {
    try {
      const bitmap = await createImageBitmap(blob);
      this.setBitmap(bitmap, description);
      this.setName(name);
      return true;
    } catch (error) {
      this.clear();
      this.bus?.emit("viewer:error", { role: this.role, error });
      this.readout.textContent = `could not display the image: ${humanizeError(error)}`;
      return false;
    }
  }

  setBitmap(bitmap, description = "") {
    this.image = bitmap;
    this.description = description;
    this.points = [];
    this._pixelData = null;
    this._pixelCanvas = null;
    // a committed image always supersedes an uncommitted preview
    this.previewCanvas = null;
    this.previewBadge.hidden = true;
    this.fit();
    this.render();
  }

  setName(name) {
    this.name = name ? String(name) : "";
    this._updateLabels();
  }

  clear() {
    this.image = null;
    this.name = "";
    this.description = "";
    this.points = [];
    this._pixelData = null;
    this._pixelCanvas = null;
    this.previewCanvas = null;
    this.previewBadge.hidden = true;
    this.render();
  }

  /**
   * Show an uncommitted preview (a canvas from js/preview.js) over the current
   * image. The camera, labels and pixel readout stay as they are: this only
   * changes the pixels drawn, and `clearPreview` puts the real image back.
   */
  setPreviewCanvas(canvas, operation = "") {
    if (!canvas || !this.image) return false;
    this.previewCanvas = canvas;
    this.previewBadge.textContent = operation ? `preview · ${operation}` : "preview";
    this.previewBadge.hidden = false;
    this._pixelData = null;
    this.render();
    return true;
  }

  clearPreview() {
    if (!this.previewCanvas) return false;
    this.previewCanvas = null;
    this.previewBadge.hidden = true;
    this.render();
    return true;
  }

  get hasPreview() {
    return this.previewCanvas != null;
  }

  get hasImage() {
    return this.image != null;
  }

  /** Camera state (zoom + pan) — the unit that synchronised viewers share. */
  camera() {
    return { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY };
  }

  applyCamera(camera, { render = true } = {}) {
    if (!camera) return;
    this._applyingMirror = true;
    this.scale = clamp(camera.scale, MIN_SCALE, MAX_SCALE);
    this.offsetX = camera.offsetX;
    this.offsetY = camera.offsetY;
    if (render) this.render();
    this._applyingMirror = false;
    this._announceCamera();
  }

  _announceCamera() {
    this.bus?.emit("viewer:camera", { role: this.role, ...this.camera() });
  }

  _mirrorCamera() {
    if (!this.syncEnabled || !this.mirror || this._applyingMirror) return;
    this.mirror.applyCamera(this.camera());
  }

  // --------------------------------------------------------------- camera
  fit() {
    const width = this.canvasWrap.clientWidth || 1;
    const height = this.canvasWrap.clientHeight || 1;
    if (!this.image) {
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.render();
      return;
    }
    const scale = Math.min(width / this.image.width, height / this.image.height);
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this._center();
    this.render();
    this._mirrorCamera();
    this._announceCamera();
  }

  zoomTo(scale, anchorClient = null) {
    if (!this.image) return;
    const next = clamp(scale, MIN_SCALE, MAX_SCALE);
    if (!anchorClient) {
      const center = this._canvasCenter();
      this._zoomAround(next, center.x, center.y);
    } else {
      const rect = this.canvas.getBoundingClientRect();
      this._zoomAround(next, anchorClient.x - rect.left, anchorClient.y - rect.top);
    }
    this.render();
    this._mirrorCamera();
    this._announceCamera();
  }

  zoomBy(factor, anchorClient = null) {
    this.zoomTo(this.scale * factor, anchorClient);
  }

  _zoomAround(nextScale, paneX, paneY) {
    const imageX = (paneX - this.offsetX) / this.scale;
    const imageY = (paneY - this.offsetY) / this.scale;
    this.scale = nextScale;
    this.offsetX = paneX - imageX * nextScale;
    this.offsetY = paneY - imageY * nextScale;
  }

  _center() {
    const width = this.canvasWrap.clientWidth || 1;
    const height = this.canvasWrap.clientHeight || 1;
    this.offsetX = (width - this.image.width * this.scale) / 2;
    this.offsetY = (height - this.image.height * this.scale) / 2;
  }

  _canvasCenter() {
    return { x: (this.canvasWrap.clientWidth || 1) / 2, y: (this.canvasWrap.clientHeight || 1) / 2 };
  }

  imageCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const paneX = clientX - rect.left;
    const paneY = clientY - rect.top;
    return { x: (paneX - this.offsetX) / this.scale, y: (paneY - this.offsetY) / this.scale };
  }

  // ------------------------------------------------------------- pointing
  _onWheel(event) {
    if (!this.image) return;
    event.preventDefault();
    this.setActive(true);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoomBy(factor, { x: event.clientX, y: event.clientY });
  }

  _onPointerDown(event) {
    this.setActive(true);
    if (!this.image) return;
    if (this.distanceMode) {
      const point = this.imageCoords(event.clientX, event.clientY);
      this._addDistancePoint(point);
      return;
    }
    if (event.button !== 0 || !this.panEnabled) return;
    this.canvas.setPointerCapture(event.pointerId);
    this._drag = { x: event.clientX, y: event.clientY, offsetX: this.offsetX, offsetY: this.offsetY };
    this.canvas.classList.add("panning");
  }

  _onPointerMove(event) {
    if (this._drag) {
      this.offsetX = this._drag.offsetX + (event.clientX - this._drag.x);
      this.offsetY = this._drag.offsetY + (event.clientY - this._drag.y);
      this.render();
      this._mirrorCamera();
      this._announceCamera();
      return;
    }
    if (!this.image) return;
    const point = this.imageCoords(event.clientX, event.clientY);
    this._updateReadout(point);
  }

  _onPointerUp(event) {
    if (!this._drag) return;
    this._drag = null;
    this.canvas.classList.remove("panning");
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  // ------------------------------------------------------------ distance
  toggleDistance(force = null) {
    const next = force == null ? !this.distanceMode : Boolean(force);
    this.distanceMode = next;
    this.points = [];
    this.canvas.classList.toggle("distance-mode", next);
    this.distanceButton.classList.toggle("primary", next);
    this.distanceButton.textContent = next ? "Distance ●" : "Distance";
    this.distanceButton.prepend(icon("measure", { size: 11 }));
    this._updateModeBadge();
    this.bus?.emit("viewer:distance-mode", { role: this.role, enabled: next });
    this.render();
    return next;
  }

  _addDistancePoint(point) {
    if (this.points.length >= 2) this.points = [];
    this.points.push(point);
    if (this.points.length === 2) {
      const [a, b] = this.points;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      this.readout.textContent = `distance: ${fmtNumber(distance, 2)} px`;
      this.bus?.emit("viewer:distance", {
        role: this.role,
        points: [a, b],
        distance,
        text: `Distance ${fmtNumber(distance, 2)} px  (from ${Math.round(a.x)}, ${Math.round(a.y)} to ${Math.round(b.x)}, ${Math.round(b.y)})`,
      });
    }
    this.render();
  }

  clearDistance() {
    this.points = [];
    this.render();
  }

  // -------------------------------------------------------------- reading
  _updateReadout(point) {
    if (!this.image) return;
    if (this.previewCanvas) {
      // the preview is a downscaled copy: its pixels are not the image's
      this.readout.textContent = "preview — release the slider to apply";
      return;
    }
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height) {
      this._clearReadout();
      this.bus?.emit("viewer:cursor", { role: this.role, inside: false });
      return;
    }
    const data = this._pixels();
    if (!data) return;
    const offset = (y * this.image.width + x) * 4;
    const r = data.data[offset];
    const g = data.data[offset + 1];
    const b = data.data[offset + 2];
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const value = { role: this.role, inside: true, x, y, r, g, b, gray };
    this.bus?.emit("viewer:cursor", value);
    if (!this.pixelReadout) return;
    this.readout.textContent = `x: ${x}, y: ${y} · rgb(${r}, ${g}, ${b}) · gray ${gray}`;
  }

  _clearReadout() {
    this.readout.textContent = "x: —, y: —, value: —";
    this.bus?.emit("viewer:cursor", { role: this.role, inside: false });
  }

  _pixels() {
    if (!this.image) return null;
    if (!this._pixelData) {
      const canvas = this._pixelCanvas ?? document.createElement("canvas");
      canvas.width = this.image.width;
      canvas.height = this.image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(this.image, 0, 0);
      this._pixelCanvas = canvas;
      this._pixelData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    return this._pixelData;
  }

  // -------------------------------------------------------------- drawing
  render() {
    if (!this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvasWrap.clientWidth || 1;
    const height = this.canvasWrap.clientHeight || 1;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    this._drawBackdrop(ctx, width, height);

    if (this.image) {
      ctx.save();
      ctx.translate(this.offsetX, this.offsetY);
      ctx.scale(this.scale, this.scale);
      // nearest neighbour once we reach 1:1 or beyond — crisp pixels when
      // zoomed in, smooth only while downscaling
      ctx.imageSmoothingEnabled = this.scale < 1;
      ctx.imageSmoothingQuality = "high";
      if (this.previewCanvas) {
        // the preview copy is smaller for big images: stretch it over the
        // committed image's rectangle so the framing never changes
        ctx.drawImage(this.previewCanvas, 0, 0, this.image.width, this.image.height);
      } else {
        ctx.drawImage(this.image, 0, 0);
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(120, 140, 170, 0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(this.offsetX - 0.5, this.offsetY - 0.5, this.image.width * this.scale + 1, this.image.height * this.scale + 1);
    }

    this._drawDistance(ctx);
    this._updateLabels();
  }

  _drawBackdrop(ctx, width, height) {
    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, width, height);
    if (!this.image) {
      // subtle grid so an empty viewport still reads as an image pane
      ctx.strokeStyle = "rgba(34, 41, 57, 0.55)";
      ctx.lineWidth = 1;
      for (let x = 0.5; x < width; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0.5; y < height; y += 32) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(139, 152, 171, 0.65)";
      ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      const lines = String(this.placeholder).split("\n");
      const lineHeight = 18;
      const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, index) => {
        ctx.fillText(line, width / 2, startY + index * lineHeight);
      });
    }
  }

  _drawDistance(ctx) {
    if (this.points.length === 0) return;
    const toPane = (point) => ({
      x: this.offsetX + point.x * this.scale,
      y: this.offsetY + point.y * this.scale,
    });
    const pane = this.points.map(toPane);
    ctx.save();
    ctx.strokeStyle = "#35d0ba";
    ctx.fillStyle = "#35d0ba";
    ctx.lineWidth = 1.5;
    for (const point of pane) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (pane.length === 2) {
      ctx.beginPath();
      ctx.moveTo(pane[0].x, pane[0].y);
      ctx.lineTo(pane[1].x, pane[1].y);
      ctx.stroke();
      const [a, b] = this.points;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const midX = (pane[0].x + pane[1].x) / 2;
      const midY = (pane[0].y + pane[1].y) / 2;
      const label = `${fmtNumber(distance, 1)} px`;
      ctx.font = "12px 'Cascadia Mono', Consolas, monospace";
      const padding = 5;
      const width = ctx.measureText(label).width + padding * 2;
      ctx.fillStyle = "rgba(5, 7, 11, 0.85)";
      ctx.fillRect(midX - width / 2, midY - 22, width, 18);
      ctx.fillStyle = "#8ff5e4";
      ctx.textAlign = "center";
      ctx.fillText(label, midX, midY - 9);
    }
    ctx.restore();
  }

  _updateLabels() {
    if (this.image) {
      const meta = `${this.image.width} × ${this.image.height} px${this.description ? ` · ${this.description}` : ""}`;
      const name = this.name || this.description || "image";
      this.metaLabel.textContent = meta;
      this.metaLabel.title = meta;              // full text when truncated
      this.nameLabel.textContent = name;
      this.nameLabel.title = name;
      this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
      this.zoomLabel.title = `Zoom ${Math.round(this.scale * 100)}% (image pixels × ${this.scale.toFixed(3)})`;
    } else {
      this.metaLabel.textContent = "—";
      this.metaLabel.title = "";
      this.nameLabel.textContent = "no image";
      this.nameLabel.title = "";
      this.zoomLabel.textContent = "—";
      this.zoomLabel.title = "";
    }
    this._updateModeBadge();
  }
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
