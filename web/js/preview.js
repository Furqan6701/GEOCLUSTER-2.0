/**
 * Browser-side filter preview.
 *
 * While a slider is being dragged the Result viewport shows what the operation
 * would look like, without asking the server: the current image is drawn into
 * an offscreen canvas (downscaled for big images so the maths stays fast) and
 * the operation is applied to those pixels in JavaScript. Nothing here touches
 * the network, the session or the undo history — releasing the slider sends one
 * real request and the server's exact result replaces the preview.
 *
 * The maths mirrors api/geocluster/filters.py, which is the source of truth:
 *   brightness  → clip(pixel + value, 0, 255)
 *   threshold   → cv2.threshold(…, 255, THRESH_BINARY): pixel > value ? 255 : 0
 *   meanfilter  → cv2.blur, a separable box average with BORDER_REFLECT_101
 * A preview is a small downscaled copy, so it is intentionally approximate:
 * OpenCV's 8-bit mean filter uses a fixed-point reciprocal per pass, so the
 * smoothing can differ by one grey level from the server's result. The committed
 * image is always the server's, never the preview's.
 */

/** Longest side of the preview copy. 512² is a few million pixel ops at most. */
export const PREVIEW_MAX_SIDE = 512;

export const PREVIEWABLE = Object.freeze(["brightness", "threshold", "meanfilter"]);

/** OpenCV's default border mode: gfedcb|abcdefgh|gfedcba. */
export function reflect101(index, size) {
  if (size <= 1) return 0;
  let value = index;
  // fold until inside the image; the two reflections differ at the edges
  while (value < 0 || value >= size) {
    if (value < 0) value = -value;
    else value = 2 * size - 2 - value;
  }
  return value;
}

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** clip(pixel + value, 0…255) on B, G and R, in place (alpha is untouched,
 *  exactly like api/geocluster/filters.py). */
export function applyBrightness(data, value) {
  const shift = Math.round(Number(value));
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    data[offset] = clamp255(data[offset] + shift);
    data[offset + 1] = clamp255(data[offset + 1] + shift);
    data[offset + 2] = clamp255(data[offset + 2] + shift);
  }
  // alpha (offset + 3) is deliberately left alone
  return data;
}

/** Per-channel binary threshold: > value → 255, otherwise 0. Alpha untouched. */
export function applyThreshold(data, value) {
  const limit = Math.round(Number(value));
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    data[offset] = data[offset] > limit ? 255 : 0;
    data[offset + 1] = data[offset + 1] > limit ? 255 : 0;
    data[offset + 2] = data[offset + 2] > limit ? 255 : 0;
  }
  return data;
}

/** index map for a reflected sliding window: position t ∈ [−r, size−1+r]. */
function reflectMap(size, radius) {
  const map = new Int32Array(size + 2 * radius);
  for (let t = -radius; t < size + radius; t += 1) {
    map[t + radius] = reflect101(t, size);
  }
  return map;
}

/**
 * Separable box average (cv2.blur) with reflect-101 borders, in place.
 *
 * Two 1-D passes, each rounding half up (`floor((sum + half) / k)`) like
 * OpenCV's integer path; a preview therefore stays within one grey level of
 * `cv2.blur` and a constant image averages back to itself exactly.
 */
export function applyMeanFilter(data, width, height, window) {
  const size = Math.round(Number(window));
  if (!Number.isFinite(size) || size < 3 || size % 2 === 0) return data;
  const radius = (size - 1) / 2;
  const half = Math.floor(size / 2);
  const columns = reflectMap(width, radius);
  const rows = reflectMap(height, radius);
  const horizontal = new Uint16Array(width * height * 4);

  // horizontal pass: every output pixel holds the average of its row window.
  // Channels 0–2 only: alpha is never filtered (api/geocluster/filters.py).
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let t = -radius; t <= radius; t += 1) {
        sum += data[(row + columns[t + radius]) * 4 + channel];
      }
      horizontal[row * 4 + channel] = Math.floor((sum + half) / size);
      for (let x = 1; x < width; x += 1) {
        // the window moves one to the right: column x+r enters, column x−r−1
        // leaves; both are mapped through the reflected index table
        sum += data[(row + columns[x + 2 * radius]) * 4 + channel];
        sum -= data[(row + columns[x - 1]) * 4 + channel];
        horizontal[(row + x) * 4 + channel] = Math.floor((sum + half) / size);
      }
    }
  }

  // vertical pass: average the horizontal sums down each column
  for (let x = 0; x < width; x += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      let sum = 0;
      for (let t = -radius; t <= radius; t += 1) {
        sum += horizontal[(rows[t + radius] * width + x) * 4 + channel];
      }
      data[(x) * 4 + channel] = Math.floor((sum + half) / size);
      for (let y = 1; y < height; y += 1) {
        sum += horizontal[(rows[y + 2 * radius] * width + x) * 4 + channel];
        sum -= horizontal[(rows[y - 1] * width + x) * 4 + channel];
        data[(y * width + x) * 4 + channel] = Math.floor((sum + half) / size);
      }
    }
  }
  return data;
}

/** Apply one operation's maths to RGBA pixels (in place). */
export function applyPixels(data, width, height, operation, params = {}) {
  if (operation === "brightness") return applyBrightness(data, params.value ?? 0);
  if (operation === "threshold") return applyThreshold(data, params.value ?? 0);
  if (operation === "meanfilter") return applyMeanFilter(data, width, height, params.window ?? 3);
  return data;
}

/** Copy size that keeps the aspect ratio and fits inside `maxSide`. */
export function previewSize(width, height, maxSide = PREVIEW_MAX_SIDE) {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= maxSide) return { width, height, scale: 1 };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/**
 * Render a preview of `operation` over `source` (an ImageBitmap or canvas).
 * Returns the offscreen canvas, or null when this environment cannot draw.
 */
export function renderPreviewFromSource(source, operation, params, { document: doc = globalThis.document } = {}) {
  if (!doc || !source) return null;
  const width = Number(source.width) || 0;
  const height = Number(source.height) || 0;
  if (!width || !height) return null;
  const target = previewSize(width, height);
  const canvas = doc.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, target.width, target.height);
  if (operation === "none") return canvas;
  const pixels = ctx.getImageData(0, 0, target.width, target.height);
  if (!pixels?.data) return null;
  applyPixels(pixels.data, target.width, target.height, operation, params);
  ctx.putImageData(pixels, 0, 0);
  canvas.dataset.previewScale = String(target.scale);
  return canvas;
}

/**
 * Decode `blob`, apply the operation and return a preview canvas.
 * Throws only for real problems (a decode failure); callers treat a null
 * result as "no preview available" and simply skip the live update.
 */
export async function renderPreview(blob, operation, params, options = {}) {
  const { createImageBitmap: decode = globalThis.createImageBitmap, document: doc = globalThis.document } = options;
  if (!blob || typeof decode !== "function") return null;
  const bitmap = await decode(blob);
  try {
    return renderPreviewFromSource(bitmap, operation, params, { document: doc });
  } finally {
    bitmap?.close?.();
  }
}

export const preview = { render: renderPreview, maxSide: PREVIEW_MAX_SIDE };
