/**
 * Classified-map composition (STEP 4).
 *
 * The API's classify step returns a recoloured image plus a legend
 * (`[cluster, name, colour, min, max, count, percentage, label]`). This module
 * draws that classified image and that legend onto ONE canvas, so:
 *
 *   - the Map viewport shows the classified image with its legend, exactly like
 *     a printed map, and
 *   - "Map export" writes a single PNG that already contains the legend.
 *
 * Everything is pure canvas work: no extra requests, no server rendering.
 * The legend is placed to the right of the image when there is room, otherwise
 * underneath it, so it never covers the map itself.
 */

/** Normalise whatever the classify response returned into drawable rows. */
export function legendRows(legend = []) {
  return (legend ?? []).map((entry, index) => {
    const cluster = Number(entry?.cluster ?? index + 1);
    const raw = Array.isArray(entry?.color) ? entry.color : [];
    const color = [0, 1, 2].map((i) => {
      const value = Math.round(Number(raw[i]));
      return Number.isFinite(value) ? Math.min(255, Math.max(0, value)) : 128;
    });
    const percentage = Number(entry?.percentage);
    const name = String(entry?.name ?? entry?.label ?? "").trim();
    return {
      cluster,
      name: name || `Cluster ${cluster}`,
      color,
      percentage: Number.isFinite(percentage) ? percentage : 0,
      count: Number(entry?.count ?? 0),
      min: Number.isFinite(Number(entry?.min)) ? Number(entry.min) : null,
      max: Number.isFinite(Number(entry?.max)) ? Number(entry.max) : null,
    };
  });
}

/** "12.3%" — one decimal for big slices, two for slivers, never "0%". */
export function formatPercentage(value) {
  const percentage = Number(value);
  if (!Number.isFinite(percentage)) return "—";
  if (percentage === 0) return "0%";
  if (percentage < 0.1) return "<0.1%";
  if (percentage < 10) return `${percentage.toFixed(2)}%`;
  return `${percentage.toFixed(1)}%`;
}

/** Long names are ellipsised to the available width. */
export function fitText(ctx, text, maxWidth) {
  const value = String(text ?? "");
  if (maxWidth <= 0 || typeof ctx?.measureText !== "function") return value;
  if (ctx.measureText(value).width <= maxWidth) return value;
  let clipped = value;
  while (clipped.length > 1 && ctx.measureText(`${clipped.trimEnd()}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped.trimEnd()}…`;
}

/** Sizing rules, shared by the layout maths and the tests. */
export function legendMetrics(width, height, rowCount) {
  const unit = Math.max(8, Math.min(18, Math.round(Math.min(width, height) / 40)));
  const pad = Math.max(6, Math.round(unit * 0.7));
  const rowHeight = Math.round(unit * 1.9);
  const swatch = Math.round(unit * 1.35);
  const panelWidth = Math.max(Math.round(unit * 12), Math.min(420, Math.round(width * 0.3)));
  const titleHeight = Math.round(unit * 2.1);
  const panelHeight = titleHeight + rowCount * rowHeight + pad * 2;
  // beside the image when the panel fits there and the image keeps most of the
  // width; underneath otherwise (a tall legend on a small tile, or letterbox)
  const placeRight = panelHeight + pad <= height && width >= Math.round(unit * 20);
  return { unit, pad, rowHeight, swatch, panelWidth, titleHeight, panelHeight, placeRight };
}

/**
 * Draw one legend panel with its top-left corner at (x, y).
 * Returns the height that was drawn.
 */
export function drawLegend(ctx, { x, y, width, rows, title = "Legend", unit = 14 }) {
  const pad = Math.max(6, Math.round(unit * 0.7));
  const rowHeight = Math.round(unit * 1.9);
  const swatch = Math.round(unit * 1.35);
  const titleHeight = Math.round(unit * 2.1);
  const height = titleHeight + rows.length * rowHeight + pad * 2;

  ctx.save();
  ctx.fillStyle = "rgba(10, 15, 19, 0.92)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e8f1f5";
  ctx.font = `${Math.round(unit * 1.05)}px system-ui, sans-serif`;
  ctx.fillText(fitText(ctx, title, width - pad * 2), x + pad, y + pad + titleHeight / 2);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.beginPath();
  ctx.moveTo(x + pad, y + pad + titleHeight);
  ctx.lineTo(x + width - pad, y + pad + titleHeight);
  ctx.stroke();

  ctx.font = `${unit}px system-ui, sans-serif`;
  rows.forEach((row, index) => {
    const rowTop = y + pad + titleHeight + index * rowHeight;
    const middle = rowTop + rowHeight / 2;
    const swatchY = middle - swatch / 2;
    ctx.fillStyle = `rgb(${row.color[0]}, ${row.color[1]}, ${row.color[2]})`;
    ctx.fillRect(x + pad, swatchY, swatch, swatch);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.strokeRect(x + pad + 0.5, swatchY + 0.5, swatch - 1, swatch - 1);

    const percentText = formatPercentage(row.percentage);
    ctx.fillStyle = "#e8f1f5";
    const percentWidth = ctx.measureText(percentText).width;
    const nameRight = x + width - pad - percentWidth - unit * 0.8;
    ctx.fillText(fitText(ctx, row.name, nameRight - (x + pad + swatch + unit * 0.6)),
      x + pad + swatch + unit * 0.6, middle);
    ctx.fillStyle = "#9fb3bd";
    ctx.fillText(percentText, nameRight + unit * 0.4, middle);
  });
  ctx.restore();
  return height;
}

/**
 * Compose the classified image and its legend into one canvas.
 *
 * `image` is anything drawImage accepts with width/height (bitmap, canvas,
 * <img>). Returns the canvas plus the legend's rectangle so callers (and
 * tests) can point at it.
 */
export function composeMap({
  image,
  legend = [],
  title = "Classification",
  showLegend = true,
  documentRef = document,
} = {}) {
  const imageWidth = Math.max(1, Math.round(image?.width ?? 0));
  const imageHeight = Math.max(1, Math.round(image?.height ?? 0));
  const rows = legendRows(legend);
  const show = Boolean(showLegend) && rows.length > 0;
  const metrics = legendMetrics(imageWidth, imageHeight, rows.length);

  const canvas = documentRef.createElement("canvas");
  const right = show && metrics.placeRight;
  const below = show && !metrics.placeRight;
  canvas.width = imageWidth + (right ? metrics.panelWidth + metrics.pad : 0);
  canvas.height = imageHeight + (below ? metrics.panelHeight + metrics.pad : 0);

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d1115";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (image) ctx.drawImage(image, 0, 0, imageWidth, imageHeight);

  let legendBox = null;
  if (show) {
    const x = right ? imageWidth + metrics.pad : 0;
    const y = right ? 0 : imageHeight;
    const width = right ? metrics.panelWidth : Math.max(metrics.panelWidth, Math.min(canvas.width, imageWidth));
    const height = drawLegend(ctx, { x, y, width, rows, title, unit: metrics.unit });
    legendBox = { x, y, width, height };
  }

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    imageWidth,
    imageHeight,
    rows,
    legendBox,
    legendShown: show,
  };
}

/** PNG Blob for a composed canvas, across browsers. */
export async function mapCanvasToBlob(canvas) {
  if (typeof canvas?.toBlob === "function") {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob) return blob;
  }
  if (typeof canvas?.convertToBlob === "function") return canvas.convertToBlob({ type: "image/png" });
  return null;
}

/** "classified-sample.png" — a filename that says what the export is. */
export function mapFileName(sourceName = "", extension = "png") {
  const base = String(sourceName || "map").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
  return `map-${base || "map"}.${extension}`;
}
