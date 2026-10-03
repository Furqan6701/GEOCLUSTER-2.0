/**
 * Small canvas helpers shared by the Map composer.
 *
 * The composer itself (image + legend + scale bar + north arrow + title +
 * credits, all on ONE canvas) lives in `mapstudio.js`; this module keeps only
 * the pieces that are useful on their own: percentage formatting for the
 * cluster tables and the canvas → PNG Blob conversion.
 *
 * There is deliberately no second composer here any more — one canvas, one
 * renderer, so the preview and the export can never disagree.
 */

/** "12.3%" — one decimal for big slices, two for slivers, never "0%". */
export function formatPercentage(value) {
  const percentage = Number(value);
  if (!Number.isFinite(percentage)) return "—";
  if (percentage === 0) return "0%";
  if (percentage < 0.1) return "<0.1%";
  if (percentage < 10) return `${percentage.toFixed(2)}%`;
  return `${percentage.toFixed(1)}%`;
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
