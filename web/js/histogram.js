/**
 * Histogram rendering options (STEP 5).
 *
 * The API returns 256 integer bin counts and nothing else. Every display
 * option here — log scale, smoothing, cumulative, density, theme — is computed
 * in the browser from those same 256 numbers, so switching an option never
 * causes another request.
 *
 * The same `drawHistogram` paints the on-screen canvas and the (larger)
 * export canvas, so the exported PNG always matches what is on screen.
 */

export const SCALES = ["linear", "log"];

/** Clearly labelled controls instead of raw numbers (item 9). */
export const SCALE_OPTIONS = Object.freeze([
  { key: "linear", label: "Linear" },
  { key: "log", label: "Log" },
]);

/** Off / Low / High smoothing, with the moving-average window each means. */
export const SMOOTHING_LEVELS = Object.freeze([
  { key: "off", label: "Off", window: 0 },
  { key: "low", label: "Low", window: 5 },
  { key: "high", label: "High", window: 11 },
]);

export const DISPLAY_MODES = Object.freeze([
  { key: "counts", label: "Counts" },
  { key: "density", label: "Density" },
  { key: "cumulative", label: "Cumulative" },
]);

export const THEME_OPTIONS = Object.freeze([
  { key: "dark", label: "Dark" },
  { key: "light", label: "Light" },
]);

/** The second series' colour when the Compare switch is on. */
export const COMPARE_COLOR = "#ffb454";

/** Keep the very old numeric window list working. */
export const SMOOTHING_WINDOWS = [0, 3, 5, 9];

/** Label of a smoothing level (or of a raw window number). */
export function smoothingLabel(value) {
  if (typeof value === "string") {
    return SMOOTHING_LEVELS.find((entry) => entry.key === value)?.label ?? "Off";
  }
  const window = Math.max(0, Math.round(Number(value) || 0));
  return window < 3 ? "Off" : window <= 5 ? "Low" : "High";
}

/** The moving-average window a smoothing level (key or number) stands for. */
export function smoothingWindow(value) {
  if (typeof value === "string") {
    return SMOOTHING_LEVELS.find((entry) => entry.key === value)?.window ?? 0;
  }
  return Math.max(0, Math.round(Number(value) || 0));
}

/** The display mode of a set of display flags (cumulative wins over density). */
export function displayModeOf({ cumulative = false, density = false } = {}) {
  if (cumulative) return "cumulative";
  return density ? "density" : "counts";
}

/** The flags a display mode stands for. */
export function displayFlags(mode) {
  return { cumulative: mode === "cumulative", density: mode === "density" };
}

/**
 * Statistics computed from the 256 bins alone (no extra request): the lowest
 * and highest intensity that occurs, the mean, the standard deviation and the
 * number of pixels the histogram counted.
 */
export function binStats(bins) {
  const values = (bins ?? []).map((value) => Number(value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return { count: 0, min: null, max: null, mean: null, std: null };
  let weighted = 0;
  let lowest = null;
  let highest = null;
  values.forEach((count, intensity) => {
    if (!count) return;
    weighted += intensity * count;
    if (lowest == null) lowest = intensity;
    highest = intensity;
  });
  const mean = weighted / total;
  let variance = 0;
  values.forEach((count, intensity) => {
    if (!count) return;
    variance += count * (intensity - mean) ** 2;
  });
  return {
    count: total,
    min: lowest,
    max: highest,
    mean,
    std: Math.sqrt(variance / total),
  };
}

/** The five numbers shown beside the chart. */
export function formatStats(stats) {
  const number = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
  return [
    { key: "min", label: "Min", text: stats?.count ? String(stats.min) : "—" },
    { key: "max", label: "Max", text: stats?.count ? String(stats.max) : "—" },
    { key: "mean", label: "Mean", text: number(stats?.mean) },
    { key: "std", label: "Std dev", text: number(stats?.std) },
    { key: "count", label: "Pixels", text: Number.isFinite(stats?.count) ? stats.count.toLocaleString() : "—" },
  ];
}

export const THEMES = Object.freeze({
  dark: {
    background: "#0b0e15",
    grid: "rgba(43, 49, 64, 0.8)",
    bar: "#35d0ba",
    barTop: "rgba(53, 208, 186, 0.35)",
    axis: "rgba(139, 152, 171, 0.85)",
    title: "rgba(232, 241, 245, 0.9)",
  },
  light: {
    background: "#f4f7f9",
    grid: "rgba(150, 163, 175, 0.45)",
    bar: "#0f7f74",
    barTop: "rgba(15, 127, 116, 0.35)",
    axis: "rgba(60, 72, 84, 0.9)",
    title: "rgba(24, 34, 42, 0.9)",
  },
});

/** Moving average over `window` bins (centred), the classic histogram smoother. */
export function smoothBins(bins, window = 0) {
  const size = Math.max(0, Math.round(window));
  if (size < 3 || !bins?.length) return [...(bins ?? [])];
  const half = Math.floor(size / 2);
  return bins.map((_value, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      const at = index + offset;
      if (at < 0 || at >= bins.length) continue;
      sum += bins[at];
      count += 1;
    }
    return count ? sum / count : 0;
  });
}

/** Running total: bin i shows how many pixels are at or below intensity i. */
export function cumulativeBins(bins) {
  let running = 0;
  return (bins ?? []).map((value) => {
    running += Number(value) || 0;
    return running;
  });
}

/** Share of pixels per bin (sums to ~1), i.e. the density view of the data. */
export function densityBins(bins) {
  const total = (bins ?? []).reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (!total) return (bins ?? []).map(() => 0);
  return (bins ?? []).map((value) => (Number(value) || 0) / total);
}

/**
 * Apply the options in a fixed, documented order so every combination is
 * reproducible: smoothing → cumulative → density → scale.
 */
export function prepareBins(bins, { scale = "linear", smoothing = 0, cumulative = false, density = false } = {}) {
  const source = (bins ?? []).map((value) => Number(value) || 0);
  if (!source.length) return { values: [], max: 1, total: 0, label: "no data" };
  let values = smoothBins(source, smoothingWindow(smoothing));
  if (cumulative) values = cumulativeBins(values);
  if (density) values = densityBins(values);
  const total = source.reduce((sum, value) => sum + value, 0);
  const useLog = scale === "log";
  if (useLog) values = values.map((value) => Math.log10(Math.max(value, 0) + 1));
  const max = Math.max(...values, useLog ? 0 : 1);
  return {
    values,
    max: max > 0 ? max : 1,
    total,
    label: describeOptions({ scale, smoothing, cumulative, density }),
  };
}

/** "log scale · smoothed 5 · cumulative · density" — used in captions and the PNG. */
export function describeOptions({ scale = "linear", smoothing = 0, cumulative = false, density = false } = {}) {
  const parts = [scale === "log" ? "log scale" : "linear scale"];
  const window = smoothingWindow(smoothing);
  if (window >= 3) parts.push(`${smoothingLabel(smoothing).toLowerCase()} smoothing`);
  if (cumulative) parts.push("cumulative");
  if (density) parts.push("density");
  return parts.join(" · ");
}

/** Axis labels for the current mode, so the PNG explains itself. */
export function axisLabels({ cumulative = false, density = false } = {}) {
  const y = cumulative ? "pixels ≤ intensity" : density ? "share of pixels" : "pixels";
  return { y, x: "intensity (0–255)" };
}

/**
 * Paint the histogram. Used for the panel canvas and for the export canvas —
 * pass a bigger width/height (and a `titleFont` scale) for the PNG.
 */
export function drawHistogram(ctx, {
  bins = [],
  width = 520,
  height = 170,
  theme = "dark",
  scale = "linear",
  smoothing = 0,
  cumulative = false,
  density = false,
  title = "",
  fontSize = 10,
  /** Optional second series: { bins, label, color } drawn as an outline. */
  compare = null,
} = {}) {
  const palette = THEMES[theme] ?? THEMES.dark;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);

  const titleHeight = title ? Math.round(fontSize * 1.8) : 0;
  const padLeft = Math.round(fontSize * 3.2);
  const padRight = Math.round(fontSize * 0.6);
  const padBottom = Math.round(fontSize * 1.6);
  const plotLeft = padLeft;
  const plotRight = width - padRight;
  const plotTop = titleHeight + Math.round(fontSize * 0.4);
  const plotBottom = height - padBottom;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);

  if (title) {
    ctx.fillStyle = palette.title;
    ctx.font = `${Math.round(fontSize * 1.25)}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(title, 4, titleHeight / 2 + 2);
  }

  const { values, max } = prepareBins(bins, { scale, smoothing, cumulative, density });
  const labels = axisLabels({ cumulative, density });

  // grid + y labels
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.strokeStyle = palette.grid;
  ctx.fillStyle = palette.axis;
  ctx.lineWidth = 1;
  for (let line = 0; line <= 3; line += 1) {
    const y = plotTop + (plotHeight / 3) * line;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y + 0.5);
    ctx.lineTo(plotRight, y + 0.5);
    ctx.stroke();
    const fraction = 1 - line / 3;
    const value = max * fraction;
    const text = scale === "log" && !density
      ? `10^${value.toFixed(1)}`
      : density
        ? `${(value * 100).toFixed(density ? 1 : 0)}%`
        : Math.round(value).toLocaleString();
    ctx.fillText(text, plotLeft - 3, y);
  }

  if (!values.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = palette.axis;
    ctx.fillText("no histogram yet", plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
    return { values, max, plotLeft, plotTop, plotWidth, plotHeight, palette, labels };
  }

  const barWidth = plotWidth / values.length;
  values.forEach((value, index) => {
    const barHeight = (value / max) * plotHeight;
    ctx.fillStyle = palette.bar;
    ctx.fillRect(plotLeft + index * barWidth, plotBottom - barHeight,
      Math.max(barWidth, 0.8), barHeight);
  });

  // optional second image, same options, drawn as an outline in its own colour
  if (compare?.bins?.length) {
    const other = prepareBins(compare.bins, { scale, smoothing, cumulative, density });
    const otherMax = Math.max(other.max, max);
    const step = plotWidth / Math.max(other.values.length, 1);
    ctx.save();
    ctx.strokeStyle = compare.color ?? COMPARE_COLOR;
    ctx.lineWidth = Math.max(1.5, fontSize / 8);
    ctx.beginPath();
    other.values.forEach((value, index) => {
      const x = plotLeft + index * step + step / 2;
      const y = plotBottom - (value / otherMax) * plotHeight;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // a two-row legend so the outline explains itself on screen and in the PNG
    const legendFont = Math.max(8, Math.round(fontSize * 0.95));
    ctx.font = `${legendFont}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const rows = [
      { color: palette.bar, label: title || "this image" },
      { color: compare.color ?? COMPARE_COLOR, label: compare.label ?? "compared image" },
    ];
    const widest = Math.max(...rows.map((row) => ctx.measureText(String(row.label)).width));
    const boxWidth = Math.round(widest + legendFont * 2.4);
    const boxHeight = Math.round(rows.length * legendFont * 1.6 + legendFont * 0.6);
    const boxX = plotRight - boxWidth - 4;
    const boxY = plotTop + 4;
    ctx.fillStyle = theme === "light" ? "rgba(244, 247, 249, 0.92)" : "rgba(11, 14, 21, 0.9)";
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxWidth - 1, boxHeight - 1);
    rows.forEach((row, index) => {
      const middle = boxY + legendFont * 1.1 + index * legendFont * 1.6;
      ctx.fillStyle = row.color;
      ctx.fillRect(boxX + legendFont * 0.6, middle - legendFont * 0.35, legendFont, legendFont * 0.7);
      ctx.fillStyle = palette.title;
      ctx.fillText(fitLabel(ctx, String(row.label), boxWidth - legendFont * 2.4),
        boxX + legendFont * 2.1, middle);
    });
    ctx.restore();
  }

  // axis captions: x below the plot, y rotated up the left margin
  ctx.fillStyle = palette.axis;
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.save();
  ctx.translate(Math.round(fontSize * 1.1), plotTop + plotHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(labels.y, 0, 0);
  ctx.restore();

  // axes labels
  ctx.fillStyle = palette.axis;
  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  ctx.fillText("0", plotLeft, height - 1);
  ctx.textAlign = "right";
  ctx.fillText("255", plotRight, height - 1);
  ctx.textAlign = "center";
  ctx.fillText(labels.x, plotLeft + plotWidth / 2, height - 1);
  return { values, max, plotLeft, plotTop, plotWidth, plotHeight, palette, labels };
}

/** Trim a legend label to the width the box can hold. */
function fitLabel(ctx, text, maxWidth) {
  if (typeof ctx?.measureText !== "function" || maxWidth <= 0) return text;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

export function histogramFileName(sourceName = "", extension = "png") {
  const base = String(sourceName || "image").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
  return `histogram-${base || "image"}.${extension}`;
}
