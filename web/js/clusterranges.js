/**
 * Classification ranges (item 11) — the pure maths behind the editor.
 *
 * A classification is a set of ranges over the 0..255 intensity axis that are
 * ALWAYS contiguous: no gaps, no overlaps, every class at least one value wide.
 * The first class therefore starts at 0 and the last one ends at 255 — both
 * locked, both shown read-only — and editing one boundary moves exactly one
 * neighbour:
 *
 *     max(i) = v   ⇒   min(i+1) = v + 1
 *     min(i) = v   ⇒   max(i-1) = v - 1
 *
 * Nothing here touches the DOM or the API: the panel renders what these
 * functions return, so the same rules can be unit-tested directly.
 */

export const CHANNEL_MIN = 0;
export const CHANNEL_MAX = 255;
export const CHANNEL_VALUES = CHANNEL_MAX - CHANNEL_MIN + 1; // 256

/**
 * OpenCV's 8-bit `COLOR_BGR2GRAY` (the API converts to gray before K-Means and
 * classify): the fixed-point form of 0.299R + 0.587G + 0.114B, so the browser's
 * live preview matches the server's committed image.
 */
export function toGray(r, g, b) {
  return (4899 * r + 9617 * g + 1868 * b + 8192) >> 14;
}

/** A shallow copy of the entry list (entries are `{cluster, min, max, …}`). */
export function cloneEntries(entries) {
  return (entries ?? []).map((entry) => ({ ...entry }));
}

/**
 * A typed value as a number, or null when it is not one yet: an empty field
 * (or whitespace) means "still typing", not "zero".
 */
function parseEditValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function clampInt(value, low, high) {
  const parsed = parseEditValue(value);
  if (parsed == null) return low;
  return Math.max(low, Math.min(high, Math.round(parsed)));
}

/**
 * Force a set of ranges to be contiguous, ordered and at least one value wide.
 * Used on whatever the server (or a saved editor) hands us, so the invariants
 * hold before the first edit.
 */
export function normalizeEntries(entries) {
  const source = (entries ?? [])
    .map((entry, index) => ({
      ...entry,
      cluster: Number.isFinite(Number(entry?.cluster)) ? Number(entry.cluster) : index,
    }))
    .sort((a, b) => a.cluster - b.cluster);
  const count = source.length;
  if (!count) return [];
  const out = [];
  let cursor = CHANNEL_MIN;
  source.forEach((entry, index) => {
    const min = index === 0 ? CHANNEL_MIN : cursor;
    // the last class owns everything that is left, so 255 is always covered
    const max = index === count - 1
      ? CHANNEL_MAX
      : Math.max(min, Math.min(CHANNEL_MAX - (count - 1 - index), clampInt(entry.max, min, CHANNEL_MAX)));
    out.push({ ...entry, min, max });
    cursor = max + 1;
  });
  return out;
}

/**
 * An even split into `k` contiguous ranges — the editor's starting point and
 * what "Reset ranges" falls back to. Mirrors the API's
 * `calculate_default_ranges` (last bucket ends exactly at 255).
 */
export function evenRanges(k) {
  const count = Math.max(1, Math.round(Number(k) || 0));
  const step = CHANNEL_VALUES / count;
  const out = [];
  let cursor = CHANNEL_MIN;
  for (let index = 0; index < count; index += 1) {
    const max = index === count - 1
      ? CHANNEL_MAX
      : Math.min(CHANNEL_MAX, Math.round((index + 1) * step) - 1);
    out.push({ cluster: index, min: cursor, max });
    cursor = max + 1;
  }
  return out;
}

/** True when `index` is the first class (its Min is locked at 0). */
export function isMinLocked(entries, index) {
  return index <= 0;
}

/** True when `index` is the last class (its Max is locked at 255). */
export function isMaxLocked(entries, index) {
  return index >= (entries?.length ?? 0) - 1;
}

/** The boundaries between neighbouring classes: max(0), max(1), … (no 255). */
export function boundaries(entries) {
  return (entries ?? []).slice(0, -1).map((entry) => entry.max);
}

/**
 * The value a Max MAY be set to, so that the next class keeps one value:
 * `min(self) … max(next) − 1`. The last class's Max is locked at 255.
 */
export function maxEditBounds(entries, index) {
  const current = entries[index];
  if (!current) return { low: CHANNEL_MIN, high: CHANNEL_MAX, locked: true };
  if (isMaxLocked(entries, index)) return { low: CHANNEL_MAX, high: CHANNEL_MAX, locked: true };
  return { low: current.min, high: entries[index + 1].max - 1, locked: false };
}

/**
 * The value a Min MAY be set to, so that the previous class keeps one value:
 * `min(prev) + 1 … max(self)`. The first class's Min is locked at 0.
 */
export function minEditBounds(entries, index) {
  const current = entries[index];
  if (!current) return { low: CHANNEL_MIN, high: CHANNEL_MAX, locked: true };
  if (isMinLocked(entries, index)) return { low: CHANNEL_MIN, high: CHANNEL_MIN, locked: true };
  return { low: entries[index - 1].min + 1, high: current.max, locked: false };
}

/** The value to show for a typed Max once it is committed (Enter/blur). */
export function clampMaxEdit(entries, index, value) {
  const { low, high } = maxEditBounds(entries, index);
  if (isMaxLocked(entries, index)) return CHANNEL_MAX;
  return clampInt(value, low, high);
}

/** The value to show for a typed Min once it is committed (Enter/blur). */
export function clampMinEdit(entries, index, value) {
  const { low, high } = minEditBounds(entries, index);
  if (isMinLocked(entries, index)) return CHANNEL_MIN;
  return clampInt(value, low, high);
}

/**
 * Edit one class's Max.
 *
 * While typing (`commit: false`) the edit is applied only when it is VALID:
 * inside `maxEditBounds()` — i.e. it neither empties this class nor the next
 * one. An out-of-range keystroke changes nothing, so the field can be typed
 * into freely.
 *
 * On commit (`commit: true`, Enter or blur) the value is clamped into those
 * bounds and always applied, and the next class's Min follows (`v + 1`).
 *
 * Returns `{ entries, applied, value }` — a new list, never a mutation.
 */
export function editMax(entries, index, value, { commit = false } = {}) {
  const list = cloneEntries(entries);
  const current = list[index];
  if (!current || isMaxLocked(list, index)) {
    return { entries: list, applied: false, value: isMaxLocked(list, index) ? CHANNEL_MAX : null };
  }
  const { low, high } = maxEditBounds(list, index);
  const number = parseEditValue(value);
  const usable = number != null && number >= low && number <= high;
  if (!commit && !usable) return { entries: list, applied: false, value: null };
  const next = usable ? Math.round(number) : clampInt(value, low, high);
  current.max = next;
  list[index + 1].min = next + 1;
  return { entries: list, applied: true, value: next };
}

/**
 * Edit one class's Min — the mirror of `editMax`: the previous class's Max
 * becomes `v − 1`, live while the value is valid, clamped on commit.
 */
export function editMin(entries, index, value, { commit = false } = {}) {
  const list = cloneEntries(entries);
  const current = list[index];
  if (!current || isMinLocked(list, index)) {
    return { entries: list, applied: false, value: isMinLocked(list, index) ? CHANNEL_MIN : null };
  }
  const { low, high } = minEditBounds(list, index);
  const number = parseEditValue(value);
  const usable = number != null && number >= low && number <= high;
  if (!commit && !usable) return { entries: list, applied: false, value: null };
  const next = usable ? Math.round(number) : clampInt(value, low, high);
  current.min = next;
  list[index - 1].max = next - 1;
  return { entries: list, applied: true, value: next };
}

/**
 * Move one boundary of the 0..255 bar: handle `i` sits between class `i` and
 * `i + 1`, so dragging it is exactly an edit of class `i`'s Max.
 */
export function moveBoundary(entries, handle, value, { commit = false } = {}) {
  return editMax(entries, handle, value, { commit });
}

/**
 * Pixels per class from the image's 256-bin histogram: a class owns every bin
 * inside its (inclusive) range, so the shares follow the ranges live and need
 * no request. Returns `{ counts, total, percentages }` keyed by cluster.
 */
export function countsFromBins(entries, bins) {
  const values = (bins ?? []).map((value) => Number(value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const counts = {};
  const percentages = {};
  for (const entry of entries ?? []) {
    let sum = 0;
    for (let intensity = entry.min; intensity <= entry.max; intensity += 1) {
      sum += values[intensity] ?? 0;
    }
    counts[entry.cluster] = sum;
    percentages[entry.cluster] = total > 0 ? (sum / total) * 100 : 0;
  }
  return { counts, total, percentages };
}

/**
 * A 256-entry lookup table: intensity → colour, built from the current ranges
 * and colours. Pixels outside every range (only possible while a range list is
 * mid-edit) stay black, exactly like the API's `recolor_by_ranges`.
 */
export function buildLut(entries, colors = {}) {
  const lut = new Uint8Array(CHANNEL_VALUES * 3);
  for (const entry of entries ?? []) {
    const color = colors[entry.cluster] ?? entry.color ?? [0, 0, 0];
    const rgb = [
      Math.max(0, Math.min(255, Math.round(Number(color[0]) || 0))),
      Math.max(0, Math.min(255, Math.round(Number(color[1]) || 0))),
      Math.max(0, Math.min(255, Math.round(Number(color[2]) || 0))),
    ];
    for (let intensity = entry.min; intensity <= entry.max; intensity += 1) {
      lut[intensity * 3] = rgb[0];
      lut[intensity * 3 + 1] = rgb[1];
      lut[intensity * 3 + 2] = rgb[2];
    }
  }
  return lut;
}

/**
 * Recolour RGBA pixels in place through the LUT: each pixel's OpenCV-compatible
 * gray value selects a colour; alpha is untouched. This is what makes the
 * Result viewport follow the editor with no server request.
 */
export function recolorPixels(data, lut) {
  if (!data || !lut) return data;
  for (let index = 0; index + 3 < data.length; index += 4) {
    const gray = toGray(data[index], data[index + 1], data[index + 2]);
    const at = gray * 3;
    data[index] = lut[at];
    data[index + 1] = lut[at + 1];
    data[index + 2] = lut[at + 2];
  }
  return data;
}

/** The colours of an entry list as `{cluster: [r,g,b]}`, for `buildLut`. */
export function colorsOf(entries) {
  const colors = {};
  for (const entry of entries ?? []) colors[entry.cluster] = entry.color ?? [0, 0, 0];
  return colors;
}
