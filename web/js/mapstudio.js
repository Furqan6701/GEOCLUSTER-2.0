/**
 * Map studio: the composition behind the Map composer modal.
 *
 * Everything the modal shows and everything it exports is drawn by
 * `drawStudioMap` into ONE canvas — the preview is that canvas scaled to fit
 * the pane, and an export is the same drawing at 1x, 2x or 3x. There is no
 * second rendering path, so the PNG cannot disagree with the preview.
 *
 * The module is deliberately free of DOM lookups: it takes an image (bitmap,
 * canvas or <img>), a settings object and a 2-d context, which is what makes
 * it testable in Node with a stub context.
 */

/** Length units the scale bar understands, as metres per unit. */
export const SCALE_UNITS = Object.freeze({ m: 1, km: 1000, ft: 0.3048, mi: 1609.344 });

/** Corner + position choices, shared by the legend and the north arrow. */
export const CORNERS = Object.freeze([
  { key: "tl", label: "Top left" },
  { key: "tr", label: "Top right" },
  { key: "bl", label: "Bottom left" },
  { key: "br", label: "Bottom right" },
]);

export const NORTH_STYLES = Object.freeze([
  { key: "classic", label: "Classic arrow" },
  { key: "compass", label: "Compass rose" },
  { key: "triangle", label: "Plain triangle" },
]);

export const EXPORT_SCALES = Object.freeze([1, 2, 3]);

/** The credit line satellite imagery must carry by default. */
export const SATELLITE_CREDIT = "Contains modified Copernicus Sentinel data";

export const MAP_DEFAULTS = Object.freeze({
  title: "",
  subtitle: "",
  legend: Object.freeze({
    visible: true,
    title: "Legend",
    showPercentages: true,
    corner: "br",
    fontSize: 14,
  }),
  scaleBar: Object.freeze({
    visible: true,
    unit: "m",
    length: null,          // null = the round default for the ground width
    divisions: 4,
    imageWidth: null,      // "image width = X unit" when the API has no scale
    imageWidthUnit: "m",
  }),
  northArrow: Object.freeze({ visible: true, style: "classic", rotation: 0, position: "tr" }),
  credit: "",
  cornerCoordinates: false,
  border: true,
  background: "#0d1115",
});

/** "sample.jpg" → "sample" (the default map title). */
export function titleFromName(name) {
  return String(name ?? "").trim().replace(/\.[a-z0-9]{1,5}$/i, "") || "map";
}

/** Metres → the chosen unit. */
export function fromMeters(meters, unit) {
  const factor = SCALE_UNITS[unit] ?? 1;
  const value = Number(meters);
  return Number.isFinite(value) ? value / factor : 0;
}

/** The chosen unit → metres. */
export function toMeters(value, unit) {
  const factor = SCALE_UNITS[unit] ?? 1;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount * factor : 0;
}

/** Round a value to the nearest 1/2/5 × 10ⁿ — the shape scale bars use. */
export function niceRoundNumber(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const exponent = Math.floor(Math.log10(amount));
  const base = 10 ** exponent;
  const fraction = amount / base;
  const step = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  return step * base;
}

/**
 * A round total length for the scale bar: about a quarter of the ground width,
 * snapped to a 1/2/5 value in the chosen unit.
 */
export function roundScaleLength(groundWidthMeters, unit = "m") {
  const ground = Number(groundWidthMeters);
  if (!Number.isFinite(ground) || ground <= 0) return 0;
  const inUnit = fromMeters(ground, unit);
  const target = inUnit / 4;
  const rounded = niceRoundNumber(target);
  // never suggest something longer than the image itself
  return rounded > inUnit ? niceRoundNumber(inUnit) : rounded;
}

/** Compact label: "500 m", "1.5 km", "0.25 mi". */
export function formatLength(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const text = amount >= 10 ? String(Math.round(amount)) : String(Number(amount.toFixed(2)));
  return `${text} ${unit}`;
}

/**
 * The ground width in metres, from whatever the app knows:
 *   1. the API's ground-scale metadata (item 5): meters_per_pixel × width
 *   2. bbox + width, when only the box is known
 *   3. the user's "image width = X unit" entered in the composer
 * Returns null when the map genuinely has no scale.
 */
export function groundWidthMeters({ info = null, settings = null } = {}) {
  const metersPerPixel = Number(info?.meters_per_pixel);
  const width = Number(info?.width);
  if (Number.isFinite(metersPerPixel) && metersPerPixel > 0 && Number.isFinite(width) && width > 0) {
    return metersPerPixel * width;
  }
  const bbox = info?.bbox;
  if (Array.isArray(bbox) && bbox.length === 4 && Number.isFinite(width) && width > 0) {
    const [west, south, east, north] = bbox.map(Number);
    if ([west, south, east, north].every(Number.isFinite) && east > west) {
      const midLat = ((south + north) / 2) * (Math.PI / 180);
      return (east - west) * 111_320 * Math.cos(midLat);
    }
  }
  const manual = Number(settings?.scaleBar?.imageWidth);
  if (Number.isFinite(manual) && manual > 0) {
    return toMeters(manual, settings?.scaleBar?.imageWidthUnit ?? "m");
  }
  return null;
}

/** Does this image carry real ground-scale metadata? */
export function hasGroundScale(info) {
  const mpp = Number(info?.meters_per_pixel);
  if (Number.isFinite(mpp) && mpp > 0) return true;
  const bbox = info?.bbox;
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every((value) => Number.isFinite(Number(value)));
}

/** The bbox corners as "33.7000°N 73.0500°E" strings, or null without a bbox. */
export function cornerLabels(bbox, { precision = 4 } = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const lat = (value) => `${Math.abs(value).toFixed(precision)}°${value >= 0 ? "N" : "S"}`;
  const lon = (value) => `${Math.abs(value).toFixed(precision)}°${value >= 0 ? "E" : "W"}`;
  return {
    tl: `${lat(north)} ${lon(west)}`,
    tr: `${lat(north)} ${lon(east)}`,
    bl: `${lat(south)} ${lon(west)}`,
    br: `${lat(south)} ${lon(east)}`,
  };
}

/** Default settings for one image, with session-persisted values on top. */
export function normalizeSettings(saved, { name, source, info } = {}) {
  const base = {
    ...MAP_DEFAULTS,
    title: titleFromName(name),
    credit: source === "satellite" ? SATELLITE_CREDIT : "",
    cornerCoordinates: hasGroundScale(info) ? Boolean(saved?.cornerCoordinates) : false,
  };
  const merged = { ...base, ...(saved ?? {}) };
  merged.legend = { ...base.legend, ...(saved?.legend ?? {}), rows: saved?.legend?.rows ?? [] };
  merged.scaleBar = { ...base.scaleBar, ...(saved?.scaleBar ?? {}) };
  // an image wider than a kilometre on the ground reads better in km; a unit
  // the user picked (persisted in `saved`) always wins
  if (saved?.scaleBar?.unit == null) {
    const metres = groundWidthMeters({ info, settings: merged });
    if (metres != null && metres >= 1000) merged.scaleBar.unit = "km";
  }
  merged.northArrow = { ...base.northArrow, ...(saved?.northArrow ?? {}) };
  if (!Array.isArray(merged.legend.rows)) merged.legend.rows = [];
  return merged;
}

// ------------------------------------------------------------------ geometry

/** Corner → the top-left anchor of a box of the given size inside a rect. */
export function cornerAnchor(corner, rect, box, margin) {
  const right = corner === "tr" || corner === "br";
  const bottom = corner === "bl" || corner === "br";
  return {
    x: right ? rect.x + rect.width - box.width - margin : rect.x + margin,
    y: bottom ? rect.y + rect.height - box.height - margin : rect.y + margin,
  };
}

/** Layout of the frame around the image: title strip on top, credit below. */
export function frameMetrics(imageWidth, imageHeight, { scale = 1, hasSubtitle = false } = {}) {
  // the base numbers are integers and every one of them is multiplied by the
  // scale, so 2x and 3x are exactly 2x and 3x of the 1x canvas (no drift)
  const basePad = Math.max(10, Math.round(imageWidth * 0.02));
  const baseTitle = 22;
  const baseSubtitle = 14;
  const baseCredit = 12;
  const pad = basePad * scale;
  const titleSize = baseTitle * scale;
  const subtitleSize = baseSubtitle * scale;
  const creditSize = baseCredit * scale;
  // heights are computed at 1x and then multiplied, so 2x/3x are exact
  const baseTitleHeight = Math.round(basePad * 0.6 + baseTitle + (hasSubtitle ? baseSubtitle * 1.5 : 0));
  const baseFooterHeight = Math.round(basePad * 0.8 + baseCredit * 2.6);
  const titleHeight = baseTitleHeight * scale;
  const footerHeight = baseFooterHeight * scale;
  const width = Math.round(imageWidth * scale);
  const height = Math.round(imageHeight * scale);
  return {
    pad, titleSize, subtitleSize, creditSize, titleHeight, footerHeight,
    width: width + pad * 2,
    height: height + pad * 2 + titleHeight + footerHeight,
    image: { x: pad, y: pad + titleHeight, width, height },
  };
}

// ------------------------------------------------------------------ drawing

function drawText(ctx, text, x, y, { font, color, align = "left", baseline = "alphabetic", maxWidth = null }) {
  if (text == null || text === "") return;
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  const value = maxWidth == null ? String(text) : fitToWidth(ctx, String(text), maxWidth);
  ctx.fillText(value, x, y);
  ctx.restore();
}

/** Trim a string with an ellipsis until it fits (uses measureText when present). */
export function fitToWidth(ctx, text, maxWidth) {
  if (typeof ctx?.measureText !== "function" || !Number.isFinite(maxWidth) || maxWidth <= 0) return text;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(`${clipped.trimEnd()}…`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped.trimEnd()}…`;
}

/**
 * Alternating black/white scale bar with its label, or a "not to scale" bar
 * when the image has no known ground scale.
 */
export function drawScaleBar(ctx, {
  x, y, width, divisions = 4, label = "", unitSize = 12, notToScale = false,
}) {
  const height = Math.max(6, Math.round(unitSize * 0.7));
  const count = Math.max(1, Math.round(divisions));
  const segment = width / count;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.font = `${unitSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  const labelText = notToScale ? "not to scale" : label;
  ctx.fillStyle = "#e8f1f5";
  ctx.fillText(labelText, x + width / 2, y - Math.round(unitSize * 0.45));
  for (let index = 0; index < count; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? "#ffffff" : "#000000";
    ctx.fillRect(x + index * segment, y, Math.ceil(segment), height);
  }
  ctx.strokeStyle = "#e8f1f5";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
  return { x, y, width, height };
}

/** North arrow: three styles, rotated about its own centre. */
export function drawNorthArrow(ctx, { x, y, size = 36, style = "classic", rotation = 0 }) {
  const radius = size / 2;
  ctx.save();
  ctx.translate(x + radius, y + radius);
  ctx.rotate((Number(rotation) || 0) * (Math.PI / 180));

  if (style === "compass") {
    ctx.strokeStyle = "rgba(232, 241, 245, 0.9)";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, radius - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#e8f1f5";
    ctx.beginPath();
    ctx.moveTo(0, -radius + 1);
    ctx.lineTo(radius * 0.34, 0);
    ctx.lineTo(0, radius - 1);
    ctx.lineTo(-radius * 0.34, 0);
    ctx.closePath();
    ctx.fill();
  } else if (style === "triangle") {
    ctx.fillStyle = "#e8f1f5";
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius * 0.62, radius);
    ctx.lineTo(-radius * 0.62, radius);
    ctx.closePath();
    ctx.fill();
  } else {
    // classic: a half-dark arrow with a tail
    ctx.fillStyle = "#e8f1f5";
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius * 0.55, radius * 0.35);
    ctx.lineTo(0, radius * 0.12);
    ctx.lineTo(-radius * 0.55, radius * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(232, 241, 245, 0.6)";
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.moveTo(0, radius * 0.2);
    ctx.lineTo(0, radius);
    ctx.stroke();
  }
  ctx.restore();
  return { x, y, size };
}

/** One legend box: title, swatch + name + optional percentage per class. */
export function drawLegendBox(ctx, {
  x, y, rows = [], title = "Legend", unitSize = 14, showPercentages = true, background = "rgba(10, 15, 19, 0.92)",
}) {
  const pad = Math.max(6, Math.round(unitSize * 0.7));
  const rowHeight = Math.round(unitSize * 1.9);
  const swatch = Math.round(unitSize * 1.35);
  const titleHeight = Math.round(unitSize * 2.1);
  const percentWidth = showPercentages
    ? Math.max(...rows.map((row) => ctx.measureText(percentTextFor(row)).width), unitSize * 3)
    : 0;
  const nameWidth = Math.max(
    unitSize * 6,
    ...rows.map((row) => ctx.measureText(String(row.name ?? "")).width),
  );
  const width = Math.round(pad * 2 + swatch + unitSize * 0.6 + nameWidth + (showPercentages ? unitSize * 0.8 + percentWidth : 0));
  const height = titleHeight + rows.length * rowHeight + pad * 2;

  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e8f1f5";
  ctx.font = `${Math.round(unitSize * 1.05)}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(fitToWidth(ctx, title, width - pad * 2), x + pad, y + pad + titleHeight / 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.beginPath();
  ctx.moveTo(x + pad, y + pad + titleHeight);
  ctx.lineTo(x + width - pad, y + pad + titleHeight);
  ctx.stroke();

  ctx.font = `${unitSize}px system-ui, sans-serif`;
  rows.forEach((row, index) => {
    const rowTop = y + pad + titleHeight + index * rowHeight;
    const middle = rowTop + rowHeight / 2;
    const swatchY = middle - swatch / 2;
    ctx.fillStyle = `rgb(${row.color?.[0] ?? 128}, ${row.color?.[1] ?? 128}, ${row.color?.[2] ?? 128})`;
    ctx.fillRect(x + pad, swatchY, swatch, swatch);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.strokeRect(x + pad + 0.5, swatchY + 0.5, swatch - 1, swatch - 1);
    ctx.fillStyle = "#e8f1f5";
    ctx.textAlign = "left";
    const nameX = x + pad + swatch + unitSize * 0.6;
    const availWidth = width - (nameX - x) - pad - (showPercentages ? percentWidth + unitSize * 0.8 : 0);
    ctx.fillText(fitToWidth(ctx, String(row.name ?? ""), availWidth), nameX, middle);
    if (showPercentages) {
      ctx.fillStyle = "#9fb3bd";
      ctx.textAlign = "right";
      ctx.fillText(percentTextFor(row), x + width - pad, middle);
    }
  });
  ctx.restore();
  return { x, y, width, height };
}

/** "42.3%" — one decimal for big slices, two for slivers. */
export function percentTextFor(row) {
  const value = Number(row?.percentage);
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0%";
  if (value < 0.1) return "<0.1%";
  if (value < 10) return `${value.toFixed(2)}%`;
  return `${value.toFixed(1)}%`;
}

/** Legend layout preview (used by the modal to keep the rows in sync). */
export function legendBoxSize(ctx, rows, { unitSize = 14, showPercentages = true, title = "Legend" } = {}) {
  const pad = Math.max(6, Math.round(unitSize * 0.7));
  const rowHeight = Math.round(unitSize * 1.9);
  const swatch = Math.round(unitSize * 1.35);
  const titleHeight = Math.round(unitSize * 2.1);
  const percentWidth = showPercentages
    ? Math.max(...rows.map((row) => ctx.measureText(percentTextFor(row)).width), unitSize * 3)
    : 0;
  const nameWidth = Math.max(unitSize * 6, ...rows.map((row) => ctx.measureText(String(row.name ?? "")).width));
  return {
    width: Math.round(pad * 2 + swatch + unitSize * 0.6 + nameWidth + (showPercentages ? unitSize * 0.8 + percentWidth : 0)),
    height: titleHeight + rows.length * rowHeight + pad * 2,
  };
}

/**
 * Paint the whole map into `ctx`. The canvas must already be sized by
 * `composeStudioMap`/`studioSize` — this only draws.
 */
export function drawStudioMap(ctx, { image, settings, imageWidth, imageHeight, scale = 1, info = null } = {}) {
  const width = Math.round(imageWidth * scale);
  const height = Math.round(imageHeight * scale);
  const metrics = frameMetrics(imageWidth, imageHeight, { scale, hasSubtitle: Boolean(settings.subtitle) });
  const legendRows = (settings.legend?.rows ?? []).filter(Boolean);
  const metres = groundWidthMeters({ info, settings });
  const metresPerPixel = metres && width > 0 ? metres / width : null;
  const boxes = { image: metrics.image };

  // background + border
  ctx.save();
  ctx.fillStyle = settings.background || MAP_DEFAULTS.background;
  ctx.fillRect(0, 0, metrics.width, metrics.height);
  ctx.restore();

  // title + subtitle
  drawText(ctx, settings.title, metrics.pad, metrics.pad + metrics.titleSize * 0.95, {
    font: `600 ${metrics.titleSize}px system-ui, sans-serif`,
    color: "#f2f7f9",
    maxWidth: metrics.width - metrics.pad * 2,
  });
  if (settings.subtitle) {
    drawText(ctx, settings.subtitle, metrics.pad, metrics.pad + metrics.titleSize + metrics.subtitleSize * 1.5, {
      font: `${metrics.subtitleSize}px system-ui, sans-serif`,
      color: "#9fb3bd",
      maxWidth: metrics.width - metrics.pad * 2,
    });
  }

  if (image) ctx.drawImage(image, metrics.image.x, metrics.image.y, width, height);

  if (settings.border) {
    ctx.save();
    ctx.strokeStyle = "rgba(232, 241, 245, 0.5)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(metrics.image.x + 0.5, metrics.image.y + 0.5, width - 1, height - 1);
    ctx.restore();
  }

  // corner coordinates (satellite crops only)
  if (settings.cornerCoordinates && info?.bbox) {
    const labels = cornerLabels(info.bbox);
    if (labels) {
      const size = Math.max(10, Math.round(11 * scale));
      const inset = Math.round(6 * scale);
      const spots = [
        ["tl", metrics.image.x + inset, metrics.image.y + inset + size, "left", "top"],
        ["tr", metrics.image.x + width - inset, metrics.image.y + inset + size, "right", "top"],
        ["bl", metrics.image.x + inset, metrics.image.y + height - inset, "left", "bottom"],
        ["br", metrics.image.x + width - inset, metrics.image.y + height - inset, "right", "bottom"],
      ];
      for (const [key, x, y, align, baseline] of spots) {
        drawText(ctx, labels[key], x, y, {
          font: `${size}px system-ui, sans-serif`,
          color: "#e8f1f5",
          align,
          baseline,
          maxWidth: width - inset * 2,
        });
      }
    }
  }

  // legend overlay at its corner
  if (settings.legend?.visible && legendRows.length) {
    const size = legendBoxSize(ctx, legendRows, {
      unitSize: Math.round((settings.legend.fontSize ?? 14) * scale),
      showPercentages: settings.legend.showPercentages !== false,
      title: settings.legend.title,
    });
    const margin = Math.round(12 * scale);
    const anchor = cornerAnchor(settings.legend.corner ?? "br", metrics.image, size, margin);
    boxes.legend = drawLegendBox(ctx, {
      x: anchor.x, y: anchor.y, rows: legendRows, title: settings.legend.title ?? "Legend",
      unitSize: Math.round((settings.legend.fontSize ?? 14) * scale),
      showPercentages: settings.legend.showPercentages !== false,
    });
  }

  // north arrow at its corner
  if (settings.northArrow?.visible) {
    const size = Math.round(34 * scale);
    const margin = Math.round(12 * scale);
    const anchor = cornerAnchor(settings.northArrow.position ?? "tr", metrics.image, { width: size, height: size }, margin);
    boxes.northArrow = drawNorthArrow(ctx, {
      x: anchor.x, y: anchor.y, size, style: settings.northArrow.style, rotation: settings.northArrow.rotation,
    });
  }

  // scale bar + credit live in the footer strip
  const footerTop = metrics.image.y + height;
  if (settings.scaleBar?.visible) {
    const unitSize = Math.max(10, Math.round(11 * scale));
    const barHeight = Math.max(6, Math.round(unitSize * 0.7));
    const requested = settings.scaleBar.length == null
      ? roundScaleLength(metres, settings.scaleBar.unit)
      : Number(settings.scaleBar.length);
    const maxWidth = Math.max(40, Math.round(width * 0.45));
    const naturalWidth = metresPerPixel && requested > 0 ? requested / metresPerPixel : maxWidth * 0.4;
    const barWidth = Math.max(30, Math.min(maxWidth, naturalWidth));
    boxes.scaleBar = drawScaleBar(ctx, {
      x: metrics.pad,
      y: footerTop + Math.round(metrics.footerHeight * 0.55),
      width: barWidth,
      divisions: settings.scaleBar.divisions ?? 4,
      unitSize,
      label: formatLength(requested, settings.scaleBar.unit),
      notToScale: !metresPerPixel,
    });
    void barHeight;
  }
  if (settings.credit) {
    drawText(ctx, settings.credit, metrics.pad, metrics.height - Math.round(metrics.pad * 0.6), {
      font: `${metrics.creditSize}px system-ui, sans-serif`,
      color: "#8ea3ad",
      maxWidth: metrics.width - metrics.pad * 2,
    });
  }
  return boxes;
}

/** Composition size for a given scale factor. */
export function studioSize(imageWidth, imageHeight, scale = 1) {
  const metrics = frameMetrics(imageWidth, imageHeight, { scale, hasSubtitle: false });
  return { width: metrics.width, height: metrics.height };
}

/**
 * Compose the map into a fresh canvas at `scale` (1, 2 or 3 for exports).
 * Returns the canvas plus the rectangles that were drawn.
 */
export function composeStudioMap({ image, settings, scale = 1, info = null, documentRef = globalThis.document } = {}) {
  const imageWidth = Math.max(1, Math.round(image?.width ?? 0));
  const imageHeight = Math.max(1, Math.round(image?.height ?? 0));
  const metrics = frameMetrics(imageWidth, imageHeight, { scale, hasSubtitle: Boolean(settings?.subtitle) });
  const canvas = documentRef.createElement("canvas");
  canvas.width = metrics.width;
  canvas.height = metrics.height;
  const ctx = canvas.getContext("2d");
  const boxes = drawStudioMap(ctx, { image, settings, imageWidth, imageHeight, scale, info });
  return { canvas, width: canvas.width, height: canvas.height, boxes, imageWidth, imageHeight };
}
