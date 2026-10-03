/**
 * Analysis section: 256-bin histogram, image statistics and the distance tool.
 *
 * The histogram is drawn straight from the API's integer bin counts; the
 * "Log" toggle only changes how the same numbers are displayed.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, el, icon, setChildren, toast, toolGroup } from "../ui.js";

const WIDTH = 520;
const HEIGHT = 170;

export function createAnalysisPanel(ctx) {
  const { session, bus, state } = ctx;

  const refreshButton = button("Histogram & stats", refresh, { variant: "primary", size: "small" });
  const logToggle = el("input", { type: "checkbox", id: "hist-log" });
  const logLabel = el("label", { class: "checkbox", for: "hist-log" }, [logToggle, "Log scale"]);
  const canvas = el("canvas", { width: WIDTH, height: HEIGHT, class: "histogram-canvas" });
  const statsHost = el("div", {}, el("p", { class: "empty-note", text: "No statistics yet." }));
  const caption = el("p", { class: "note", text: "Load an image, then compute the histogram." });

  let lastBins = null;

  logToggle.addEventListener("change", () => draw(lastBins));

  async function refresh() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return;
    }
    refreshButton.disabled = true;
    refreshButton.textContent = "Working…";
    try {
      const [histogram, stats] = await session.withSession(async (sid) => {
        const bins = await ctx.api.histogram(sid, active.id);
        const values = await ctx.api.stats(sid, active.id);
        return [bins, values];
      });
      lastBins = histogram.bins ?? [];
      draw(lastBins);
      setChildren(statsHost, [
        el("div", { class: "stat-strip" }, [
          stat("min", stats.min),
          stat("max", stats.max),
          stat("mean", Number(stats.mean).toFixed(2)),
          stat("std", Number(stats.std).toFixed(2)),
        ]),
      ]);
      const total = lastBins.reduce((sum, value) => sum + value, 0);
      caption.textContent = `256 bins · ${total.toLocaleString()} pixels · image ${active.info?.width ?? "?"}×${active.info?.height ?? "?"}`;
      bus.emit("status", { message: `Histogram ready — mean ${Number(stats.mean).toFixed(2)}, std ${Number(stats.std).toFixed(2)}` });
    } catch (error) {
      report(error, "Analysis failed");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "Histogram & stats";
    }
  }

  function stat(label, value) {
    return el("span", { class: "stat" }, [el("span", { text: label }), el("span", { text: String(value) })]);
  }

  function draw(bins) {
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = "#0b0e15";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    if (!bins || !bins.length) {
      context.fillStyle = "rgba(139, 152, 171, 0.6)";
      context.font = "12px 'Segoe UI', system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText("no histogram yet", WIDTH / 2, HEIGHT / 2);
      return;
    }
    const useLog = logToggle.checked;
    const values = useLog ? bins.map((value) => Math.log10(value + 1)) : bins;
    const max = Math.max(...values, 1);
    const barWidth = WIDTH / bins.length;

    // grid
    context.strokeStyle = "rgba(43, 49, 64, 0.8)";
    context.lineWidth = 1;
    for (let line = 1; line <= 3; line += 1) {
      const y = (HEIGHT / 4) * line;
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(WIDTH, y + 0.5);
      context.stroke();
    }

    context.fillStyle = "#35d0ba";
    values.forEach((value, index) => {
      const height = (value / max) * (HEIGHT - 4);
      context.fillRect(index * barWidth, HEIGHT - height, Math.max(barWidth, 0.8), height);
    });

    context.fillStyle = "rgba(139, 152, 171, 0.85)";
    context.font = "10px 'Cascadia Mono', Consolas, monospace";
    context.textAlign = "left";
    context.fillText("0", 2, HEIGHT - 2);
    context.textAlign = "right";
    context.fillText("255", WIDTH - 2, HEIGHT - 2);
  }

  function report(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  // ------------------------------------------------------------- distance
  const measureButton = button("Measure on the active viewport", () => bus.emit("distance:request"), { size: "small" });
  measureButton.prepend(icon("measure", { size: 12 }));

  // The chat command "histogram" asks the panel to refresh (and the app
  // switches to this section when it sees the same event).
  bus.on("histogram:request", () => {
    refresh();
  });

  bus.on("image:loaded", ({ role }) => {
    if (role === "original") {
      lastBins = null;
      draw(null);
      setChildren(statsHost, el("p", { class: "empty-note", text: "No statistics yet." }));
      caption.textContent = "Load an image, then compute the histogram.";
    }
  });

  draw(null);

  const section = createSection({
    id: "analysis",
    title: "Analysis",
    iconName: "chart",
    collapsed: true,
    body: [
      toolGroup("Histogram", [
        canvas,
        el("div", { class: "row center", style: { marginTop: "6px" } }, [refreshButton, logLabel]),
        caption,
      ]),
      toolGroup("Statistics", [statsHost]),
      toolGroup("Distance", [
        measureButton,
        el("p", { class: "note", text: "Two clicks on the active viewport measure the Euclidean pixel distance. Esc clears. Client-side only — the API has no distance endpoint." }),
      ]),
    ],
  });

  return { id: "analysis", label: "Analysis", section, actions: { refresh } };
}
