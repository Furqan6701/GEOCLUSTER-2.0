/**
 * Colour maths shared by the frontend modules that have to agree with the
 * server pixel for pixel.
 *
 * `toGray` is the fixed-point form of OpenCV's 8-bit `COLOR_BGR2GRAY`
 * (0.299R + 0.587G + 0.114B). The API converts every colour image to gray with
 * exactly this formula before K-Means, classify and the histogram endpoint, so
 * the browser must use the same numbers — this is the ONE copy of it.
 */

/** OpenCV-compatible luminance of an (r, g, b) triple, 0..255. */
export function toGray(r, g, b) {
  return (4899 * r + 9617 * g + 1868 * b + 8192) >> 14;
}

/** `#rrggbb` for an [r, g, b] triple (clamped, rounded, never NaN). */
export function rgbToHex(color) {
  const [r, g, b] = (color ?? [0, 0, 0])
    .map((value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))));
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** [r, g, b] for a `#rrggbb` string; invalid input reads as black. */
export function hexToRgb(hex) {
  const text = String(hex ?? "").replace("#", "").trim();
  if (text.length !== 6) return [0, 0, 0];
  return [0, 2, 4].map((offset) => parseInt(text.slice(offset, offset + 2), 16) || 0);
}
