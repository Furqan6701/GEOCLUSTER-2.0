/**
 * Distance units (STEP 5).
 *
 * The viewer measures a Euclidean distance in *image pixels*. Everything else
 * is arithmetic on that number plus two facts the user provides/we already
 * know:
 *
 *   - `pxPerUnit` — how many pixels span one real-world unit (the calibration
 *     the user types in, e.g. 200 px per cm);
 *   - `scale` — the factor the API applied when it downscaled the upload
 *     (displayed = original × scale), so the original-resolution distance is
 *     `pixels / scale`.
 *
 * Both are labelled in the output, because a number without its basis is
 * useless in a measurement tool.
 */

export const UNITS = Object.freeze({
  px: { id: "px", label: "pixels", suffix: "px", perUnit: null },
  mm: { id: "mm", label: "millimetres", suffix: "mm", perUnit: "px/mm" },
  cm: { id: "cm", label: "centimetres", suffix: "cm", perUnit: "px/cm" },
  in: { id: "in", label: "inches", suffix: "in", perUnit: "px/in" },
});

/** Format a measurement: 1234.5 → "1,234.50" (keeps small values readable). */
export function formatMeasurement(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const abs = Math.abs(number);
  const digits = abs >= 1 ? 2 : 4;
  return number.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Convert a pixel distance into the chosen unit. `pxPerUnit` is required for real units. */
export function convertPixels(pixels, { unit = "px", pxPerUnit = null } = {}) {
  const distance = Number(pixels);
  if (!Number.isFinite(distance)) return null;
  if (unit === "px") return { unit: "px", value: distance, basis: "image pixels" };
  const per = Number(pxPerUnit);
  if (!Number.isFinite(per) || per <= 0) return null;
  return { unit, value: distance / per, basis: `${per} ${UNITS[unit]?.perUnit ?? "px/unit"}` };
}

/**
 * Everything the UI needs for one measurement, labelled:
 *
 *   primary   — in the chosen unit, on the image as it is displayed;
 *   original  — the same distance at the upload's original resolution
 *               (`pixels / scale`) *only when the image was downscaled*;
 *   lines     — ready-to-show sentences that say which is which.
 */
export function describeDistance({ pixels, unit = "px", pxPerUnit = null, scale = 1, info = null } = {}) {
  const converted = convertPixels(pixels, { unit, pxPerUnit });
  const pixelsText = `${formatMeasurement(pixels)} px`;
  if (!converted) {
    return {
      ok: false,
      reason: "missing-calibration",
      lines: [`${pixelsText} (set pixels per unit to convert to ${UNITS[unit]?.label ?? unit})`],
      primary: pixelsText,
      original: null,
      pixels,
      unit,
    };
  }
  const suffix = UNITS[unit]?.suffix ?? unit;
  const primary = unit === "px" ? pixelsText : `${formatMeasurement(converted.value)} ${suffix}`;

  const factor = Number(scale);
  const downscaled = Number.isFinite(factor) && factor > 0 && factor < 1;
  const originalPixels = downscaled ? Number(pixels) / factor : null;
  const originalConverted = downscaled
    ? convertPixels(originalPixels, { unit, pxPerUnit })
    : null;
  const original = downscaled
    ? {
      pixels: originalPixels,
      text: originalConverted
        ? `${formatMeasurement(originalConverted.value)} ${suffix}`
        : `${formatMeasurement(originalPixels)} px`,
      width: info?.original_width ?? null,
      height: info?.original_height ?? null,
    }
    : null;

  const lines = [`${primary} on screen (${converted.basis})`];
  if (downscaled) {
    const size = original.width && original.height
      ? ` at the original ${original.width}×${original.height} px`
      : " at the original resolution";
    lines.push(unit === "px"
      ? `${formatMeasurement(originalPixels)} px${size} (upload downscaled ×${factor})`
      : `${original.text}${size} (upload downscaled ×${factor})`);
  } else if (unit === "px") {
    lines.push(`${formatMeasurement(pixels)} px — the image was not downscaled on upload`);
  } else {
    lines.push(`${pixelsText} — the image was not downscaled on upload`);
  }
  return {
    ok: true, pixels, unit, scale: downscaled ? factor : 1,
    primary, original, lines,
    displayPixels: Number(pixels),
    originalPixels,
    downscaled,
  };
}

/** "px/cm", "px/in" — the label for the calibration input. */
export function unitRateLabel(unit = "px") {
  return UNITS[unit]?.perUnit ?? "";
}
