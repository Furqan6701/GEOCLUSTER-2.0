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
export const SMOOTHING_WINDOWS = [0, 3, 5, 9];

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
  let values = smoothBins(source, smoothing);
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
  if (smoothing >= 3) parts.push(`smoothed ${smoothing}`);
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

export function histogramFileName(sourceName = "", extension = "png") {
  const base = String(sourceName || "image").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
  return `histogram-${base || "image"}.${extension}`;
}
