/**
 * Distance measurement (item 10).
 *
 * The viewer measures a Euclidean distance in *image pixels*. Everything else
 * is arithmetic on that number plus one fact the app can often supply itself:
 *
 *   - `pixelSize` — the ground length of ONE image pixel, in the chosen unit
 *     (e.g. "10 m" for a Sentinel-2 crop, or a number the user calibrates);
 *   - `scale` — the factor the API applied when it downscaled the upload
 *     (displayed = original × scale), used only to mention the distance in
 *     original-resolution pixels, and only when a downscale actually happened.
 *
 * `meters_per_pixel` (satellite crops and anything derived from them) prefills
 * the unit and the pixel size; every other image starts in pixels.
 */

export const UNITS = Object.freeze({
  px: { id: "px", label: "pixels", suffix: "px", ground: false, meters: null },
  mm: { id: "mm", label: "millimetres", suffix: "mm", ground: true, meters: 0.001 },
  cm: { id: "cm", label: "centimetres", suffix: "cm", ground: true, meters: 0.01 },
  m: { id: "m", label: "metres", suffix: "m", ground: true, meters: 1 },
  km: { id: "km", label: "kilometres", suffix: "km", ground: true, meters: 1000 },
  in: { id: "in", label: "inches", suffix: "in", ground: true, meters: 0.0254 },
  ft: { id: "ft", label: "feet", suffix: "ft", ground: true, meters: 0.3048 },
  mi: { id: "mi", label: "miles", suffix: "mi", ground: true, meters: 1609.344 },
});

/** Dropdown order: pixels first, then metric, then imperial. */
export const UNIT_ORDER = Object.freeze(["px", "mm", "cm", "m", "km", "in", "ft", "mi"]);

export function isGroundUnit(unit) {
  return Boolean(UNITS[unit]?.ground);
}

/** A ground length in metres → the chosen unit. */
export function fromMeters(meters, unit) {
  const factor = UNITS[unit]?.meters;
  const value = Number(meters);
  if (!Number.isFinite(value) || !factor) return null;
  return value / factor;
}

/** A value in the chosen unit → metres. */
export function toMeters(value, unit) {
  const factor = UNITS[unit]?.meters;
  const number = Number(value);
  if (!Number.isFinite(number) || !factor) return null;
  return number * factor;
}

/** Ground length of one image pixel in `unit`, or null when it is unknown. */
export function pixelSizeFor(info, unit) {
  const metres = Number(info?.meters_per_pixel);
  if (!isGroundUnit(unit) || !Number.isFinite(metres) || metres <= 0) return null;
  return fromMeters(metres, unit);
}

/**
 * The unit and pixel size a measurement starts from for this image: satellite
 * imagery (or anything derived from it, which keeps `meters_per_pixel`) starts
 * in metres (kilometres for a coarse mosaic); everything else in pixels.
 */
export function defaultMeasureSettings(info) {
  const metres = Number(info?.meters_per_pixel);
  if (Number.isFinite(metres) && metres > 0) {
    const unit = metres >= 1000 ? "km" : "m";
    return { unit, pixelSize: pixelSizeFor(info, unit), touched: false, satellite: true };
  }
  return { unit: "px", pixelSize: null, touched: false, satellite: false };
}

/** Format a measurement: 1234.5 → "1,234.50" (keeps small values readable). */
export function formatMeasurement(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const abs = Math.abs(number);
  const digits = abs >= 1 ? 2 : 4;
  return number.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * The one line the panel shows: "Distance: 450.20 px" (or in the chosen unit),
 * with the original-resolution pixel count only when the upload was downscaled.
 */
export function describeDistance({ pixels, unit = "px", pixelSize = null, scale = 1, info = null } = {}) {
  const count = Number(pixels);
  if (!Number.isFinite(count)) {
    return { ok: false, reason: "no-distance", line: "", primary: null, pixels: null, unit };
  }
  const meta = UNITS[unit] ?? UNITS.px;
  const ground = isGroundUnit(unit);
  const size = Number(pixelSize);
  const factor = Number(scale);
  const downscaled = Number.isFinite(factor) && factor > 0 && factor < 1;
  const originalPixels = downscaled ? count / factor : null;
  const originalNote = downscaled
    ? ` (${formatMeasurement(originalPixels)} px at the original resolution)`
    : "";

  if (ground && (!Number.isFinite(size) || size <= 0)) {
    const pixelsText = `${formatMeasurement(count)} px`;
    return {
      ok: false,
      reason: "missing-pixel-size",
      primary: pixelsText,
      unit,
      pixels: count,
      downscaled,
      originalPixels,
      original: downscaled ? { pixels: originalPixels, text: `${formatMeasurement(originalPixels)} px` } : null,
      line: `Distance: ${pixelsText} — set the pixel size to convert to ${meta.label}${originalNote}`,
    };
  }

  const value = ground ? count * size : count;
  const primary = ground ? `${formatMeasurement(value)} ${meta.suffix}` : `${formatMeasurement(count)} px`;
  return {
    ok: true,
    unit,
    pixels: count,
    value,
    pixelSize: ground ? size : null,
    scale: downscaled ? factor : 1,
    downscaled,
    originalPixels,
    original: downscaled ? { pixels: originalPixels, text: `${formatMeasurement(originalPixels)} px` } : null,
    primary,
    line: `Distance: ${primary}${originalNote}`,
    info: info ?? null,
  };
}
