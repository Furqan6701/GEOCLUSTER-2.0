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

import { toGray } from "./color.js";

export const SCALES = ["linear", "log"];

/**
 * Channels the browser can histogram (item 13). "Gray" is the API's own
 * 256-bin series; the colour channels are computed here from the decoded image
 * and never need an endpoint of their own.
 */
export const CHANNEL_OPTIONS = Object.freeze([
  { key: "gray", label: "Gray", color: null },
  { key: "red", label: "Red", color: "#ff5f56" },
  { key: "green", label: "Green", color: "#5fd36a" },
  { key: "blue", label: "Blue", color: "#4aa8ff" },
  { key: "rgb", label: "RGB overlay", color: null },
]);

export const CHANNEL_KEYS = Object.freeze(CHANNEL_OPTIONS.map((entry) => entry.key));

/** The label of a channel key (unknown keys read as Gray). */
export function channelLabel(key) {
  return CHANNEL_OPTIONS.find((entry) => entry.key === key)?.label ?? "Gray";
}

/**
 * A grayscale image offers Gray only; a colour image offers every channel.
 * `info.channels` is the API's own field (1 for a 2-D grayscale array, 3 or 4
 * for colour — see api/sessions.py), so nothing has to be guessed.
 */
export function channelKeysFor(info) {
  const channels = Number(info?.channels);
  if (!Number.isFinite(channels)) return [...CHANNEL_KEYS];
  return channels >= 3 ? [...CHANNEL_KEYS] : ["gray"];
}

export function channelOptionsFor(info) {
  const keys = channelKeysFor(info);
  return CHANNEL_OPTIONS.filter((entry) => keys.includes(entry.key));
}

/** True when the image has more than one channel (i.e. Red/Green/Blue exist). */
export function isColorImage(info) {
  return channelKeysFor(info).length > 1;
}

/** The smoothing slider: 0 = off, 1…10 = `SMOOTHING_STEPS[i]` bins of average. */
export const SMOOTHING_RANGE = Object.freeze({ min: 0, max: 10, step: 1, value: 0 });
/** Slider value → moving-average window (odd, so it stays centred). */
export const SMOOTHING_STEPS = Object.freeze(
  Array.from({ length: SMOOTHING_RANGE.max + 1 }, (_value, index) => (index === 0 ? 0 : index * 2 + 1)),
);

/**
 * Count pixels into 256 bins per channel, in ONE pass over the decoded RGBA
 * data. Fully transparent pixels are skipped (their colour is undefined), which
 * is also what makes this agree with the API for images with an alpha channel
 * (it drops alpha before converting).
 */
export function channelHistograms(data, { document: _unused = null } = {}) {
  const empty = () => new Uint32Array(256);
  const out = { gray: empty(), red: empty(), green: empty(), blue: empty(), count: 0 };
  if (!data?.length) return out;
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha === 0) continue;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    out.red[red] += 1;
    out.green[green] += 1;
    out.blue[blue] += 1;
    out.gray[toGray(red, green, blue)] += 1;
    out.count += 1;
  }
  return out;
}

/**
 * The bins a channel shows: the API's gray series for "gray", the browser's own
 * numbers for every colour channel.
 */
export function binsForChannel(channel, { apiBins = null, histograms = null } = {}) {
  if (channel === "gray" || channel == null) return apiBins ?? [];
  if (!histograms) return [];
  if (channel === "rgb") return null; // three series, see seriesForChannel
  const bins = histograms[channel];
  return bins ? Array.from(bins) : [];
}

/** The extra coloured series a channel adds on top of the filled bars. */
export function seriesForChannel(channel, histograms) {
  if (channel !== "rgb" || !histograms) return [];
  return ["red", "green", "blue"].map((key) => ({
    key,
    bins: histograms[key] ? Array.from(histograms[key]) : [],
    label: channelLabel(key),
    color: CHANNEL_OPTIONS.find((entry) => entry.key === key)?.color ?? COMPARE_COLOR,
  }));
}

/** Clearly labelled controls instead of raw numbers (item 9). */
export const SCALE_OPTIONS = Object.freeze([
  { key: "linear", label: "Linear" },
  { key: "log", label: "Log" },
]);

/**
 * Legacy label lookup kept for the histogram window's captions: the Smoothing
 * control is a slider now (0 = off … 10), described as "smoothing n".
 */
export const SMOOTHING_LEVELS = Object.freeze(
  SMOOTHING_STEPS.map((window, index) => ({ key: String(index), label: index === 0 ? "Off" : String(index), window })),
);

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

/**
 * The slider value a smoothing setting stands for, clamped to 0…10. The window
 * list above (raw windows such as 3, 5, 9) is still understood so old callers
 * and saved options keep working.
 */
export function smoothingLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(SMOOTHING_RANGE.min, Math.min(SMOOTHING_RANGE.max, Math.round(number)));
}

/** The moving-average window a slider value stands for (0, 3, 5, 7 … 21). */
export function smoothingWindow(value) {
  return SMOOTHING_STEPS[smoothingLevel(value)] ?? 0;
}

/** "off" / "smoothing 4" — the phrase a caption uses. */
export function smoothingLabel(value) {
  const level = smoothingLevel(value);
  return level === 0 ? "Off" : `Smoothing ${level}`;
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

/**
 * "linear scale · smoothing 4 · cumulative · density" — used in captions and the
 * PNG. A channel other than Gray is named too, so an exported chart always says
 * which channel it shows.
 */
export function describeOptions({ scale = "linear", smoothing = 0, cumulative = false, density = false, channel = "gray" } = {}) {
  const parts = [scale === "log" ? "log scale" : "linear scale"];
  const level = smoothingLevel(smoothing);
  if (level > 0) parts.push(`smoothing ${level}`);
  if (cumulative) parts.push("cumulative");
  if (density) parts.push("density");
  if (channel && channel !== "gray") parts.push(`${channelLabel(channel).toLowerCase()} channel`);
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
  /** Optional second image: { bins, label, color } drawn as an outline. */
  compare = null,
  /** Optional extra series (the RGB overlay): [{ bins, label, color }, …]. */
  series = null,
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

  // optional extra outlines (a compared image, or R/G/B), same options, each in
  // its own colour
  const outlines = [
    ...(compare?.bins?.length ? [compare] : []),
    ...(series ?? []).filter((entry) => entry?.bins?.length),
  ];
  if (outlines.length) {
    const prepared = outlines.map((entry) => ({
      ...entry,
      values: prepareBins(entry.bins, { scale, smoothing, cumulative, density }).values,
    }));
    const otherMax = Math.max(max, ...prepared.map((entry) => Math.max(...entry.values, 1)));
    ctx.save();
    ctx.lineWidth = Math.max(1.5, fontSize / 8);
    for (const entry of prepared) {
      const step = plotWidth / Math.max(entry.values.length, 1);
      ctx.strokeStyle = entry.color ?? COMPARE_COLOR;
      ctx.beginPath();
      entry.values.forEach((value, index) => {
        const x = plotLeft + index * step + step / 2;
        const y = plotBottom - (value / otherMax) * plotHeight;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // a legend so the outlines explain themselves on screen and in the PNG
    const legendFont = Math.max(8, Math.round(fontSize * 0.95));
    ctx.font = `${legendFont}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const rows = [
      { color: palette.bar, label: title || "this image" },
      ...prepared.map((entry) => ({ color: entry.color ?? COMPARE_COLOR, label: entry.label ?? "series" })),
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
