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

/** The one font family every piece of canvas text is drawn with. */
export const MAP_FONTS = Object.freeze([
  "Arial", "Times New Roman", "Georgia", "Verdana", "Courier New", "Trebuchet MS",
]);

export const DEFAULT_MAP_FONT = MAP_FONTS[0];

/** Where the title block sits across the top of the map. */
export const TITLE_ALIGNS = Object.freeze([
  { key: "left", label: "Left" },
  { key: "center", label: "Center" },
  { key: "right", label: "Right" },
]);

/** Size limits shared by the controls and the clamp in normalizeSettings. */
export const TEXT_SIZE_RANGE = Object.freeze({ min: 8, max: 96 });

/**
 * Where the legend goes — item 16. Five placements sit NEXT TO the image (the
 * composed canvas grows by a band so the legend never covers a pixel of the
 * map) and four overlay it in a corner.
 *
 *   edge   "left" | "right" | "bottom" — which side of the image the band is on
 *   align  for the bottom band: "left" | "center" | "right" within the image
 */
export const LEGEND_PLACEMENTS = Object.freeze([
  { key: "outside-right", label: "Outside right", outside: true, edge: "right", align: null, corner: null },
  { key: "outside-left", label: "Outside left", outside: true, edge: "left", align: null, corner: null },
  { key: "outside-bottom-left", label: "Outside bottom left", outside: true, edge: "bottom", align: "left", corner: null },
  { key: "outside-bottom-center", label: "Outside bottom center", outside: true, edge: "bottom", align: "center", corner: null },
  { key: "outside-bottom-right", label: "Outside bottom right", outside: true, edge: "bottom", align: "right", corner: null },
  { key: "onmap-tl", label: "On map — top left", outside: false, edge: null, align: null, corner: "tl" },
  { key: "onmap-tr", label: "On map — top right", outside: false, edge: null, align: null, corner: "tr" },
  { key: "onmap-bl", label: "On map — bottom left", outside: false, edge: null, align: null, corner: "bl" },
  { key: "onmap-br", label: "On map — bottom right", outside: false, edge: null, align: null, corner: "br" },
]);

export const DEFAULT_LEGEND_PLACEMENT = "outside-right";

/** Placements stored by earlier builds keep working. */
export const LEGACY_LEGEND_PLACEMENTS = Object.freeze({ "outside-bottom": "outside-bottom-left" });

/** Where the scale bar sits across the bottom of the image (item 16). */
export const SCALE_POSITIONS = Object.freeze([
  { key: "bl", label: "Bottom left" },
  { key: "bc", label: "Center" },
  { key: "br", label: "Bottom right" },
]);

export const DEFAULT_SCALE_POSITION = "bl";

/** The placement entry for a settings object (unknown values fall back). */
export function legendPlacementOf(settings) {
  const raw = settings?.legend?.placement;
  const key = LEGACY_LEGEND_PLACEMENTS[raw] ?? raw;
  return LEGEND_PLACEMENTS.find((entry) => entry.key === key)
    ?? LEGEND_PLACEMENTS.find((entry) => entry.key === DEFAULT_LEGEND_PLACEMENT);
}

/** Gap between the image and an outside legend, in CSS px at 1x. */
export const LEGEND_MARGIN = 12;

export const MAP_DEFAULTS = Object.freeze({
  title: "",
  subtitle: "",
  font: DEFAULT_MAP_FONT,   // applies to EVERY text drawn on the canvas
  titleSize: 26,            // larger than the subtitle by default
  titleBold: true,
  titleAlign: "center",     // centred at the top by default
  subtitleSize: 14,
  creditSize: 12,
  legend: Object.freeze({
    visible: true,
    title: "Legend",
    showPercentages: true,
    placement: DEFAULT_LEGEND_PLACEMENT,   // outside the image by default
    fontSize: 14,
  }),
  scaleBar: Object.freeze({
    visible: true,         // ON for every source: exact on satellite, plain on a photo
    unit: "m",
    length: null,          // null = the round default for the ground width
    divisions: 4,          // 1..10, a label at every boundary
    fontSize: 12,
    position: DEFAULT_SCALE_POSITION,
    // "Image width on the ground = X unit" — the one entry that turns a plain
    // bar into an exact one for an image whose API metadata has no scale
    imageWidth: null,
    imageWidthUnit: "m",
  }),
  northArrow: Object.freeze({ visible: true, style: "classic", position: "tr", size: 36 }),
  // set when the user picks the arrow/credit themselves, so opening another
  // image can re-apply the source default it did not choose
  northArrowTouched: false,
  creditTouched: false,
  credit: "",
  cornerCoordinates: false,
  border: true,
  background: "#0d1115",
});

/** A family name from the Font dropdown, or the default for anything else. */
export function mapFont(font) {
  return MAP_FONTS.includes(font) ? font : DEFAULT_MAP_FONT;
}

/**
 * One CSS font shorthand for every text on the map — same family everywhere,
 * only the size/weight differ.
 */
export function fontSpec(size, { font = DEFAULT_MAP_FONT, weight = "", style = "" } = {}) {
  const px = Math.max(1, Math.round(Number(size) || 0));
  // the family list MUST be comma separated or the whole shorthand is invalid
  // and canvas silently keeps the previous font
  const prefix = [style, weight, `${px}px`].filter(Boolean).join(" ");
  return `${prefix} "${mapFont(font)}", system-ui, sans-serif`;
}

/**
 * Default text/arrow sizes derived from the image (item 16): the title is the
 * largest text, the legend text and the scale labels are about half the title,
 * and the north arrow is about 6 % of the image height. The sidebar fields
 * start at these values and stay editable inside TEXT_SIZE_RANGE.
 */
export function defaultSizes(imageWidth, imageHeight) {
  const width = Math.max(1, Number(imageWidth) || 0);
  const height = Math.max(1, Number(imageHeight) || 0);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));
  const titleSize = clamp(width * 0.032, 14, TEXT_SIZE_RANGE.max);
  const half = clamp(titleSize / 2, TEXT_SIZE_RANGE.min, TEXT_SIZE_RANGE.max);
  return {
    titleSize,
    subtitleSize: clamp(titleSize * 0.55, TEXT_SIZE_RANGE.min, TEXT_SIZE_RANGE.max),
    creditSize: clamp(titleSize * 0.45, TEXT_SIZE_RANGE.min, TEXT_SIZE_RANGE.max),
    legendFontSize: half,
    scaleFontSize: half,
    northArrowSize: clamp(height * 0.06, 12, 160),
  };
}

/**
 * The two settings that follow the IMAGE SOURCE: a satellite crop carries the
 * Copernicus credit and a north arrow, an uploaded photo carries neither. A
 * derived image (operation/classify result) inherits its ground metadata, so
 * it is treated as satellite imagery too.
 */
export function sourceDefaults(source, info = null) {
  const satellite = source === "satellite" || hasGroundScale(info);
  return {
    satellite,
    northArrowVisible: satellite,
    credit: satellite ? SATELLITE_CREDIT : "",
  };
}

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
 * A round total length for the scale bar: about a FIFTH of the ground width
 * (item 16: roughly 20 % of the image), snapped to a 1/2/5 value in the
 * chosen unit.
 */
export function roundScaleLength(groundWidthMeters, unit = "m") {
  const ground = Number(groundWidthMeters);
  if (!Number.isFinite(ground) || ground <= 0) return 0;
  const inUnit = fromMeters(ground, unit);
  const target = inUnit / 5;
  const rounded = niceRoundNumber(target);
  // never suggest something longer than the image itself
  return rounded > inUnit ? niceRoundNumber(inUnit) : rounded;
}

/** "1.5", "250", "0.25" — up to two decimals, never a trailing zero. */
export function formatNumber(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return String(Number(amount.toFixed(2)));
}

/** Default bar width for an image with no known ground scale (40 % of it). */
export const PLAIN_BAR_WIDTH_RATIO = 0.4;

/**
 * Pure scale-bar computation — no canvas, no settings object (item 16).
 *
 * Three cases, in order:
 *   1. a ground width (API metadata or the user's "image width on the ground")
 *      → an exact bar, `length` or a round ≈20 % default, one label per
 *      division boundary;
 *   2. no ground width but a total length typed by the user → the labels show
 *      exactly that value; the pixel width comes from the caller;
 *   3. neither → `plain: true`: a plain alternating bar with NO numbers, NO
 *      unit and no note. Nothing is invented.
 *
 * Labels: one per boundary, left edge first and the total last, each with the
 * alignment the bar draws it with. The unit is printed on the total only, and
 * every number is `formatNumber` (two decimals at most, no trailing zeros).
 */
export function scaleBarLayout({
  groundWidthMeters: ground = null, metersPerPixel = null, imageWidth = null,
  length = null, unit = "m", divisions = 4,
} = {}) {
  const rawDivisions = Number(divisions);
  const count = Number.isFinite(rawDivisions)
    ? Math.max(1, Math.min(10, Math.round(rawDivisions)))   // 1..10 divisions
    : MAP_DEFAULTS.scaleBar.divisions;
  let metres = Number(ground);
  if (!Number.isFinite(metres) || metres <= 0) {
    const mpp = Number(metersPerPixel);
    const pixels = Number(imageWidth);
    metres = Number.isFinite(mpp) && mpp > 0 && Number.isFinite(pixels) && pixels > 0 ? mpp * pixels : null;
  }
  if (!Number.isFinite(metres) || metres <= 0) metres = null;
  const typed = Number(length);
  const typedMetres = Number.isFinite(typed) && typed > 0 ? toMeters(typed, unit) : null;
  let totalMetres = typedMetres ?? (metres != null ? toMeters(roundScaleLength(metres, unit), unit) : null);
  // never label a bar longer than the image is wide on the ground
  if (totalMetres != null && metres != null && totalMetres > metres) totalMetres = metres;
  if (totalMetres == null || !(totalMetres > 0)) {
    return {
      plain: true, labels: [], total: null, unit: "", divisions: count,
      groundMetres: null, exact: false,
    };
  }
  const total = fromMeters(totalMetres, unit);
  const labels = [];
  for (let index = 0; index <= count; index += 1) {
    const last = index === count;
    const value = (total * index) / count;
    labels.push({
      value,
      text: last ? `${formatNumber(value)} ${unit}` : formatNumber(value),
      align: index === 0 ? "left" : last ? "right" : "center",
    });
  }
  return {
    plain: false, labels, total, unit, divisions: count,
    groundMetres: metres, exact: true,
  };
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
  const defaults = sourceDefaults(source, info);
  const base = {
    ...MAP_DEFAULTS,
    title: titleFromName(name),
    credit: defaults.credit,
    cornerCoordinates: hasGroundScale(info) ? Boolean(saved?.cornerCoordinates) : false,
  };
  const merged = { ...base, ...(saved ?? {}) };
  merged.legend = { ...base.legend, ...(saved?.legend ?? {}), rows: saved?.legend?.rows ?? [] };
  merged.scaleBar = { ...base.scaleBar, ...(saved?.scaleBar ?? {}) };
  // 1..10 divisions, a known position key, positive numbers only
  const rawDivisions = Number(merged.scaleBar.divisions);
  merged.scaleBar.divisions = Number.isFinite(rawDivisions)
    ? Math.max(1, Math.min(10, Math.round(rawDivisions)))
    : MAP_DEFAULTS.scaleBar.divisions;
  if (!SCALE_POSITIONS.some((entry) => entry.key === merged.scaleBar.position)) {
    merged.scaleBar.position = base.scaleBar.position;
  }
  if (merged.scaleBar.length != null && !(Number(merged.scaleBar.length) > 0)) merged.scaleBar.length = null;
  if (merged.scaleBar.imageWidth != null && !(Number(merged.scaleBar.imageWidth) > 0)) merged.scaleBar.imageWidth = null;
  if (!(merged.scaleBar.unit in SCALE_UNITS)) merged.scaleBar.unit = base.scaleBar.unit;
  if (!(merged.scaleBar.imageWidthUnit in SCALE_UNITS)) merged.scaleBar.imageWidthUnit = base.scaleBar.imageWidthUnit;
  // an image wider than a kilometre on the ground reads better in km; a unit
  // the user picked (persisted in `saved`) always wins
  if (saved?.scaleBar?.unit == null) {
    const metres = groundWidthMeters({ info, settings: merged });
    if (metres != null && metres >= 1000) merged.scaleBar.unit = "km";
  }
  merged.northArrow = { ...base.northArrow, ...(saved?.northArrow ?? {}) };
  // The source default applies whenever the user has not chosen for
  // themselves. A caller that hands in `visible`/`credit` without ever having
  // recorded a choice is treated as that choice (the composer's own persisted
  // settings always carry the flags, so it follows the source).
  const arrowTouched = saved?.northArrowTouched === true
    || (saved?.northArrowTouched === undefined && typeof saved?.northArrow?.visible === "boolean");
  merged.northArrowTouched = arrowTouched;
  if (!arrowTouched) merged.northArrow.visible = defaults.northArrowVisible;
  const creditTouched = saved?.creditTouched === true
    || (saved?.creditTouched === undefined && typeof saved?.credit === "string");
  merged.creditTouched = creditTouched;
  if (!creditTouched) merged.credit = defaults.credit;
  if (!Array.isArray(merged.legend.rows)) merged.legend.rows = [];
  // one font for the whole canvas, and sizes inside the control limits
  merged.font = mapFont(merged.font);
  merged.titleAlign = TITLE_ALIGNS.some((entry) => entry.key === merged.titleAlign)
    ? merged.titleAlign : base.titleAlign;
  merged.titleBold = merged.titleBold !== false;
  const clamp = (value, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(TEXT_SIZE_RANGE.min, Math.min(TEXT_SIZE_RANGE.max, Math.round(number)));
  };
  merged.titleSize = clamp(merged.titleSize, base.titleSize);
  merged.subtitleSize = clamp(merged.subtitleSize, base.subtitleSize);
  merged.creditSize = clamp(merged.creditSize, base.creditSize);
  merged.legend.fontSize = clamp(merged.legend.fontSize, base.legend.fontSize);
  if (!LEGEND_PLACEMENTS.some((entry) => entry.key === merged.legend.placement)) {
    merged.legend.placement = base.legend.placement;
  }
  merged.scaleBar.fontSize = clamp(merged.scaleBar.fontSize, base.scaleBar.fontSize);
  merged.northArrow.size = Math.max(12, Math.min(160, Math.round(Number(merged.northArrow.size) || base.northArrow.size)));
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
export function frameMetrics(imageWidth, imageHeight, {
  scale = 1, hasSubtitle = false,
  titleSize: titleSizeIn = MAP_DEFAULTS.titleSize,
  subtitleSize: subtitleSizeIn = MAP_DEFAULTS.subtitleSize,
  creditSize: creditSizeIn = MAP_DEFAULTS.creditSize,
  scaleBarSize = MAP_DEFAULTS.scaleBar.fontSize,
  outsideLegend = null,
} = {}) {
  // the base numbers are integers and every one of them is multiplied by the
  // scale, so 2x and 3x are exactly 2x and 3x of the 1x canvas (no drift).
  // The three text sizes come from the composer's own controls.
  const basePad = Math.max(10, Math.round(imageWidth * 0.02));
  const baseTitle = Math.round(Number(titleSizeIn) || MAP_DEFAULTS.titleSize);
  const baseSubtitle = Math.round(Number(subtitleSizeIn) || MAP_DEFAULTS.subtitleSize);
  const baseCredit = Math.round(Number(creditSizeIn) || MAP_DEFAULTS.creditSize);
  const baseScale = Math.round(Number(scaleBarSize) || MAP_DEFAULTS.scaleBar.fontSize);
  const pad = basePad * scale;
  const titleSize = baseTitle * scale;
  const subtitleSize = baseSubtitle * scale;
  const creditSize = baseCredit * scale;
  // heights are computed at 1x and then multiplied, so 2x/3x are exact
  const baseTitleHeight = Math.round(basePad * 0.6 + baseTitle + (hasSubtitle ? baseSubtitle * 1.5 : 0));
  // the footer carries the scale bar, the labels under it and the credit line
  const baseBarHeight = Math.max(6, Math.round(baseScale * 0.7));
  const baseFooterHeight = Math.round(
    basePad * 0.7 + baseBarHeight + baseScale * 1.9 + baseCredit * 1.9,
  );
  const titleHeight = baseTitleHeight * scale;
  const footerHeight = baseFooterHeight * scale;
  const width = Math.round(imageWidth * scale);
  const height = Math.round(imageHeight * scale);
  const gap = Math.round(LEGEND_MARGIN * scale);
  // an outside legend enlarges the canvas by its own band + a gap, whichever
  // side it sits on (item 16: left, right and three bottom placements)
  const edge = outsideLegend?.edge ?? (outsideLegend ? "right" : null);
  // the reserved area is exactly as big as the box that will be drawn, so
  // centre/right alignment lands where the box really is; the slack only makes
  // the surrounding band a little wider than the box
  const slack = Math.round((outsideLegend?.slack ?? 0) * scale);
  const bandWidth = outsideLegend && edge !== "bottom"
    ? Math.round(outsideLegend.width * scale) + gap + slack : 0;
  const bandHeight = outsideLegend && edge === "bottom"
    ? Math.round(outsideLegend.height * scale) + gap + slack : 0;
  const leftBand = edge === "left" ? bandWidth : 0;
  const rightBand = edge === "right" ? bandWidth : 0;
  const image = { x: pad + leftBand, y: pad + titleHeight, width, height };
  const boxWidth = Math.max(0, Math.round((outsideLegend?.width ?? 0) * scale));
  const boxHeight = Math.max(0, Math.round((outsideLegend?.height ?? 0) * scale));
  const align = outsideLegend?.align ?? "left";
  // the horizontal offset is computed at 1x and then multiplied, so the 2x/3x
  // canvases stay exact multiples (rounding twice would drift by a pixel)
  const baseBoxWidth = Math.max(0, Math.round(outsideLegend?.width ?? 0));
  const baseOffsetX = align === "center" ? Math.round((imageWidth - baseBoxWidth) / 2)
    : align === "right" ? imageWidth - baseBoxWidth : 0;
  const legendArea = !outsideLegend ? null
    : edge === "bottom"
      ? {
        x: image.x + baseOffsetX * scale,
        // the footer (scale bar + credit) sits between the image and the band,
        // so the legend never lands on top of the bar
        y: image.y + height + footerHeight + gap,
        width: boxWidth,
        height: boxHeight,
      }
      : {
        x: edge === "left" ? pad : image.x + width + gap,
        y: image.y + Math.max(0, Math.round((height - boxHeight) / 2)),
        width: boxWidth,
        height: boxHeight,
      };
  return {
    pad, titleSize, subtitleSize, creditSize, titleHeight, footerHeight,
    barHeight: baseBarHeight * scale,
    width: width + pad * 2 + leftBand + rightBand,
    height: height + pad * 2 + titleHeight + footerHeight + bandHeight,
    image,
    legendArea,
    legendEdge: edge,
    legendAlign: align,
    legendGap: gap,
    outsideLegend: Boolean(leftBand || rightBand || bandHeight),
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
 * Alternating black/white scale bar (item 16).
 *
 * `labels` is what `scaleBarLayout` produced: one entry per division boundary,
 * `{ text, align }`, drawn UNDER the bar at that boundary — the total carries
 * the unit. A plain bar (`labels: []`) is exactly that: black/white stripes,
 * no numbers, no unit and no note of any kind.
 */
export function drawScaleBar(ctx, {
  x, y, width, divisions = 4, labels = [], unitSize = 12, font = DEFAULT_MAP_FONT,
  color = "#e8f1f5",
}) {
  const height = Math.max(6, Math.round(unitSize * 0.7));
  const count = Math.max(1, Math.min(10, Math.round(divisions)));
  const segment = width / count;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.font = fontSpec(unitSize, { font });
  for (let index = 0; index < count; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? "#ffffff" : "#000000";
    ctx.fillRect(x + index * segment, y, Math.ceil(segment), height);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
  // one label per boundary: 0 at the left edge, the total (with its unit) at
  // the right edge, the ticks in between
  const baseline = y + height + Math.round(unitSize * 1.15);
  labels.forEach((entry, index) => {
    const align = entry?.align ?? (index === 0 ? "left" : index === count ? "right" : "center");
    const anchor = index === 0 ? x : index === count ? x + width : x + (width * index) / count;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(String(entry?.text ?? ""), Math.round(anchor), baseline);
  });
  ctx.restore();
  return { x, y, width, height, labels: labels.length };
}

/** North arrow: three styles, north-up (no rotation control any more). */
export function drawNorthArrow(ctx, { x, y, size = 36, style = "classic" }) {
  const radius = size / 2;
  ctx.save();
  ctx.translate(x + radius, y + radius);

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
  x, y, rows = [], title = "Legend", unitSize = 14, showPercentages = true,
  background = "rgba(10, 15, 19, 0.92)", font = DEFAULT_MAP_FONT,
}) {
  // ONE measurement for the preview, the reserved band and the drawn box: the
  // box is as wide as the longest class name (and the title), so nothing is
  // ever cut off or ellipsised (item 16)
  const { width, height, pad, rowHeight, swatch, titleHeight, percentWidth } =
    legendBoxSize(ctx, rows, { unitSize, showPercentages, title, font });

  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e8f1f5";
  ctx.font = fontSpec(Math.round(unitSize * 1.05), { font, weight: "600" });
  ctx.textAlign = "left";
  ctx.fillText(String(title ?? ""), x + pad, y + pad + titleHeight / 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.beginPath();
  ctx.moveTo(x + pad, y + pad + titleHeight);
  ctx.lineTo(x + width - pad, y + pad + titleHeight);
  ctx.stroke();

  ctx.font = fontSpec(unitSize, { font });
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
    ctx.fillText(String(row.name ?? ""), nameX, middle);
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

/**
 * Legend layout (used by the modal, the outside band and the box itself).
 *
 * Item 16: the box is as wide as the LONGEST class name needs — measured with
 * the very font it is drawn with — so no name is ever cut off or ellipsised
 * (the title and the percentage column are measured too).
 */
export function legendBoxSize(ctx, rows, {
  unitSize = 14, showPercentages = true, title = "Legend", font = DEFAULT_MAP_FONT,
} = {}) {
  const previousFont = ctx?.font;
  const width = (text) => (typeof ctx?.measureText === "function"
    ? ctx.measureText(String(text)).width
    : String(text).length * unitSize * 0.6);
  if (ctx?.font !== undefined) ctx.font = fontSpec(unitSize, { font });
  const pad = Math.max(6, Math.round(unitSize * 0.7));
  const rowHeight = Math.round(unitSize * 1.9);
  const swatch = Math.round(unitSize * 1.35);
  const titleHeight = Math.round(unitSize * 2.1);
  const percentWidth = showPercentages
    ? Math.max(...rows.map((row) => width(percentTextFor(row))), unitSize * 3)
    : 0;
  const nameWidth = Math.max(unitSize * 6, ...rows.map((row) => width(row.name ?? "")));
  // the title is drawn 5 % larger than the rows: measure it with its own font,
  // so a long title widens the box instead of overflowing it
  const headingFont = fontSpec(Math.round(unitSize * 1.05), { font, weight: "600" });
  if (ctx?.font !== undefined) ctx.font = headingFont;
  const headingWidth = width(title ?? "Legend");
  if (ctx?.font !== undefined && previousFont !== undefined) ctx.font = previousFont;
  const bodyWidth = Math.max(
    nameWidth, headingWidth - swatch - unitSize * 0.6,
    ...rows.map((row) => width(row.name ?? "")),
  );
  return {
    width: Math.round(pad * 2 + swatch + unitSize * 0.6 + bodyWidth + (showPercentages ? unitSize * 0.8 + percentWidth : 0)),
    height: titleHeight + rows.length * rowHeight + pad * 2,
    pad, rowHeight, swatch, titleHeight, percentWidth, nameWidth: bodyWidth,
  };
}

/**
 * Paint the whole map into `ctx`. The canvas must already be sized by
 * `composeStudioMap`/`studioSize` — this only draws.
 */
/**
 * Everything the composition needs to know BEFORE a canvas size is chosen:
 * the frame metrics (which grow when the legend sits outside) and the legend
 * box itself. `measure` is a 2D context used only for text metrics.
 */
export function studioLayout({
  settings, imageWidth, imageHeight, scale = 1, measure = null, documentRef = null,
} = {}) {
  const rows = (settings?.legend?.rows ?? []).filter(Boolean);
  const placement = legendPlacementOf(settings);
  const legendVisible = settings?.legend?.visible !== false && rows.length > 0;
  const unitSize = Math.round((settings?.legend?.fontSize ?? MAP_DEFAULTS.legend.fontSize) * scale);
  let legendBox = null;
  if (legendVisible && placement.outside) {
    const ctx = measure ?? measureContext(documentRef);
    // measured at 1x with integer sizes and multiplied by the scale in
    // frameMetrics, so 2x/3x stay EXACT multiples; the +2 px is slack so the
    // legend's own border/rounding can never be clipped by the frame
    const box = legendBoxSize(ctx, rows, {
      unitSize: Math.round(settings?.legend?.fontSize ?? MAP_DEFAULTS.legend.fontSize),
      showPercentages: settings.legend.showPercentages !== false,
      title: settings.legend.title,
      font: settings.font,
    });
    legendBox = { width: box.width, height: box.height, slack: 2 };
  }
  const metrics = frameMetrics(imageWidth, imageHeight, {
    scale,
    hasSubtitle: Boolean(settings?.subtitle),
    titleSize: settings?.titleSize,
    subtitleSize: settings?.subtitleSize,
    creditSize: settings?.creditSize,
    scaleBarSize: settings?.scaleBar?.fontSize,
    outsideLegend: legendBox
      ? { placement: placement.key, edge: placement.edge, align: placement.align, ...legendBox }
      : null,
  });
  return { metrics, placement, legendBox, legendUnit: unitSize, legendVisible, rows };
}

/** A throwaway 2D context used for text measurement (falls back to none). */
function measureContext(documentRef) {
  const canvas = documentRef?.createElement?.("canvas");
  return canvas?.getContext?.("2d") ?? null;
}

export function drawStudioMap(ctx, {
  image, settings, imageWidth, imageHeight, scale = 1, info = null, layout = null,
} = {}) {
  const width = Math.round(imageWidth * scale);
  const height = Math.round(imageHeight * scale);
  const plan = layout ?? studioLayout({
    settings, imageWidth, imageHeight, scale, measure: ctx,
  });
  const metrics = plan.metrics;
  const font = mapFont(settings.font);
  const legendRows = (settings.legend?.rows ?? []).filter(Boolean);
  const metres = groundWidthMeters({ info, settings });
  const metresPerPixel = metres && width > 0 ? metres / width : null;
  const boxes = { image: metrics.image };

  // background + border
  ctx.save();
  ctx.fillStyle = settings.background || MAP_DEFAULTS.background;
  ctx.fillRect(0, 0, metrics.width, metrics.height);
  ctx.restore();

  // title + subtitle — one alignment for the block, centred at the top by default
  const align = TITLE_ALIGNS.some((entry) => entry.key === settings.titleAlign)
    ? settings.titleAlign
    : MAP_DEFAULTS.titleAlign;
  const titleX = align === "left" ? metrics.pad
    : align === "right" ? metrics.width - metrics.pad
      : metrics.width / 2;
  drawText(ctx, settings.title, titleX, metrics.pad + metrics.titleSize * 0.95, {
    font: fontSpec(metrics.titleSize, { font, weight: settings.titleBold === false ? "" : "700" }),
    color: "#f2f7f9",
    align,
    maxWidth: metrics.width - metrics.pad * 2,
  });
  if (settings.subtitle) {
    drawText(ctx, settings.subtitle, titleX, metrics.pad + metrics.titleSize + metrics.subtitleSize * 1.5, {
      font: fontSpec(metrics.subtitleSize, { font }),
      color: "#9fb3bd",
      align,
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
          font: fontSpec(size, { font }),
          color: "#e8f1f5",
          align,
          baseline,
          maxWidth: width - inset * 2,
        });
      }
    }
  }

  // legend — outside the image (the canvas grew for it) or over a corner
  boxes.outsideLegend = metrics.outsideLegend;
  if (settings.legend?.visible && legendRows.length) {
    const legendUnit = plan.legendUnit;
    const size = legendBoxSize(ctx, legendRows, {
      unitSize: legendUnit,
      showPercentages: settings.legend.showPercentages !== false,
      title: settings.legend.title,
      font,
    });
    const outside = plan.placement.outside;
    let x;
    let y;
    if (outside) {
      // the canvas grew by exactly this band, so the box goes where it was
      // reserved — right, left or under the image, aligned as chosen
      x = metrics.legendArea.x;
      y = metrics.legendArea.y;
    } else {
      const margin = Math.round(12 * scale);
      const anchor = cornerAnchor(plan.placement.corner, metrics.image, size, margin);
      x = anchor.x;
      y = anchor.y;
    }
    boxes.legend = drawLegendBox(ctx, {
      x, y, rows: legendRows, title: settings.legend.title ?? "Legend",
      unitSize: legendUnit,
      showPercentages: settings.legend.showPercentages !== false,
      font,
      ...(outside ? { background: "rgba(10, 15, 19, 1)" } : {}),
    });
    boxes.legendOutside = outside;
  }

  // north arrow at its corner
  if (settings.northArrow?.visible) {
    const size = Math.round((settings.northArrow.size ?? MAP_DEFAULTS.northArrow.size) * scale);
    const margin = Math.round(12 * scale);
    const anchor = cornerAnchor(settings.northArrow.position ?? "tr", metrics.image, { width: size, height: size }, margin);
    boxes.northArrow = drawNorthArrow(ctx, {
      x: anchor.x, y: anchor.y, size, style: settings.northArrow.style,
    });
  }

  // scale bar + credit live in the footer strip
  const footerTop = metrics.image.y + height;
  if (settings.scaleBar?.visible) {
    const unitSize = Math.max(8, Math.round((settings.scaleBar.fontSize ?? MAP_DEFAULTS.scaleBar.fontSize) * scale));
    const layout = scaleBarLayout({
      groundWidthMeters: metres,
      metersPerPixel: metresPerPixel,
      imageWidth: width,
      length: settings.scaleBar.length,
      unit: settings.scaleBar.unit,
      divisions: settings.scaleBar.divisions,
    });
    // an exact bar is as long as the distance it labels; without a ground
    // scale it is a plain bar at 40 % of the image (no numbers, no unit)
    const barWidth = layout.plain || !metresPerPixel
      ? Math.max(30, Math.round(width * PLAIN_BAR_WIDTH_RATIO))
      : Math.max(30, Math.min(width, Math.round(toMeters(layout.total, layout.unit) / metresPerPixel)));
    const position = SCALE_POSITIONS.some((entry) => entry.key === settings.scaleBar.position)
      ? settings.scaleBar.position : DEFAULT_SCALE_POSITION;
    const barX = position === "bc" ? metrics.image.x + Math.round((width - barWidth) / 2)
      : position === "br" ? metrics.image.x + width - barWidth
        : metrics.pad;
    const barY = footerTop + Math.round((metrics.pad + metrics.barHeight) * 0.4);
    boxes.scaleBar = drawScaleBar(ctx, {
      x: barX,
      y: barY,
      width: barWidth,
      divisions: layout.divisions,
      labels: layout.labels,
      unitSize,
      font,
    });
    boxes.scaleBar.plain = layout.plain;
    boxes.scaleBar.position = position;
    boxes.scaleBar.total = layout.total;
    boxes.scaleBar.unit = layout.unit;
  }
  if (settings.credit) {
    // the credit closes the footer strip. Anchoring it to the footer (and not
    // to the canvas bottom) keeps it above a bottom legend band (item 16)
    const creditY = footerTop + metrics.footerHeight - Math.round(metrics.pad * 0.6);
    drawText(ctx, settings.credit, metrics.pad, creditY, {
      font: fontSpec(metrics.creditSize, { font }),
      color: "#8ea3ad",
      maxWidth: metrics.width - metrics.pad * 2,
    });
    boxes.credit = { x: metrics.pad, y: creditY };
  }
  return boxes;
}

/** Composition size for a given scale factor (sizes follow the settings). */
export function studioSize(imageWidth, imageHeight, scale = 1, settings = MAP_DEFAULTS, { measure = null, documentRef = null } = {}) {
  const { metrics } = studioLayout({
    settings, imageWidth, imageHeight, scale, measure, documentRef,
  });
  return { width: metrics.width, height: metrics.height };
}

/**
 * Compose the map into a fresh canvas at `scale` (1, 2 or 3 for exports).
 * Returns the canvas plus the rectangles that were drawn.
 */
export function composeStudioMap({ image, settings, scale = 1, info = null, documentRef = globalThis.document } = {}) {
  const imageWidth = Math.max(1, Math.round(image?.width ?? 0));
  const imageHeight = Math.max(1, Math.round(image?.height ?? 0));
  // measure the legend first: an outside legend changes the canvas size
  const layout = studioLayout({
    settings, imageWidth, imageHeight, scale,
    measure: measureContext(documentRef),
    documentRef,
  });
  const canvas = documentRef.createElement("canvas");
  canvas.width = layout.metrics.width;
  canvas.height = layout.metrics.height;
  const ctx = canvas.getContext("2d");
  const boxes = drawStudioMap(ctx, { image, settings, imageWidth, imageHeight, scale, info, layout });
  return {
    canvas, width: canvas.width, height: canvas.height, boxes, imageWidth, imageHeight,
    layout: layout.metrics,
  };
}
