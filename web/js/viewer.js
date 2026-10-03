/**
 * Canvas image viewer.
 *
 * Behaviour that matters for the GeoCluster workflow:
 *   - fit-to-view on load, including small images (satellite tiles are only
 *     260×260, so they are scaled *up* to fill the pane);
 *   - smoothing is disabled as soon as the zoom reaches 1:1 or beyond, so
 *     zoomed-in pixels are crisp nearest-neighbour squares;
 *   - wheel zoom anchored at the cursor, drag to pan, 1:1 and fit buttons;
 *   - pixel readout (x, y, value) under the cursor;
 *   - optional distance tool: two clicks measure a Euclidean pixel distance
 *     (client-side; the API has no distance endpoint).
 */

import { button, el, fmtNumber } from "./ui.js";

const MIN_SCALE = 0.02;
const MAX_SCALE = 32;

export class Viewer {
  constructor(root, { title = "Viewer", role = "viewer", bus = null } = {}) {
    this.root = root;
    this.title = title;
    this.role = role;
    this.bus = bus;
    this.image = null;
    this.description = "";
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.distanceMode = false;
    this.points = [];
    this._drag = null;
    this._pixelData = null;
    this._pixelCanvas = null;
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

    this.metaLabel = el("span", { class: "meta", text: "no image" });
    this.zoomLabel = el("span", { class: "zoom-label", text: "—" });
    this.readout = el("span", { class: "readout", text: "x: —, y: —, value: —" });

    this.fitButton = button("Fit", () => this.fit(), { size: "small", title: "Fit the image to the pane" });
    this.oneToOneButton = button("1:1", () => this.zoomTo(1), { size: "small", title: "Zoom to 100%" });
    this.zoomOutButton = button("−", () => this.zoomBy(1 / 1.25), { size: "small", title: "Zoom out" });
    this.zoomInButton = button("+", () => this.zoomBy(1.25), { size: "small", title: "Zoom in" });
    this.distanceButton = button("Distance", () => this.toggleDistance(), {
      size: "small",
      title: "Measure a pixel distance (Esc to clear)",
    });

    const viewer = el("div", { class: "viewer surface" }, [
      el("div", { class: "viewer-head" }, [
        el("h2", { text: this.title }),
        this.metaLabel,
      ]),
      this.canvasWrap,
      el("div", { class: "viewer-foot" }, [
        this.zoomOutButton,
        this.fitButton,
        this.oneToOneButton,
        this.zoomInButton,
        this.distanceButton,
        this.zoomLabel,
        this.readout,
      ]),
    ]);
    this.root.append(viewer);

    this.ctx = this.canvas.getContext("2d");
    this.canvas.addEventListener("wheel", (event) => this._onWheel(event), { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this._onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this._onPointerUp(event));
    this.canvas.addEventListener("pointerleave", () => this._clearReadout());
    this.canvas.addEventListener("dblclick", () => this.fit());

    this.render();
  }

  // ---------------------------------------------------------------- image
  async setBlob(blob, description = "") {
    const bitmap = await createImageBitmap(blob);
    this.setBitmap(bitmap, description);
  }

  setBitmap(bitmap, description = "") {
    this.image = bitmap;
    this.description = description;
    this.points = [];
    this._pixelData = null;
    this._pixelCanvas = null;
    this.fit();
    this.render();
  }

  clear() {
    this.image = null;
    this.description = "";
    this.points = [];
    this._pixelData = null;
    this.render();
  }

  get hasImage() {
    return this.image != null;
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
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoomBy(factor, { x: event.clientX, y: event.clientY });
  }

  _onPointerDown(event) {
    if (!this.image) return;
    if (this.distanceMode) {
      const point = this.imageCoords(event.clientX, event.clientY);
      this._addDistancePoint(point);
      return;
    }
    if (event.button !== 0) return;
    this.canvas.setPointerCapture(event.pointerId);
    this._drag = { x: event.clientX, y: event.clientY, offsetX: this.offsetX, offsetY: this.offsetY };
    this.canvas.classList.add("panning");
  }

  _onPointerMove(event) {
    if (this._drag) {
      this.offsetX = this._drag.offsetX + (event.clientX - this._drag.x);
      this.offsetY = this._drag.offsetY + (event.clientY - this._drag.y);
      this.render();
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
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height) {
      this._clearReadout();
      return;
    }
    const data = this._pixels();
    if (!data) return;
    const offset = (y * this.image.width + x) * 4;
    const r = data.data[offset];
    const g = data.data[offset + 1];
    const b = data.data[offset + 2];
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    this.readout.textContent = `x: ${x}, y: ${y} · rgb(${r}, ${g}, ${b}) · gray ${gray}`;
  }

  _clearReadout() {
    this.readout.textContent = "x: —, y: —, value: —";
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
      ctx.drawImage(this.image, 0, 0);
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
      ctx.fillStyle = "rgba(139, 152, 171, 0.6)";
      ctx.font = "13px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No image loaded", width / 2, height / 2);
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
      const size = `${this.image.width}×${this.image.height}`;
      this.metaLabel.textContent = this.description ? `${size} · ${this.description}` : size;
      this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
    } else {
      this.metaLabel.textContent = "no image";
      this.zoomLabel.textContent = "—";
    }
  }
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}
