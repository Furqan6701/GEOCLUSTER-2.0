/**
 * Application shell for the GeoCluster workstation.
 *
 * Owns the menu bar, the toolbar, the dock layout, the two image viewports,
 * the status bar and the shared state; the processing features themselves live
 * in js/panels/* and are reached through the bus, exactly as before.
 *
 * Serve this folder on http://localhost:5173 (see web/README.md).
 */

import { ApiClient } from "./api.js";
import { resolveApiBase } from "./config.js";
import { ApiError, humanizeError } from "./errors.js";
import { createActionGate } from "./gate.js";
import { ImageHistory, HISTORY_LIMIT, snapshotOf } from "./history.js";
import { MapStudio } from "./mapstudio_ui.js";
import { describeDistance } from "./measure.js";
import { createChatPanel } from "./panels/chat.js";
import { createPanels } from "./panels/index.js";
import { SessionExpiredError, SessionManager, carryGroundMetadata } from "./session.js";
import { activeImage, createAppState, createBus } from "./state.js";
import { chip, createMenuBar, downloadBlob, el, icon, setChildren, toast, toggleButton } from "./ui.js";
import { Viewer } from "./viewer.js";

const SERVER_ORDER = { original: 0, result: 1 };

// ------------------------------------------------------------------- context
const apiBase = resolveApiBase({
  search: window.location.search,
  storage: window.localStorage,
  hostname: window.location.hostname,
});
const state = createAppState();
state.apiBase = apiBase;
const bus = createBus();
const api = new ApiClient({ base: apiBase });
const session = new SessionManager({ api, state, bus });
/**
 * The one place that decides whether an operation may run: every operation
 * button registers with the gate, which re-evaluates them after every state
 * change (see js/gate.js).
 */
const gate = createActionGate({ state, bus });
const ctx = { api, session, state, bus, apiBase, gate };

// ------------------------------------------------------------------- viewers
const originalViewer = new Viewer(document.getElementById("viewer-original"), {
  title: "Original",
  role: "original",
  bus,
});
const resultViewer = new Viewer(document.getElementById("viewer-result"), {
  title: "Result",
  role: "result",
  bus,
  placeholder: "Run a filter or K-Means to see the result here",
});

/** Role-based label, used by the status bar for both image viewports. */
function viewerLabel(viewer) {
  return viewer === originalViewer ? "Original" : "Result";
}

const loadTokens = { original: 0, result: 0 };

async function showImage(role, info) {
  const viewer = role === "original" ? originalViewer : resultViewer;
  const token = ++loadTokens[role];
  try {
    const blob = await session.imageBlob(info.image_id);
    if (token !== loadTokens[role]) return; // a newer image replaced this one
    const source = info.source === "satellite" ? "satellite" : info.source;
    const description = `${source} · ${info.width}×${info.height}`;
    await viewer.loadBlob(blob, { name: info.name ?? info.image_id, description });
  } catch (error) {
    if (token !== loadTokens[role]) return;
    report(error, "Could not display the image");
  }
}

bus.on("image:loaded", ({ role, info }) => {
  showImage(role, info);
  bus.emit("status", { message: `${role === "original" ? "Working image" : "Result"} — ${info.name ?? info.image_id} (${info.width}×${info.height})` });
});

// STEP 3: a slider drag previews the filter client-side; nothing is committed
// and no history entry exists until the slider is released.
bus.on("preview:show", ({ canvas, operation }) => {
  if (canvas) resultViewer.setPreviewCanvas(canvas, operation);
});
bus.on("preview:clear", () => resultViewer.clearPreview());

bus.on("image:cleared", ({ role }) => {
  loadTokens[role] += 1;
  (role === "original" ? originalViewer : resultViewer).clear();
});

bus.on("session:reset", () => {
  loadTokens.original += 1;
  loadTokens.result += 1;
  originalViewer.clear();
  resultViewer.clear();
  state.kmeans = null;
});

bus.on("viewer:distance", ({ distance, role, text }) => {
  // Units + original resolution: the analysis panel explains this in full, the
  // toast repeats the two numbers with the label that says which is which.
  const info = role === "original" ? state.original?.info : role === "result" ? state.result?.info : null;
  const settings = state.measure ?? { unit: "px", pxPerUnit: null };
  const description = Number.isFinite(Number(distance))
    ? describeDistance({
      pixels: Number(distance),
      unit: settings.unit ?? "px",
      pxPerUnit: settings.pxPerUnit ?? null,
      scale: Number(info?.scale) > 0 ? Number(info.scale) : 1,
      info,
    })
    : { lines: [text] };
  const message = description.lines.join(" · ");
  toast(message, "", { timeout: 12000 });
  bus.emit("status", { message });
});

bus.on("viewer:distance-mode", ({ enabled, role }) => {
  if (enabled) toast(`Distance tool on the ${role} viewer — click two points (Esc clears).`, "", { timeout: 6000 });
  bus.emit("status", { message: enabled ? `Measure tool active on ${role}` : "Measure tool off" });
});

// ------------------------------------------------------------- map composer
/**
 * Map composer (redesign): a large in-page modal, not a docked viewport. The
 * toolbar's Map button and a Classify run open it, and everything it shows —
 * image, legend, scale bar, north arrow, credit, corner coordinates — is drawn
 * on ONE canvas by js/mapstudio.js. The dialog shows that canvas and an export
 * re-renders it at 1x/2x/3x, which is why the PNG always matches the preview.
 * Settings persist for the session inside the MapStudio instance.
 */
const mapStudio = new MapStudio({ bus, doc: document, mount: document.body });

/** The legend rows the composer should use: the Clusters table wins. */
function legendRowsForComposer() {
  const fromTable = panelById.get("clusters")?.actions?.legendEntries?.() ?? [];
  if (fromTable.length) return fromTable;
  return (state.legend ?? []).map((entry) => ({
    cluster: entry.cluster,
    name: entry.name ?? `Cluster ${entry.cluster}`,
    color: Array.isArray(entry.color) ? entry.color : [128, 128, 128],
    percentage: Number(entry.percentage) || 0,
  }));
}

/** Open the composer: the active image plus whatever the legend knows. */
async function openMapStudio({ image = null } = {}) {
  const active = activeImage(state);
  if (!active && !image) {
    toast("Load, fetch or classify an image first — the composer has nothing to draw.", "warn");
    return false;
  }
  try {
    let source = image;
    if (!source) {
      const blob = await session.imageBlob(active.id);
      source = await createImageBitmap(blob);
    }
    mapStudio.open({
      image: source,
      info: active?.info ?? null,
      rows: legendRowsForComposer(),
      name: active?.info?.name ?? active?.id ?? "",
      source: active?.info?.source ?? "upload",
      opener: document.getElementById("tb-map") ?? document.activeElement,
    });
    return true;
  } catch (error) {
    report(error, "Could not open the map composer");
    return false;
  }
}

const mapButton = document.getElementById("tb-map");
if (mapButton) {
  mapButton.setAttribute("aria-haspopup", "dialog");
  if (!mapButton.querySelector("svg")) mapButton.prepend(icon("map", { size: 13 }));
  mapButton.addEventListener("click", () => { void openMapStudio(); });
}
bus.on("map:studio", ({ open }) => {
  mapButton?.setAttribute("aria-pressed", open ? "true" : "false");
});

/** The Clusters table edits flow into the composer's legend live. */
bus.on("clusters:changed", ({ rows }) => {
  if (Array.isArray(rows)) mapStudio.setLegendRows(rows);
});
bus.on("map:legend-rows", ({ rows }) => {
  // and back: the composer's legend editor updates the Clusters table
  panelById.get("clusters")?.actions?.setLegendRows?.(rows);
});

bus.on("map:updated", async ({ legend, imageId, name }) => {
  // a classification replaced the map: keep the state and open the composer
  state.map = { legend: legend ?? [], imageId, name: name ?? imageId, canvas: null };
  const rows = legendRowsForComposer();
  if (mapStudio.isOpen()) {
    mapStudio.setLegendRows(rows);
    toast(`Map composer updated — ${rows.length} classes.`, "ok");
    return;
  }
  await openMapStudio();
  toast(`Map composer open — ${rows.length} classes from the classification.`, "ok");
});

// ------------------------------------------------------------------ history
/**
 * Undo/redo (STEP 3): the last HISTORY_LIMIT displayed states, each with the
 * Blob that produced it. Nothing here needs the server — restoring paints the
 * stored Blob — except when a server id has since been evicted, in which case
 * the stored Blob is re-uploaded and the state is re-pointed (see `revive`).
 */
const history = new ImageHistory();
/** True while a history entry is being painted: those loads are not recorded. */
let applyingHistory = false;

/** The label shown for a state, e.g. "Brightness +40" or "Opened sample.jpg". */
function stateLabel(role, info) {
  if (role === "result") {
    const last = state.lastOperation;
    if (last && !last.error && last.imageId === info.image_id) return last.operation;
    return info.source ? `Result — ${info.source}` : "Result";
  }
  return `Opened ${info.name ?? info.image_id}`;
}

async function cacheStateBlob(imageId) {
  try {
    const blob = await session.imageBlob(imageId);
    history.rememberBlob(imageId, blob);
  } catch {
    // The viewer reports download problems; history simply stays blob-less
    // for this step and falls back to the server if it is ever restored.
  }
}

function recordHistory(role, info) {
  if (applyingHistory || !info?.image_id) return;
  history.record({
    label: stateLabel(role, info),
    role,
    imageId: info.image_id,
    info,
    blob: session.blobCache.get(info.image_id) ?? null,
    kmeans: state.kmeans,
    snapshot: snapshotOf(state),
  });
  cacheStateBlob(info.image_id);
  updateHistoryControls();
}

bus.on("image:loaded", ({ role, info }) => recordHistory(role, info));
bus.on("history:changed", () => updateHistoryControls());

// looked up directly: `byId` is declared further down this module
const undoButton = document.getElementById("tb-undo");
const redoButton = document.getElementById("tb-redo");

function updateHistoryControls() {
  if (undoButton) {
    undoButton.disabled = !history.canUndo;
    undoButton.title = history.canUndo
      ? `Undo ${history.current?.label ?? "the last step"} (Ctrl+Z) — ${history.summary} states kept`
      : "Nothing to undo yet — run an operation first";
  }
  if (redoButton) {
    redoButton.disabled = !history.canRedo;
    redoButton.title = history.canRedo
      ? "Redo the step you undid (Ctrl+Y)"
      : "Nothing to redo — undo a step first";
  }
  if (sb.history) {
    setCell(
      sb.history,
      history.size ? `History ${history.summary}` : "",
      history.size
        ? `Undo history: ${history.pointer + 1} of ${history.size} states (${HISTORY_LIMIT} kept, Blobs held in the browser)`
        : "Undo history is empty",
    );
  }
}

/** Paint one slot of a state from a Blob we already hold. */
async function paintSlot(role, info) {
  const viewer = role === "original" ? originalViewer : resultViewer;
  const token = ++loadTokens[role];
  const blob = history.blobFor(info.image_id) ?? session.blobCache.get(info.image_id);
  try {
    if (blob) {
      await viewer.loadBlob(blob, {
        name: info.name ?? info.image_id,
        description: `${info.source === "satellite" ? "satellite" : info.source} · ${info.width}×${info.height}`,
      });
      return;
    }
    await showImage(role, info); // not cached any more: ask the server
  } catch (error) {
    if (token !== loadTokens[role]) return;
    report(error, "Could not restore that step");
  }
}

/** Put the workspace back exactly as `entry` recorded it. */
async function applyHistoryEntry(entry) {
  applyingHistory = true;
  try {
    state.kmeans = entry.kmeans ?? null;
    for (const role of ["original", "result"]) {
      const slot = entry.snapshot[role];
      if (!slot) {
        state[role] = null;
        loadTokens[role] += 1;
        (role === "original" ? originalViewer : resultViewer).clear();
        continue;
      }
      session.remember(slot.info ?? { image_id: slot.id });
      state[role] = { id: slot.id, info: slot.info };
      await paintSlot(role, slot.info ?? { image_id: slot.id, width: 0, height: 0 });
    }
  } finally {
    applyingHistory = false;
  }
  updateHistoryControls();
  updateStatusBar();
}

async function applyHistory(entry, verb) {
  if (!entry) {
    toast(`Nothing to ${verb}.`, "warn");
    return null;
  }
  try {
    await applyHistoryEntry(entry);
    // keep the last-operation cells describing what is on screen now
    if (entry.info) {
      state.lastOperation = { operation: entry.label, imageId: entry.imageId, at: Date.now() };
      bus.emit("operation:applied", { label: entry.label, info: entry.info });
    }
    toast(`${verb === "undo" ? "Undone" : "Redone"}: ${entry.label}`, "ok");
    bus.emit("status", { message: `${verb === "undo" ? "Undo" : "Redo"} — ${entry.label}` });
    return entry;
  } catch (error) {
    report(error, `Could not ${verb} that step`);
    return null;
  }
}

function undo() {
  return applyHistory(history.undo(), "undo");
}

function redo() {
  return applyHistory(history.redo(), "redo");
}

/**
 * Re-upload a Blob we still hold so a server-side eviction is invisible: the
 * operation is then retried against the replacement image id.
 */
async function revive(imageId) {
  const blob = history.blobFor(imageId) ?? session.blobCache.get(imageId);
  if (!blob) return null;
  // Keep the name the image already had: the re-upload is an implementation
  // detail and must not change what the UI (or an export) calls the image.
  const entry = history.entries.find((item) => item.imageId === imageId);
  const slot = [state.original, state.result].find((item) => item?.id === imageId);
  const name = entry?.info?.name ?? slot?.info?.name ?? state.images.get(imageId)?.name
    ?? `image-${String(imageId).slice(-6)}.png`;
  const uploaded = await session.withSession((sid) => api.uploadImage(sid, blob, name));
  // An upload cannot know the ground scale, so carry the metadata the image
  // had before it was evicted: the composer's scale bar must not lose the
  // satellite's bbox / meters_per_pixel just because the server forgot it.
  const previous = entry?.info ?? slot?.info ?? state.images.get(imageId) ?? {};
  const info = carryGroundMetadata(uploaded, previous);
  session.blobCache.set(info.image_id, blob);
  history.adopt(imageId, info, blob);
  for (const slot of [state.original, state.result]) {
    if (slot?.id === imageId) {
      slot.id = info.image_id;
      slot.info = info;
    }
  }
  bus.emit("status", { message: `Restored image ${imageId} into the session (it had been evicted)` });
  updateHistoryControls();
  return info;
}

session.setReviver(revive);

undoButton?.addEventListener("click", undo);
redoButton?.addEventListener("click", redo);

// A new session invalidates every server-side id, so the history goes too.
bus.on("session:reset", () => {
  history.reset();
  updateHistoryControls();
  state.map = null;
  mapStudio.close({ restoreFocus: false });
});

bus.on("viewer:error", () => {
  toast("The viewer could not display that image.", "bad");
});

bus.on("distance:request", () => {
  const target = activeViewer();
  target.toggleDistance(true);
});

bus.on("histogram:request", () => {
  focusSection("analysis");
});

// ------------------------------------------------------------- active viewer
let activeRole = "original";
originalViewer.setActive(true);

bus.on("viewer:active", ({ role }) => {
  if (role === activeRole) return;
  if (role === "map") return; // the map is a modal now, not a third viewport
  activeRole = role;
  originalViewer.setActive(role === "original");
  resultViewer.setActive(role === "result");
  updateStatusBar();
});

/** The viewer toolbar actions apply to: the focused viewport, else one with an image. */
function activeViewer() {
  const tracked = activeRole === "result" ? resultViewer : originalViewer;
  if (tracked.hasImage) return tracked;
  const other = tracked === resultViewer ? originalViewer : resultViewer;
  return other.hasImage ? other : tracked;
}

// --------------------------------------------------------------- sync control
const syncToggle = toggleButton("sync", {
  label: "Sync",
  pressed: false,
  onChange: (enabled) => {
    originalViewer.setMirror(resultViewer, enabled);
    resultViewer.setMirror(originalViewer, enabled);
    if (enabled) resultViewer.applyCamera(originalViewer.camera());
    const text = enabled
      ? "Viewer sync on — zoom/pan in one viewport mirrors the other."
      : "Viewer sync off — the viewports navigate independently.";
    toast(text, enabled ? "ok" : "", { timeout: 5000 });
    bus.emit("status", { message: text });
  },
});
document.getElementById("tb-sync").replaceWith(syncToggle.node);
syncToggle.node.id = "tb-sync";

// -------------------------------------------------------------------- panels
// the Filters panel replaces its own slider step instead of stacking
ctx.history = history;
const panels = createPanels(ctx);
const panelById = new Map(panels.map((panel) => [panel.id, panel]));
// the assistant dispatches operations through the same parameterised path
ctx.panels = panelById;
const toolboxSections = document.getElementById("toolbox-sections");

for (const panel of panels) {
  toolboxSections.append(panel.section.node);
}

function focusSection(id) {
  const panel = panelById.get(id);
  if (!panel) return false;
  for (const other of panels) {
    if (other !== panel) other.section.setCollapsed(true);
  }
  panel.section.setCollapsed(false);
  // guarded: some environments (and older browsers) have no scrollIntoView
  panel.section.node.scrollIntoView?.({ block: "nearest" });
  setDockVisible("toolbox", true);
  return true;
}

// ---------------------------------------------------------------------- chat
const chatPanel = createChatPanel(ctx);
document.getElementById("chat-column").append(chatPanel.node);

// -------------------------------------------------------------------- docks
const workspace = document.getElementById("workspace");
const toolboxDock = document.getElementById("toolbox");
const assistantDock = document.getElementById("assistant-dock");
const toolboxReopen = document.getElementById("toolbox-reopen");
const assistantReopen = document.getElementById("assistant-reopen");

const dockVisibility = { toolbox: true, assistant: true };

function setDockVisible(which, visible) {
  const next = Boolean(visible);
  dockVisibility[which] = next;
  const dock = which === "toolbox" ? toolboxDock : assistantDock;
  const reopen = which === "toolbox" ? toolboxReopen : assistantReopen;
  dock.hidden = !next;
  reopen.hidden = next;
  workspace.classList.toggle(which === "toolbox" ? "ws-no-toolbox" : "ws-no-assistant", !next);
  // let the viewers re-fit now that the pane size changed
  requestAnimationFrame(() => {
    originalViewer.render();
    resultViewer.render();
  });
  bus.emit("status", { message: `${which === "toolbox" ? "Toolbox" : "Assistant"} ${next ? "shown" : "hidden"}` });
}

document.getElementById("toolbox-collapse").addEventListener("click", () => setDockVisible("toolbox", false));
document.getElementById("assistant-collapse").addEventListener("click", () => setDockVisible("assistant", false));
toolboxReopen.addEventListener("click", () => setDockVisible("toolbox", true));
assistantReopen.addEventListener("click", () => setDockVisible("assistant", true));

// ------------------------------------------------------------------- toolbar
const byId = (id) => document.getElementById(id);

// Hide/show the result viewport (presentation only — the image stays loaded).
let resultVisible = true;
function setResultVisible(visible) {
  resultVisible = Boolean(visible);
  document.getElementById("viewer-result").hidden = !resultVisible;
  bus.emit("status", { message: resultVisible ? "Result viewport shown" : "Result viewport hidden" });
  requestAnimationFrame(() => originalViewer.render());
}

function withActiveViewer(action) {
  const viewer = activeViewer();
  if (!viewer.hasImage) {
    toast("Load an image first — the viewport controls need something to navigate.", "warn");
    return;
  }
  viewer.setActive(true);
  action(viewer);
}

function wireToolbarButton(id, iconName, label, onClick) {
  const node = byId(id);
  if (!node) return;
  node.prepend(icon(iconName, { size: 13 }));
  node.addEventListener("click", onClick);
  void label;
}

wireToolbarButton("tb-open", "open", "Open", () => bus.emit("open:file-request"));
wireToolbarButton("tb-satellite", "satellite", "Satellite", () => {
  focusSection("source");
  bus.emit("satellite:request");
});
wireToolbarButton("tb-export", "download", "Export", () => bus.emit("export:request"));
wireToolbarButton("tb-compress", "archive", "Compress", () => bus.emit("huffman:compress-request"));
// Zoom lives in the viewport footers (per-viewport) and the View menu — there
// is deliberately no second set of zoom buttons in the toolbar.

const panToggle = toggleButton("pan", {
  label: "Pan",
  pressed: true,
  onChange: (enabled) => {
    originalViewer.setPanEnabled(enabled);
    resultViewer.setPanEnabled(enabled);
    bus.emit("status", { message: enabled ? "Pan tool on — drag the image to move it" : "Pan tool off" });
  },
});
const pixelToggle = toggleButton("pixel", {
  label: "Pixel",
  pressed: true,
  onChange: (enabled) => {
    originalViewer.setPixelReadout(enabled);
    resultViewer.setPixelReadout(enabled);
    bus.emit("status", { message: enabled ? "Pixel readout on" : "Pixel readout off" });
  },
});
const measureToggle = toggleButton("measure", {
  label: "Measure",
  pressed: false,
  onChange: (enabled) => {
    const viewer = activeViewer();
    viewer.toggleDistance(enabled);
    bus.emit("status", { message: enabled ? `Measure tool active on the ${viewer.role} viewport` : "Measure tool off" });
  },
});
for (const [id, toggle] of [["tb-pan", panToggle], ["tb-pixel", pixelToggle], ["tb-measure", measureToggle]]) {
  byId(id).replaceWith(toggle.node);
  toggle.node.id = id;
}

// the viewer's own Distance button keeps the toolbar tool in step
bus.on("viewer:distance-mode", ({ role, enabled }) => {
  if (role !== activeRole) return;
  if (measureToggle.isPressed() !== enabled) measureToggle.setPressed(enabled);
});

/**
 * The toolbar must never wrap or overlap. Labels are dropped when the row
 * would overflow (narrow windows, long session chips, extra zoom levels),
 * which is measured on every resize rather than guessed from a breakpoint.
 */
const toolbarNode = byId("toolbar");

function fitToolbar() {
  if (!toolbarNode) return;
  toolbarNode.classList.remove("tb-compact");
  // measured after a reflow so scrollWidth reflects the un-compacted state
  if (toolbarNode.scrollWidth > toolbarNode.clientWidth) toolbarNode.classList.add("tb-compact");
}

window.addEventListener("resize", () => requestAnimationFrame(fitToolbar));
bus.on("session", () => requestAnimationFrame(fitToolbar));
bus.on("health", () => requestAnimationFrame(fitToolbar));
requestAnimationFrame(fitToolbar);

byId("tb-toggle-toolbox").addEventListener("click", () => setDockVisible("toolbox", !dockVisibility.toolbox));
byId("tb-toggle-assistant").addEventListener("click", () => setDockVisible("assistant", !dockVisibility.assistant));
byId("tb-toggle-toolbox").prepend(icon("panelLeft", { size: 13 }));
byId("tb-toggle-assistant").prepend(icon("panelRight", { size: 13 }));
byId("tb-undo")?.prepend(icon("undo", { size: 13 }));
byId("tb-redo")?.prepend(icon("redo", { size: 13 }));

// ------------------------------------------------------------------ shortcuts
function exportCurrent() {
  const active = activeImage(state);
  if (!active) {
    toast("Load or fetch an image first.", "warn");
    return;
  }
  bus.emit("export:request");
}

/** Set by the keydown listener; Ctrl+Shift+Z is the second redo binding. */
let shiftDown = false;

const shortcuts = [
  { key: "o", ctrl: true, run: () => bus.emit("open:file-request") },
  { key: "z", ctrl: true, run: () => (shiftDown ? redo() : undo()) },
  { key: "y", ctrl: true, run: () => redo() },
  { key: "s", ctrl: true, run: () => exportCurrent() },
  { key: "+", run: () => withActiveViewer((viewer) => viewer.zoomBy(1.25)) },
  { key: "=", run: () => withActiveViewer((viewer) => viewer.zoomBy(1.25)) },
  { key: "-", run: () => withActiveViewer((viewer) => viewer.zoomBy(1 / 1.25)) },
  { key: "0", run: () => withActiveViewer((viewer) => viewer.fit()) },
  { key: "1", run: () => withActiveViewer((viewer) => viewer.zoomTo(1)) },
  { key: "m", run: () => withActiveViewer((viewer) => viewer.toggleDistance()) },
  { key: "p", run: () => pixelToggle.setPressed(!pixelToggle.isPressed()) },
  { key: "y", run: () => syncToggle.setPressed(!syncToggle.isPressed()) },
];

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLElement
    && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typing) return;
  const ctrl = event.ctrlKey || event.metaKey;
  shiftDown = event.shiftKey;
  for (const shortcut of shortcuts) {
    if (shortcut.key !== event.key.toLowerCase()) continue;
    if (Boolean(shortcut.ctrl) !== ctrl) continue;
    event.preventDefault();
    shortcut.run();
    return;
  }
});

// -------------------------------------------------------------------- menus
/**
 * Every menu/toolbar entry point funnels through the Filters panel's `run()`,
 * which is the single place that knows the parameters each operation needs —
 * so a menu click can never dispatch an operation without its body.
 */
const runOperation = (operation) => () => {
  const filters = panelById.get("filters");
  focusSection("filters");
  filters?.actions?.revealParams(operation);
  filters?.actions?.run(operation);
};

/** Current value the Filters panel would send, for the menu's hint line. */
const operationHint = (operation) => {
  const filters = panelById.get("filters");
  if (!filters?.actions?.paramsFor) return "";
  if (operation === "grayscale" || operation === "negative" || operation === "laplacian") return "no parameters";
  const params = filters.actions.paramsFor(operation);
  if (params === undefined || params === null) return "set the value in Filters";
  return `uses ${JSON.stringify(params)}`.replace(/[{}"]/g, "").replace(/:/g, ": ");
};

const menuBar = createMenuBar([
  {
    label: "File",
    items: () => [
      { label: "Open image…", icon: "open", shortcut: "Ctrl+O", onClick: () => bus.emit("open:file-request") },
      { label: "Fetch Sentinel-2 tile…", icon: "satellite", onClick: () => { focusSection("source"); bus.emit("satellite:request"); } },
      { separator: true },
      {
        label: "Export current image (PNG)…",
        icon: "download",
        shortcut: "Ctrl+S",
        disabled: !activeImage(state),
        reason: "load, fetch or decompress an image first",
        onClick: exportCurrent,
      },
      { label: "Compress to .gch (GCH2)…", icon: "archive", onClick: () => bus.emit("huffman:compress-request") },
      { label: "Decompress a .gch…", icon: "file", onClick: () => { focusSection("files"); bus.emit("huffman:decompress-request"); } },
      { separator: true },
      {
        label: history.canUndo ? `Undo ${history.current?.label ?? ""}`.trim() : "Undo",
        icon: "undo",
        shortcut: "Ctrl+Z",
        disabled: !history.canUndo,
        reason: "nothing to undo — run an operation first",
        onClick: undo,
      },
      {
        label: "Redo",
        icon: "redo",
        shortcut: "Ctrl+Y",
        disabled: !history.canRedo,
        reason: "nothing to redo — undo a step first",
        onClick: redo,
      },
      { separator: true },
      {
        label: "New session",
        icon: "route",
        onClick: () => byId("new-session").click(),
      },
    ],
  },
  {
    label: "View",
    items: () => [
      { label: "Fit to view", icon: "fit", shortcut: "0", onClick: () => withActiveViewer((v) => v.fit()) },
      { label: "Actual size (100%)", icon: "grid", shortcut: "1", onClick: () => withActiveViewer((v) => v.zoomTo(1)) },
      { label: "Zoom in", icon: "zoomIn", shortcut: "+", onClick: () => withActiveViewer((v) => v.zoomBy(1.25)) },
      { label: "Zoom out", icon: "zoomOut", shortcut: "−", onClick: () => withActiveViewer((v) => v.zoomBy(1 / 1.25)) },
      { label: "Zoom 25%", onClick: () => withActiveViewer((v) => v.zoomTo(0.25)) },
      { label: "Zoom 50%", onClick: () => withActiveViewer((v) => v.zoomTo(0.5)) },
      { separator: true },
      { label: "Pixel readout", icon: "pixel", checked: pixelToggle.isPressed(), onClick: () => pixelToggle.setPressed(!pixelToggle.isPressed()) },
      { label: "Pan tool", icon: "pan", checked: panToggle.isPressed(), onClick: () => panToggle.setPressed(!panToggle.isPressed()) },
      { label: "Measure distance", icon: "measure", shortcut: "M", checked: measureToggle.isPressed(), onClick: () => withActiveViewer((v) => v.toggleDistance()) },
      { label: "Synchronise Original ↔ Result", icon: "sync", shortcut: "Y", checked: syncToggle.isPressed(), onClick: () => syncToggle.setPressed(!syncToggle.isPressed()) },
      { separator: true },
      { label: "Show toolbox", icon: "panelLeft", checked: dockVisibility.toolbox, onClick: () => setDockVisible("toolbox", !dockVisibility.toolbox) },
      { label: "Show assistant", icon: "chat", checked: dockVisibility.assistant, onClick: () => setDockVisible("assistant", !dockVisibility.assistant) },
      { label: "Show result viewport", icon: "grid", checked: resultVisible, onClick: () => setResultVisible(!resultVisible) },
      {
        label: "Map composer…",
        icon: "map",
        note: "a modal that draws the image, legend, scale bar and north arrow on one canvas",
        onClick: () => { void openMapStudio(); },
      },
    ],
  },
  {
    label: "Processing",
    items: () => [
      { label: "Grayscale", icon: "filters", note: operationHint("grayscale"), onClick: runOperation("grayscale") },
      { label: "Negative", icon: "filters", note: operationHint("negative"), onClick: runOperation("negative") },
      { label: "Laplacian", icon: "filters", note: operationHint("laplacian"), onClick: runOperation("laplacian") },
      { separator: true },
      { label: "Brightness…", icon: "filters", note: operationHint("brightness"), onClick: runOperation("brightness") },
      { label: "Threshold…", icon: "filters", note: operationHint("threshold"), onClick: runOperation("threshold") },
      { label: "Mean filter…", icon: "filters", note: operationHint("meanfilter"), onClick: runOperation("meanfilter") },
      { separator: true },
      {
        label: "Clear result",
        icon: "trash",
        disabled: !state.result,
        reason: "there is no result yet — run a filter or K-Means first",
        onClick: () => panelById.get("filters")?.actions?.clearResult(),
      },
    ],
  },
  {
    label: "Analysis",
    items: () => [
      { label: "Run K-Means…", icon: "layers", onClick: () => { focusSection("clusters"); panelById.get("clusters")?.actions?.runKMeans(); } },
      { label: "Classification editor…", icon: "legend", onClick: () => focusSection("clusters") },
      { separator: true },
      { label: "Histogram & statistics", icon: "chart", onClick: () => { focusSection("analysis"); panelById.get("analysis")?.actions?.refresh(); } },
      { separator: true },
      {
        label: "Map composer…",
        icon: "map",
        note: state.map
          ? `image, legend (${state.map.legend.length} classes), scale bar, north arrow`
          : "opens on the current image; Classify fills the legend",
        onClick: () => { void openMapStudio(); },
      },
      {
        label: "Map legend",
        icon: "legend",
        checked: mapStudio.getSettings()?.legend?.visible !== false,
        note: "also editable in the composer's properties panel",
        onClick: () => {
          if (!mapStudio.getSettings()) { void openMapStudio(); return; }
          mapStudio.setLegendVisible(!(mapStudio.getSettings().legend.visible !== false));
        },
      },
      {
        label: "Map export (PNG)…",
        icon: "download",
        note: "1x/2x/3x in the composer footer",
        onClick: () => {
          if (!mapStudio.isOpen()) { void openMapStudio(); return; }
          void mapStudio.download(2);
        },
      },
    ],
  },
  {
    label: "Help",
    items: () => [
      { label: "Keyboard shortcuts", icon: "help", onClick: () => showShortcuts() },
      { separator: true },
      { label: "About GeoCluster 2.0", icon: "info", onClick: () => showAbout() },
    ],
  },
]);
byId("menubar").replaceWith(menuBar.node);
menuBar.node.id = "menubar";

function showShortcuts() {
  toast(
    "Shortcuts: Ctrl+O open · Ctrl+S export PNG · +/− zoom · 0 fit · 1 actual size · M measure · P pixel readout · Y sync viewers",
    "",
    { timeout: 12000 },
  );
}

function showAbout() {
  toast(
    `GeoCluster 2.0 web workstation · API ${apiBase} · frontend at ${window.location.origin}. Image processing runs on the API; the viewports, readout and measurement are client-side.`,
    "",
    { timeout: 14000 },
  );
}

// -------------------------------------------------------------------- chips
const chipHost = document.getElementById("status-chips");

function renderChips() {
  const nodes = [];
  nodes.push(chip(`API ${apiBase}`, state.health ? "ok" : "bad", "The API base URL this page was built with"));
  if (state.sessionId) {
    nodes.push(chip(`session ${state.sessionId.slice(0, 8)}… · ${state.ttlMinutes ?? "?"} min`, "", `Max ${state.maxImages ?? "?"} images per session`));
  } else {
    nodes.push(chip("session —", "warn", "No session yet"));
  }
  const health = state.health;
  if (health) {
    nodes.push(chip(`AI ${health.ai_configured ? "ready" : "not configured"}`, health.ai_configured ? "ok" : "warn", "FIREWORKS_API_KEY on the server"));
    nodes.push(chip(`Satellite ${health.satellite_configured ? "ready" : "not configured"}`, health.satellite_configured ? "ok" : "warn", "Copernicus credentials on the server"));
    nodes.push(chip(`max ${health.max_image_megapixels} MP`, "", "MAX_IMAGE_MEGAPIXELS"));
  } else {
    nodes.push(chip("API unreachable", "bad", "Could not reach GET /health"));
  }
  setChildren(chipHost, nodes);
  updateStatusBar();
}

// ------------------------------------------------------------------ banner
const banner = document.getElementById("banner");

function setBanner(message, kind = "") {
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${kind}`.trim();
  banner.textContent = message;
}

function report(error, prefix) {
  if (error instanceof SessionExpiredError) {
    toast(error.message, "warn", { timeout: 15000 });
    bus.emit("status", { message: "Session expired — new session created, re-upload the image" });
    return;
  }
  if (error instanceof ApiError && error.isNetwork) {
    setBanner(humanizeError(error, { apiBase }), "bad");
  }
  toast(`${prefix}: ${humanizeError(error, { apiBase })}`, "bad", { timeout: 12000 });
}

// --------------------------------------------------------------- status bar
const sb = {
  message: byId("sb-message"),
  source: byId("sb-source"),
  size: byId("sb-size"),
  mode: byId("sb-mode"),
  zoom: byId("sb-zoom"),
  cursor: byId("sb-cursor"),
  pixel: byId("sb-pixel"),
  viewer: byId("sb-viewer"),
  lastOp: byId("sb-lastop"),
  history: byId("sb-history"),
  session: byId("sb-session"),
  api: byId("sb-api"),
};

let statusMessage = "";
let statusTimer = null;

function setStatusMessage(text, { sticky = false } = {}) {
  statusMessage = text ?? "";
  sb.message.textContent = statusMessage;
  if (statusTimer) clearTimeout(statusTimer);
  if (!sticky && statusMessage) {
    statusTimer = setTimeout(() => {
      sb.message.textContent = "";
      statusMessage = "";
    }, 12000);
  }
}

bus.on("status", ({ message } = {}) => setStatusMessage(message));

function channelLabel(info) {
  if (!info) return "";
  if (info.channels === 1) return "GRAY";
  if (info.channels === 2) return "GRAY+A";
  if (info.channels === 3) return "RGB";
  if (info.channels === 4) return "RGBA";
  return `${info.channels} ch`;
}

/** Write a status-bar cell, keeping the untruncated text in its tooltip. */
function setCell(node, text, title = null) {
  if (!node) return;
  node.textContent = text ?? "";
  node.title = title ?? (text ?? "");
}

function updateStatusBar() {
  const active = activeViewer();
  const viewer = active.hasImage ? active : (activeImage(state) ? (active === originalViewer ? resultViewer : originalViewer) : null);
  const info = viewer?.hasImage
    ? (viewer === originalViewer ? state.original?.info : state.result?.info) ?? null
    : null;
  const shown = viewer?.image ? { width: viewer.image.width, height: viewer.image.height } : null;

  setCell(sb.viewer, viewer?.hasImage ? `Viewport: ${viewerLabel(viewer)}` : "Viewport: —");
  setCell(sb.size, shown ? `${shown.width} × ${shown.height} px` : "—",
    shown ? `${shown.width} × ${shown.height} pixels (${viewerLabel(viewer).toLowerCase()})` : "No image");
  setCell(sb.mode, channelLabel(info), info ? `${channelLabel(info)} — ${info.channels} channel(s), ${info.name ?? ""}`.trim() : "No image");
  setCell(sb.zoom, viewer?.hasImage ? `Zoom ${Math.round(viewer.scale * 100)}%` : "Zoom —",
    viewer?.hasImage ? `Zoom ${Math.round(viewer.scale * 100)}% — ${viewer.image.width} × ${viewer.image.height} px image` : "No image");
  setCell(sb.source, viewer !== originalViewer && state.result?.info
    ? `Result: ${state.result.info.source ?? "derived"}`
    : state.original?.info
      ? `Working: ${state.original.info.source ?? "upload"}`
      : "");
  // short id in the bar, the full details on hover
  setCell(
    sb.session,
    state.sessionId ? `Session ${state.sessionId.slice(0, 6)}…` : "Session —",
    state.sessionId
      ? `Session ${state.sessionId}\nTTL ${state.ttlMinutes ?? "?"} minutes\nMax ${state.maxImages ?? "?"} images per session`
      : "No session yet",
  );
  if (state.lastOperation && !state.lastOperation.error) {
    setCell(sb.lastOp, `Last: ${state.lastOperation.operation}`,
      `Last operation: ${state.lastOperation.operation}${state.lastOperation.imageId ? ` → image ${state.lastOperation.imageId}` : ""}`);
  } else if (state.lastOperation?.error) {
    setCell(sb.lastOp, `Last: ${state.lastOperation.operation}`, "The last operation did not complete");
  }
  setCell(sb.api, `API ${state.health ? "●" : "○"}`,
    state.health ? `Connected to ${apiBase}` : `Cannot reach ${apiBase}`);
  sb.api.className = `sb-item ${state.health ? "ok" : "bad"}`;
}

bus.on("viewer:camera", ({ role }) => {
  if (role === activeRole) updateStatusBar();
});

// the status bar keeps the last operation visible until the next one
bus.on("operation:applied", ({ label, info }) => {
  sb.lastOp.textContent = `Last: ${label} (${info.width}×${info.height})`;
  sb.lastOp.title = `Last operation: ${label} → image ${info.image_id}`;
  updateStatusBar();
});
bus.on("viewer:cursor", ({ role, inside, x, y, r, g, b, gray }) => {
  if (role !== activeRole) return;
  if (!inside) {
    sb.cursor.textContent = "";
    sb.pixel.textContent = "";
    return;
  }
  setCell(sb.cursor, `X: ${x}  Y: ${y}`, `Cursor at column ${x}, row ${y}`);
  setCell(sb.pixel, r === undefined ? `Gray: ${gray}` : `RGB: ${r},${g},${b}`,
    r === undefined ? `Grayscale value ${gray}` : `Red ${r}, green ${g}, blue ${b}`);
});

// ------------------------------------------------------------- session ops
byId("new-session").addEventListener("click", async () => {
  try {
    await session.restart();
    toast("New session started — upload your image again.", "ok");
    renderChips();
  } catch (error) {
    report(error, "Could not start a session");
  }
});

bus.on("session", () => renderChips());
bus.on("health", () => renderChips());
bus.on("busy", () => updateStatusBar());

// -------------------------------------------------------------- bootstrap
async function bootstrap() {
  renderChips();
  updateStatusBar();
  try {
    await session.refreshHealth();
    setBanner("");
    updateStatusBar();
  } catch (error) {
    setBanner(humanizeError(error, { apiBase }), "bad");
  }
  try {
    await session.ensure();
  } catch (error) {
    report(error, "Could not start a session");
  }
  renderChips();
  setStatusMessage("Ready — open an image or fetch a Sentinel-2 tile.", { sticky: true });
}

bootstrap();

// debug handle (no secrets involved)
window.geocluster = {
  api,
  session,
  state,
  bus,
  viewers: { original: originalViewer, result: resultViewer },
  gate,
  map: {
    open: openMapStudio,
    close: () => mapStudio.close(),
    isOpen: () => mapStudio.isOpen(),
    settings: () => mapStudio.getSettings(),
    canvas: () => mapStudio.getCanvas(),
    composeAt: (scale) => mapStudio.composeAt(scale),
    export: (scale = 1) => mapStudio.export(scale),
    studio: mapStudio,
  },
  history,
  panels: panelById,
  ApiError,
  undo,
  redo,
  selectTab: focusSection,
  selectSection: focusSection,
  setDockVisible,
  setResultVisible,
  toggles: { sync: syncToggle, pan: panToggle, pixel: pixelToggle, measure: measureToggle },
  ui: { toast, downloadBlob, el, chip },
  version: "2.0",
};
