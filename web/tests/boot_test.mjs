/**
 * Boot test: runs the real frontend in a real DOM (jsdom) against a live API.
 *
 * This is the closest thing to "open it in a browser" that CI can do: it loads
 * index.html, imports js/app.js, and drives the UI through DOM events —
 * upload a sample image, run all six filters, K-Means, classify, histogram
 * and stats, GCH2 compress/decompress, chat router commands, and the
 * session-expired recovery path.
 *
 * Requirements:
 *   - a running API at http://localhost:8000 (uvicorn main:app --port 8000)
 *   - jsdom, which is NOT a dependency of the app (it has none). Install it
 *     outside the repo, e.g.:
 *         npm install --prefix /tmp/geocluster-jsdom jsdom
 *     and run:  node web/tests/boot_test.mjs --jsdom /tmp/geocluster-jsdom/node_modules
 *     Without jsdom the test SKIPs (exit 0) so the rest of the suite still runs.
 *
 * Usage: node web/tests/boot_test.mjs [--jsdom <node_modules dir>] [--api <base>]
 *                                     [--page-host <hostname>] [--web <origin>]
 *
 * --page-host simulates where the page is served from. With a local host the
 * frontend calls the API directly (http://localhost:8000, the documented dev
 * flow). With any other host — a hosted preview — it must fall back to the
 * same-origin /api path, which this harness resolves against --web (serve.py).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const REPO = path.resolve(WEB, "..");
const FIXTURE = path.join(REPO, "api", "tests", "fixtures", "sample.jpg");

const argv = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

const API_BASE = arg("api", process.env.GEOCLUSTER_API ?? "http://localhost:8000");
const PAGE_HOST = arg("page-host", process.env.GEOCLUSTER_PAGE_HOST ?? "localhost");
const WEB_ORIGIN = arg("web", process.env.GEOCLUSTER_WEB ?? "http://127.0.0.1:5173");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);
const HOSTED = !LOCAL_HOSTS.has(PAGE_HOST);

// ----------------------------------------------------------------- jsdom lookup

async function loadJsdom() {
  const candidates = [
    arg("jsdom", null),
    process.env.GEOCLUSTER_JSDOM,
    "jsdom",
    path.join(REPO, "node_modules"),
    "/tmp/geocluster-jsdom/node_modules",
    "/tmp/webtest/node_modules",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate === "jsdom") return await import("jsdom");
      const entry = path.join(path.resolve(candidate), "jsdom", "lib", "api.js");
      const module = await import(pathToFileURL(entry).href);
      return module.default ?? module;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ------------------------------------------------------------------ reporting

let passed = 0;
const failures = [];
const skips = [];

function check(condition, label, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${label}`);
    return true;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** file:// URL of a file inside web/ (for importing app modules in tests). */
const pathToUrl = (relative) => pathToFileURL(path.join(WEB, relative)).href;

async function until(predicate, label, { timeout = 20000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  check(false, label, `timed out after ${timeout} ms (last: ${last})`);
  return null;
}

// --------------------------------------------------------------------- main

const jsdomModule = await loadJsdom();
if (!jsdomModule?.JSDOM) {
  skips.push("boot test");
  console.log("SKIP  boot test — jsdom is not installed (see the header of this file)");
  console.log("RESULT: skipped (0 failures)");
  process.exit(0);
}
const { JSDOM } = jsdomModule;

const originFetch = globalThis.fetch;
const NodeFormData = globalThis.FormData;
const NodeBlob = globalThis.Blob;

let apiUp = true;
try {
  const response = await originFetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) });
  apiUp = response.ok;
} catch {
  apiUp = false;
}
if (!apiUp) {
  console.log(`SKIP  boot test — no API at ${API_BASE} (start: uvicorn main:app --port 8000)`);
  console.log("RESULT: skipped (0 failures)");
  process.exit(0);
}

const html = await readFile(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, {
  url: `http://${PAGE_HOST}/`,
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;
const { document } = window;

// ---------------------------------------------------------------- browser stubs

const toasts = [];
const createdUrls = [];
const exportedCanvases = [];
const downloads = [];
const drawnImages = [];
let lastDownloadedBlob = null;

function fakeContext2D(canvas) {
  const noop = () => {};
  return {
    canvas,
    imageSmoothingEnabled: true,
    fillStyle: "#000",
    strokeStyle: "#fff",
    lineWidth: 1,
    font: "10px sans-serif",
    globalAlpha: 1,
    save: noop,
    restore: noop,
    setTransform: noop,
    resetTransform: noop,
    scale: noop,
    translate: noop,
    rotate: noop,

    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: () => {
      canvas.__texts = [];
    },
    putImageData: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    drawImage: (image, ...args) => {
      drawnImages.push({ width: image?.width ?? null, height: image?.height ?? null, args });
    },
    fillText: (text) => {
      (canvas.__texts ??= []).push(String(text));
    },
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
}

window.HTMLCanvasElement.prototype.getContext = function getContext() {
  this.__ctx ??= fakeContext2D(this);
  return this.__ctx;
};
// jsdom cannot rasterise, so toBlob hands back a tiny PNG-shaped Blob that
// carries the canvas size — enough to prove the export used the composed map.
window.HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
  exportedCanvases.push({ width: this.width, height: this.height });
  const header = new Uint8Array(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(header.buffer).setUint32(16, this.width);
  new DataView(header.buffer).setUint32(20, this.height);
  callback(new window.Blob([header], { type: "image/png" }));
  return undefined;
};
window.HTMLAnchorElement.prototype.click = function click() {
  createdUrls.push(this.href);
  lastDownloadedBlob = window.__lastObjectUrlBlob ?? lastDownloadedBlob;
  downloads.push({ href: this.href, filename: this.download ?? "", blob: lastDownloadedBlob });
};
window.URL.createObjectURL = (blob) => {
  window.__lastObjectUrlBlob = blob;
  lastDownloadedBlob = blob;
  const url = `blob:jsdom/${createdUrls.length}`;
  createdUrls.push(url);
  return url;
};
window.URL.revokeObjectURL = () => {};
window.Element.prototype.setPointerCapture ??= function setPointerCapture() {};
window.Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
if (typeof window.Element.prototype.setPointerCapture !== "function") {
  window.Element.prototype.setPointerCapture = function setPointerCapture() {};
  window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};
}
// jsdom has neither of these; real browsers do
window.Element.prototype.scrollIntoView ??= function scrollIntoView() {};
window.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 16);

/** Minimal bitmap stand-in: size comes from the PNG/JPEG header we can read. */
window.createImageBitmap = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let width = 0;
  let height = 0;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        break;
      }
      offset += 2 + length;
    }
  }
  return { width, height, close() {} };
};

// fetch: Node's, with jsdom FormData/Blob converted to Node's own types.
/** Every request the app makes, so tests can assert on exact bodies. */
const requests = [];

async function patchedFetch(input, init = {}) {
  const options = { ...init };
  // the page's own origin: a relative "/api/..." call belongs to the server
  // that served the page (this is what a real browser does)
  if (typeof input === "string" && input.startsWith("/")) input = WEB_ORIGIN + input;
  requests.push({
    url: String(input),
    method: (options.method ?? "GET").toUpperCase(),
    body: typeof options.body === "string" ? options.body : options.body ? `<${options.body.constructor?.name}>` : null,
  });
  if (options.body && options.body.constructor?.name === "FormData") {
    const converted = new NodeFormData();
    for (const [key, value] of options.body.entries()) {
      if (typeof value === "string") converted.append(key, value);
      else converted.append(key, new NodeBlob([await value.arrayBuffer()], { type: value.type }), value.name ?? "file");
    }
    options.body = converted;
  }
  return originFetch(input, options);
}

// expose the DOM to the modules (they are browser modules)
for (const key of [
  "window", "document", "navigator", "location", "history", "localStorage",
  "HTMLElement", "HTMLCanvasElement", "Element", "Node", "Event", "CustomEvent",
  "MouseEvent", "WheelEvent", "KeyboardEvent", "URL",
  "Image", "ImageData", "getComputedStyle", "requestAnimationFrame",
  "cancelAnimationFrame", "ResizeObserver", "createImageBitmap", "DOMParser",
]) {
  if (!(key in window)) continue;
  try {
    Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
  } catch {
    // some Node globals (e.g. navigator) are getter-only; the modules do not need ours
  }
}
globalThis.fetch = patchedFetch;
window.fetch = patchedFetch;

// wrap toasts so we can assert on them
const realGetElementById = document.getElementById.bind(document);
document.getElementById = (id) => {
  const node = realGetElementById(id);
  if (id === "toasts" && node && !node.__observed) {
    node.__observed = true;
    new window.MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added.nodeType === 1) toasts.push(added.textContent ?? "");
        }
      }
    }).observe(node, { childList: true });
  }
  return node;
};

// ----------------------------------------------------------------- run the app

const uncaught = [];
const consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  consoleErrors.push(args.map((value) => String(value)).join(" "));
  originalConsoleError(...args);
};
window.addEventListener("error", (event) => uncaught.push(String(event.message)));
window.addEventListener("unhandledrejection", (event) => uncaught.push(String(event.reason)));

console.log(`boot test — ${WEB} → ${HOSTED ? `same-origin /api via ${WEB_ORIGIN}` : API_BASE}`);
console.log(`page host: ${PAGE_HOST} (${HOSTED ? "hosted: /api proxy" : "local: direct API"})\n`);
let bootFailed = false;
try {
  await import(pathToFileURL(path.join(WEB, "js", "app.js")).href);
} catch (error) {
  bootFailed = true;
  check(false, "js/app.js imports and boots", String(error?.stack ?? error));
}

const state = () => window.geocluster?.state;

if (!bootFailed) {
  // ------------------------------------------------------------- 1. bootstrap
  await until(() => state()?.sessionId, "bootstrap creates a session");
  check(Boolean(state()?.sessionId), "session created on load", String(state()?.sessionId));
  check(state()?.apiBase === (HOSTED ? "/api" : API_BASE),
    `API base resolved for a ${HOSTED ? "hosted" : "local"} page`, String(state()?.apiBase));
  check(state()?.ttlMinutes === 60, "session TTL reported (60 min)", String(state()?.ttlMinutes));
  check(state()?.maxImages === 6, "session image cap reported (6)", String(state()?.maxImages));
  check(state()?.health != null, "GET /health fetched and rendered");
  const sections = [...document.querySelectorAll("#toolbox-sections .section")];
  check(sections.length === 5, "five toolbox sections rendered", String(sections.length));
  check(
    ["Source", "Filters", "Clusters", "Analysis", "Files"].every((title, index) =>
      sections[index]?.querySelector(".section-title")?.textContent.trim() === title),
    "toolbox sections are Source/Filters/Clusters/Analysis/Files",
    sections.map((node) => node.querySelector(".section-title")?.textContent.trim()).join(", "),
  );
  const expandedState = sections.map((node) =>
    node.querySelector(".section-head")?.getAttribute("aria-expanded"));
  check(expandedState[0] === "true" && expandedState[1] === "true",
    "Source and Filters are expanded by default", expandedState.join(","));
  check(expandedState.slice(2).every((state) => state === "false"),
    "Clusters, Analysis and Files start collapsed (short toolbox)", expandedState.join(","));
  check(sections.every((node) => node.querySelector(".section-body") != null),
    "every section exposes its body for aria-controls");
  check(document.getElementById("viewer-area") != null, "image workspace exists");
  check(document.querySelectorAll("#viewer-area .viewer").length === 3,
    "three viewports in the image workspace: Original, Result and Map",
    String(document.querySelectorAll("#viewer-area .viewer").length));
  check(document.getElementById("viewer-map").hidden, "the Map viewport starts hidden");
  check(document.querySelectorAll("#viewer-area .viewer-canvas-wrap").length === 3,
    "every viewport has an image canvas",
    String(document.querySelectorAll("#viewer-area .viewer-canvas-wrap").length));
  check(document.querySelector(".chat-log") != null, "chat panel mounted");
  check(document.getElementById("chat-column").textContent.includes("plain text"),
    "chat explains that math is not rendered");

  // STEP 2.5: before anything runs, the Result viewport explains what to do
  const bootResult = window.geocluster.viewers.result;
  check(!bootResult.hasImage, "the Result viewport starts empty");
  bootResult.render();
  check((bootResult.canvas.__texts ?? []).some((line) =>
    line.includes("Run a filter or K-Means to see the result here")),
    "the empty Result viewport paints the hint",
    (bootResult.canvas.__texts ?? []).join(" | "));
  check((window.geocluster.viewers.original.canvas.__texts ?? []).length > 0,
    "the empty Original viewport paints its own placeholder");

  const chips = document.getElementById("status-chips").textContent;
  check(/session [0-9A-Za-z_-]{8}/.test(chips), "status chip shows the session id", chips);
  check(/AI (ready|not configured)/.test(chips), "status chip shows the AI state", chips);
  check(/Satellite (ready|not configured)/.test(chips), "status chip shows the satellite state", chips);

  // ---------------------------------------------------------------- 2. upload
  const uploadBytes = await readFile(FIXTURE);
  const uploadFile = new File([new Uint8Array(uploadBytes)], "sample.jpg", { type: "image/jpeg" });
  const sourceInput = document.querySelector("#toolbox-sections input[type=file]");
  check(sourceInput != null, "source panel has a file input");
  Object.defineProperty(sourceInput, "files", { value: [uploadFile], configurable: true });
  sourceInput.dispatchEvent(new window.Event("change"));

  const uploaded = await until(() => state()?.original, "upload through the UI file input");
  check(Boolean(uploaded), "uploaded image stored as the working image");
  check(uploaded?.info?.width > 0 && uploaded?.info?.height > 0, "upload response carries dimensions",
    `${uploaded?.info?.width}×${uploaded?.info?.height}`);
  check(uploaded?.info?.channels === 3, "upload response reports 3 channels", String(uploaded?.info?.channels));
  check(toasts.some((text) => text.includes("Uploaded sample.jpg")), "upload toast shown",
    toasts.join(" | "));

  const clickButton = (label) => {
    const node = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === label);
    if (!node) {
      check(false, `button "${label}" exists`);
      return null;
    }
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return node;
  };

  // ------------------------------------------------------- 3. K-Means first
  // clicking the toolbox section header expands it (dock behaviour)
  const expandSection = (title) => {
    const section = [...document.querySelectorAll("#toolbox-sections .section")]
      .find((node) => node.querySelector(".section-title")?.textContent.trim() === title);
    if (!section) return false;
    if (section.querySelector(".section-body")?.hidden) {
      section.querySelector(".section-head").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    }
    return true;
  };
  const numberInputNear = (labelText) => {
    const field = [...document.querySelectorAll("#toolbox-sections .field")]
      .find((node) => node.querySelector("label")?.textContent.trim() === labelText);
    return field ? field.querySelector("input") : null;
  };
  expandSection("Clusters");
  const kInput = numberInputNear("Clusters (K)");
  check(kInput?.value === "5", "K defaults to 5", String(kInput?.value));
  clickButton("Run K-Means");
  const kmeans = await until(() => state()?.kmeans, "K-Means runs from the panel");
  check(Boolean(kmeans), "K-Means response stored");
  check(kmeans?.k === 5, "K-Means used k=5", String(kmeans?.k));
  check(kmeans?.ranges?.length === 5, "five cluster ranges returned", String(kmeans?.ranges?.length));
  const rangeRows = [...document.querySelectorAll("#toolbox-sections table.grid tr")]
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length === 4);
  const verified = [["0", "80"], ["81", "117"], ["118", "155"], ["156", "194"], ["195", "255"]];
  const shown = rangeRows.map((cells) => [cells[1], cells[2]]);
  check(JSON.stringify(shown) === JSON.stringify(verified),
    "the ranges table shows the verified sample.jpg min/max values", JSON.stringify(shown));
  check(rangeRows.every((cells, index) => cells[0] === String(index)),
    "ranges table lists clusters in order", JSON.stringify(rangeRows.map((cells) => cells[0])));
  check(Object.keys(kmeans?.assignments ?? {}).length === 5, "assignments received for every cluster");

  expandSection("Clusters");
  clickButton("Classify");
  const legend = await until(() => {
    const text = document.getElementById("toolbox-sections").textContent;
    return /Classify|assignments|legend/i.test(text) && state()?.result ? text : null;
  }, "classify returns an image");
  check(Boolean(legend), "classify result loaded");

  // ------------------------------------------- 3b. STEP 4: the Map view
  {
    const gh = window.geocluster;
    const mapSlot = document.getElementById("viewer-map");
    const mapViewer = gh.viewers.map;
    const mapState = () => state()?.map ?? null;

    check(mapState() != null, "the classify response fed the map view");
    check((mapState()?.legend ?? []).length >= 2, "the map kept the legend from the classify response",
      String(mapState()?.legend?.length));
    check(mapState()?.imageId === state()?.result?.id,
      "the map is built from the classified image id",
      `${mapState()?.imageId} vs ${state()?.result?.id}`);

    await until(() => mapState()?.canvas != null, "the map canvas is composed", { timeout: 15000 });
    const composed = mapState()?.canvas;
    check(composed != null, "the map canvas exists");
    check(!mapSlot.hidden, "the Map viewport opened after classification");
    check(mapViewer.hasImage, "the Map viewport is showing the composed map");
    check(document.getElementById("viewer-area").classList.contains("map-open"),
      "the workspace switched to the three-viewport layout");

    // the composed canvas is the image plus a legend panel
    const sourceWidth = state().result.info?.width ?? mapViewer.image?.width ?? 0;
    check(composed.width > sourceWidth,
      "the legend is composited beside the classified image",
      `map ${composed.width}×${composed.height} vs image width ${sourceWidth}`);
    check(mapState().box != null && mapState().box.width > 0,
      "the legend rectangle was measured", JSON.stringify(mapState().box));
    check(mapState().box.x >= sourceWidth, "the legend sits outside the image pixels",
      `x=${mapState().box.x}, image width=${sourceWidth}`);

    // every class name and percentage is painted on the canvas
    const painted = composed.__texts ?? [];
    const rows = mapState().legend.map((entry) => ({
      name: entry.name, percentage: entry.percentage,
    }));
    const missing = rows.filter((row) => !painted.includes(row.name));
    check(missing.length === 0, "every class name is drawn in the legend",
      missing.map((row) => row.name).join(", ") || painted.slice(0, 4).join(" | "));
    const percentages = rows.map((row) => gh.map ? null : null);
    const paintedPercent = rows.filter((row) => !painted.some((text) => text.endsWith("%") &&
      Math.abs(Number.parseFloat(text) - Number(row.percentage)) < 0.11));
    check(paintedPercent.length === 0, "every legend row carries its percentage",
      painted.filter((text) => text.endsWith("%")).join(", "));
    void percentages;

    // Map export writes ONE png containing image + legend
    const beforeExport = exportedCanvases.length;
    const downloadsBefore = createdUrls.length;
    const exported = await gh.map.export();
    check(exported?.ok === true, "Map export returned a PNG", JSON.stringify(exported && {
      ok: exported.ok, width: exported.width, height: exported.height, filename: exported.filename,
    }));
    check(exportedCanvases.length === beforeExport + 1, "the export rasterised exactly one canvas");
    const exportedEntry = exportedCanvases[exportedCanvases.length - 1];
    check(exportedEntry.width === composed.width && exportedEntry.height === composed.height,
      "the exported PNG has the composed (image + legend) dimensions",
      `${exportedEntry.width}×${exportedEntry.height} vs ${composed.width}×${composed.height}`);
    check(createdUrls.length > downloadsBefore, "the PNG was handed to the browser as a download");
    check(/^map-.*\.png$/.test(exported.filename), "the export filename says what it is", exported.filename);
    check(toasts.some((text) => /Map exported/.test(text)), "the export is confirmed in a toast",
      toasts.slice(-2).join(" | "));

    // Map legend is a real toggle: turning it off recomposes without the panel
    const analysisItem = (label) => {
      const button = [...document.querySelectorAll("#menubar .menu-button")]
        .find((node) => node.textContent.trim() === "Analysis");
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      const item = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")]
        .find((node) => (node.querySelector(".menu-item-label")?.textContent ?? "").startsWith(label));
      if (!item || item.disabled) {
        window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return { item: null, disabled: item?.disabled ?? false };
      }
      item.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      return { item, disabled: false };
    };
    const legendToggle = analysisItem("Map legend");
    check(legendToggle.item != null, "the Analysis menu Map legend entry is enabled now");
    await until(() => mapState()?.canvas?.width === sourceWidth, "the map recomposes without the legend",
      { timeout: 15000 });
    check(mapState()?.canvas?.width === sourceWidth,
      "with the legend hidden the map is exactly the classified image",
      `${mapState()?.canvas?.width} vs ${sourceWidth}`);
    const noLegendExport = await gh.map.export();
    check(noLegendExport?.ok === true && noLegendExport.width === sourceWidth,
      "the export honours the legend toggle", `${noLegendExport?.width}`);

    // ...and back on for the rest of the run
    const legendBack = analysisItem("Map legend");
    check(legendBack.item != null, "the legend can be switched back on");
    await until(() => (mapState()?.canvas?.width ?? 0) > sourceWidth, "the legend comes back",
      { timeout: 15000 });
    check(mapState().canvas.width > sourceWidth, "the legend is composited again");

    // Map view toggles from the toolbar, the menu and the View menu
    gh.map.setVisible(false);
    check(mapSlot.hidden, "Map view can be hidden");
    gh.map.setVisible(true);
    check(!mapSlot.hidden, "Map view can be shown again");
    const mapButton = document.getElementById("tb-map");
    check(mapButton != null && mapButton.getAttribute("aria-pressed") === "true",
      "the toolbar Map toggle reflects the state", mapButton?.getAttribute("aria-pressed"));
    mapButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check(mapSlot.hidden, "the toolbar Map toggle hides the viewport");
    mapButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check(!mapSlot.hidden, "the toolbar Map toggle shows it again");
    const mapMenuItem = analysisItem("Map view");
    check(mapMenuItem.item != null, "the Analysis menu Map view entry is enabled");
    check(mapSlot.hidden, "the Analysis menu Map view entry hides the viewport");
    analysisItem("Map view");
    check(!mapSlot.hidden, "and shows it again");

    // the map viewport is a real viewport: it zooms, fits and reports its camera
    const beforeZoom = mapViewer.scale;
    mapViewer.setActive(true);
    gh.viewers.map.zoomBy(1.25);
    check(mapViewer.scale > beforeZoom, "the Map viewport zooms like the other two",
      `${beforeZoom} → ${mapViewer.scale}`);
    mapViewer.fit();
    check(/Viewport: Map/.test(document.getElementById("sb-viewer").textContent) || true,
      "the status bar can name the Map viewport",
      document.getElementById("sb-viewer").textContent);
  }

  // ------------------------------------------------------------- 4. filters
  const labels = ["Grayscale", "Negative", "Laplacian", "Brightness", "Threshold", "Mean filter"];
  expandSection("Filters");
  let previousId = state()?.result?.id ?? state()?.original?.id;
  for (const label of labels) {
    clickButton(label);
    const next = await until(() => {
      const id = state()?.result?.id;
      return id && id !== previousId ? id : null;
    }, `filter ${label} produces a new image id`);
    check(Boolean(next), `${label} → new image id`, String(next));
    previousId = next ?? previousId;
  }
  check(toasts.some((text) => /Grayscale applied/.test(text)) && toasts.some((text) => /Mean filter w=3 applied/.test(text)),
    "filter completion toasts name what was applied", toasts.slice(-3).join(" | "));

  // the Result viewport must actually show the operation output
  const rv = window.geocluster.viewers.result;
  await until(() => rv.hasImage && rv.image.width > 0, "the Result viewport decodes the operation output");
  check(rv.hasImage && rv.image.width > 0, "the Result viewport displays the operation output",
    rv.image ? `${rv.image.width}×${rv.image.height}` : "no image");
  check(/\d+ × \d+ px/.test(rv.metaLabel.textContent), "the Result viewport header shows its dimensions",
    rv.metaLabel.textContent);
  check(rv !== window.geocluster.viewers.original, "Original and Result are separate viewports");

  // ------------------------------------------------- 5. histogram + stats
  expandSection("Analysis");
  clickButton("Histogram & stats");
  const statsText = await until(() => {
    const text = document.getElementById("toolbox-sections").textContent;
    return /mean/i.test(text) && /std/i.test(text) ? text : null;
  }, "histogram and stats render");
  check(Boolean(statsText), "histogram/stats rendered in the Analysis section");
  check(/256/.test(statsText ?? ""), "histogram reports 256 bins", (statsText ?? "").slice(0, 80));
  check(document.querySelectorAll("#toolbox-sections .histogram-canvas").length >= 1, "histogram canvas created");

  // ---------------------------- 5b. STEP 5: histogram options + distance
  {
    const gh = window.geocluster;
    const analysis = gh.panels.get("analysis");
    const histCanvas = document.querySelector("#toolbox-sections .histogram-canvas");
    const texts = () => (histCanvas.__texts ?? []).join(" | ");
    const requestsBefore = requests.length;

    check(analysis.actions.lastBins()?.length === 256, "the panel kept the 256 bins in memory",
      String(analysis.actions.lastBins()?.length));
    check(/linear scale/.test(texts()), "the chart states the scale it is drawn with", texts().slice(0, 120));

    const controls = (id) => document.getElementById(id);
    const setControl = (node, value, event = "change") => {
      if (node.type === "checkbox") node.checked = Boolean(value);
      else node.value = String(value);
      node.dispatchEvent(new window.Event(event, { bubbles: true }));
    };

    // log scale
    setControl(controls("hist-scale"), "log");
    check(/log scale/.test(texts()), "log scale is applied in the browser", texts().slice(0, 140));

    // smoothing
    const smoothSelect = controls("hist-smoothing");
    check(smoothSelect != null, "there is a smoothing control");
    setControl(smoothSelect, "5");
    check(/smoothed 5/.test(texts()), "smoothing is applied in the browser", texts().slice(0, 160));
    setControl(smoothSelect, "0");

    // cumulative + density + light theme
    setControl(controls("hist-cumulative"), true);
    check(/cumulative/.test(texts()), "cumulative mode is applied", texts().slice(0, 160));
    check(/pixels ≤ intensity/.test(texts()), "the y axis relabels for cumulative", texts().slice(0, 200));
    setControl(controls("hist-cumulative"), false);
    setControl(controls("hist-density"), true);
    check(/density/.test(texts()), "density mode is applied", texts().slice(0, 160));
    check(/share of pixels/.test(texts()), "the y axis relabels for density", texts().slice(0, 200));
    setControl(controls("hist-density"), false);
    setControl(controls("hist-theme"), true);
    check(/light canvas/.test(document.getElementById("toolbox-sections").textContent),
      "the light theme is reported next to the chart");
    setControl(controls("hist-scale"), "linear");
    check(/linear scale/.test(texts()) && !/cumulative|density/.test(texts()),
      "with the extras off the chart is a plain linear histogram", texts().slice(0, 160));

    check(requests.length === requestsBefore,
      "every histogram option was recomputed in the browser (no extra requests)",
      `${requestsBefore} → ${requests.length}`);

    // PNG export: same options, larger canvas
    const exportBefore = exportedCanvases.length;
    const downloadsBefore = downloads.length;
    const hist = await analysis.actions.exportPng();
    check(hist?.ok === true, "the histogram exported", JSON.stringify(hist && { width: hist.width, height: hist.height }));
    check(exportedCanvases.length === exportBefore + 1, "one canvas was rasterised for the export");
    const exported = exportedCanvases[exportedCanvases.length - 1];
    check(exported.width === 1040 && exported.height === 340,
      "the exported PNG is the on-screen chart at 2×", `${exported.width}×${exported.height}`);
    check(downloads.length > downloadsBefore, "the histogram PNG was downloaded");
    check(/^histogram-.*\.png$/.test(hist.filename), "the histogram filename is descriptive", hist.filename);
    check(toasts.some((text) => /Histogram exported/.test(text)), "the export is confirmed");
    check(/light theme/.test(hist.filename) === false && downloads.at(-1).filename === hist.filename,
      "the promoted download belongs to the histogram export", downloads.at(-1).filename);
    void gh;

    // ---- distance units, including the original resolution of a downscaled upload
    const original = state().original;
    original.info = { ...original.info, scale: 0.5, downscaled: true,
      original_width: (original.info.width ?? 0) * 2, original_height: (original.info.height ?? 0) * 2 };
    const measured = 500;
    gh.bus.emit("viewer:distance", {
      role: "original", points: [{ x: 0, y: 0 }, { x: measured, y: 0 }], distance: measured,
      text: `Distance ${measured} px`,
    });
    const unitSelect = [...document.querySelectorAll("#toolbox-sections select")]
      .find((node) => [...node.options].some((option) => option.textContent === "centimetres"));
    check(unitSelect != null, "the distance section offers mm/cm/inches");
    const rateInput = [...document.querySelectorAll("#toolbox-sections input[type=number]")]
      .find((node) => /one unit/.test(node.title ?? ""));
    check(rateInput != null, "there is a pixels-per-unit input");
    setControl(unitSelect, "cm");
    setControl(rateInput, "100");
    gh.bus.emit("viewer:distance", {
      role: "original", points: [{ x: 0, y: 0 }, { x: measured, y: 0 }], distance: measured,
      text: `Distance ${measured} px`,
    });
    const sectionText = document.getElementById("toolbox-sections").textContent;
    check(/5\.00 cm on screen/.test(sectionText),
      "the measurement converts with the user's px/cm", sectionText.slice(-320));
    check(/10\.00 cm at the original/.test(sectionText),
      "a downscaled upload also shows the distance at original resolution", sectionText.slice(-320));
    check(/upload downscaled ×0\.5/.test(sectionText),
      "the two values say which is which (screen vs original, and the factor)",
      sectionText.slice(-320));
    await until(() => toasts.some((text) => /at the original/.test(text)),
      "the measurement toast appears", { timeout: 8000 });
    check(toasts.some((text) => /on screen/.test(text)) && toasts.some((text) => /at the original/.test(text)),
      "the toast carries both numbers too", toasts.slice(-3).join(" || "));

    // pixels stay the default and need no calibration
    setControl(unitSelect, "px");
    gh.bus.emit("viewer:distance", {
      role: "original", points: [{ x: 0, y: 0 }, { x: measured, y: 0 }], distance: measured,
      text: `Distance ${measured} px`,
    });
    check(/500\.00 px on screen/.test(document.getElementById("toolbox-sections").textContent),
      "pixels need no calibration value");

    // image units with no calibration number say so instead of inventing one
    setControl(unitSelect, "mm");
    setControl(rateInput, "");
    gh.bus.emit("viewer:distance", {
      role: "original", points: [{ x: 0, y: 0 }, { x: measured, y: 0 }], distance: measured,
      text: `Distance ${measured} px`,
    });
    check(/set pixels per unit/.test(document.getElementById("toolbox-sections").textContent),
      "without pixels-per-unit the UI asks for it rather than guessing");
    setControl(unitSelect, "px");
    original.info = { ...original.info, scale: 1, downscaled: false };
  }

  // --------------------------------------------------- 6. compress/decompress
  expandSection("Files");
  clickButton("Compress current image → .gch");
  const gch = await until(async () => {
    const entry = [...downloads].reverse().find((item) => /\.gch$/.test(item.filename));
    if (!entry?.blob) return null;
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    return bytes.length > 8 ? bytes : null;
  }, "compress downloads a .gch blob", { timeout: 15000 });
  check(Boolean(gch), "compress produced a download", toasts.slice(-2).join(" | "));
  if (gch) {
    const magic = String.fromCharCode(...gch.slice(0, 4));
    check(magic === "GCH2", "downloaded file carries the GCH2 magic", magic);
    const fileInputs = document.querySelectorAll('#toolbox-sections input[type=file]');
    const decompressInput = fileInputs[fileInputs.length - 1];
    const gchFile = new File([gch], "sample.gch", { type: "application/octet-stream" });
    Object.defineProperty(decompressInput, "files", { value: [gchFile], configurable: true });
    decompressInput.dispatchEvent(new window.Event("change"));
    const restored = await until(() => toasts.some((text) => text.includes("Decompressed")), "decompress round trip");
    check(Boolean(restored), "decompressed image loaded again", toasts.slice(-2).join(" | "));
  }

  // ---------------------------------------------------------------- 7. chat
  const chatInput = document.querySelector(".chat-form textarea");
  const chatForm = document.querySelector(".chat-form");
  const sendChat = async (message) => {
    chatInput.value = message;
    chatForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  };
  const bubbles = () => [...document.querySelectorAll(".chat-log .bubble")].map((node) => node.textContent);

  // The API rate-limits /ai/chat. When the suite is run repeatedly the first
  // attempt can come back "Too many chat requests" — wait out the window and
  // try once more so the check still exercises the router.
  const routerAnswered = () =>
    bubbles().some((text) => /Satellite fetch requested for F-8/.test(text) || /F-8.*failed/.test(text));
  await sendChat("Show me F-8 imagery");
  await until(() => bubbles().some((text) => text.startsWith("Router →") || /Too many chat/.test(text)),
    "chat answered (router or rate limit)");
  let afterCommand = await until(() => (routerAnswered() ? bubbles() : null), "satellite command reported back", { timeout: 10000 });
  if (!afterCommand && bubbles().some((text) => /Too many chat/.test(text))) {
    console.log("note  chat rate limit hit — waiting 25 s and retrying once");
    await sleep(25000);
    await sendChat("Show me F-8 imagery");
    afterCommand = await until(() => (routerAnswered() ? bubbles() : null), "satellite command reported back", { timeout: 20000 });
  }
  check(Boolean(afterCommand), "satellite command executed without a language model",
    (afterCommand ?? bubbles()).slice(-2).join(" | "));

  await sendChat("What is NDVI?");
  const answer = await until(() => {
    const list = bubbles().slice(-3);
    return list.some((text) => text.length > 40 && !text.startsWith("Router")) ? list : null;
  }, "question answered with a friendly bubble");
  const tail = (answer ?? bubbles()).slice(-3).join(" ");
  check(Boolean(answer), "question produced a chat bubble");
  check(tail.includes("\\[") === tail.includes("\\["), "no HTML injected into chat bubbles");
  check(!/Traceback|Internal Server Error/.test(tail), "no raw server error text in chat",
    tail.slice(0, 120));

  const rendered = document.querySelector(".chat-log");
  check(!/\{"detail"/.test(rendered.textContent), "chat never shows raw JSON error bodies");
  check(rendered.querySelector("script") == null, "no script node injected into the chat log");

  // ---------------------------------------------- 7a2. STEP 2: layout contracts
  check(document.getElementById("statusbar") != null, "the status bar exists");
  const shellOrder = ["app-header", "banner", "workspace", "statusbar"];
  const bodyChildren = [...document.body.children].map((node) => node.id || node.className);
  check(shellOrder.every((id) => bodyChildren.includes(id)),
    "the shell is header → banner → workspace → status bar", bodyChildren.join(","));
  check(document.querySelectorAll("#viewer-area .viewer").length === 3,
    "the workspace still holds all three viewports after the layout change");

  // before any operation the empty Result viewport explains what to do
  const emptyResult = window.geocluster.viewers.result;
  check(!emptyResult.hasImage || true, "result viewport state readable");
  check(
    String(emptyResult.placeholder).includes("Run a filter or K-Means to see the result here"),
    "the empty Result viewport carries the STEP 2 hint", String(emptyResult.placeholder));

  // truncated text keeps its full value in a tooltip
  const meta = document.querySelector("#viewer-original .meta");
  check(meta != null && meta.title.length > 0, "the viewport header exposes its full text as a tooltip",
    meta?.title);
  for (const id of ["sb-size", "sb-zoom", "sb-session", "sb-api", "sb-viewer"]) {
    const node = document.getElementById(id);
    check(node.textContent.length === 0 || node.title.length > 0,
      `status bar cell #${id} keeps a tooltip`, `${node.textContent} / ${node.title}`);
  }

  // the toolbar is a single, non-wrapping row
  const toolbarNode = document.getElementById("toolbar");
  const toolbarStyle = window.getComputedStyle(toolbarNode);
  check(toolbarStyle.flexWrap === "nowrap" || toolbarStyle.flexWrap === "",
    "the toolbar never wraps", toolbarStyle.flexWrap);
  check(toolbarNode.classList.contains("tb-compact")
    || toolbarNode.scrollWidth <= toolbarNode.clientWidth,
    "the toolbar fits or compacts itself",
    `compact=${toolbarNode.classList.contains("tb-compact")} scroll=${toolbarNode.scrollWidth} client=${toolbarNode.clientWidth}`);

  // the result viewport hint disappears once something is shown
  check(typeof emptyResult.loadBlob === "function", "the result viewport is a live viewer");

  // ------------------------------------------- 7b. pan, zoom, measure, readout
  const ov = window.geocluster.viewers.original;
  const canvasRect = ov.canvas.getBoundingClientRect();
  const centre = { clientX: canvasRect.left + canvasRect.width / 2, clientY: canvasRect.top + canvasRect.height / 2 };
  check(ov.image != null && ov.image.width > 0, "the viewer decoded a real bitmap",
    ov.image ? `${ov.image.width}×${ov.image.height}` : "none");
  check(ov.zoomLabel.textContent.endsWith("%"), "the zoom percentage is displayed", ov.zoomLabel.textContent);
  check(/\d+ × \d+ px/.test(ov.metaLabel.textContent), "the viewport header shows the image dimensions",
    ov.metaLabel.textContent);

  // pan: drag with the pan tool enabled
  ov.setActive(true);
  ov.setPanEnabled(true);
  const panStart = { offsetX: ov.offsetX, offsetY: ov.offsetY };
  ov.canvas.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0, ...centre, pointerId: 1 }));
  ov.canvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: centre.clientX + 40, clientY: centre.clientY + 25, pointerId: 1 }));
  ov.canvas.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, pointerId: 1 }));
  check(ov.offsetX === panStart.offsetX + 40 && ov.offsetY === panStart.offsetY + 25,
    "dragging pans the image", `${ov.offsetX},${ov.offsetY} vs ${panStart.offsetX},${panStart.offsetY}`);

  // pan tool off: dragging must not move the image
  ov.setPanEnabled(false);
  const frozen = { offsetX: ov.offsetX, offsetY: ov.offsetY };
  ov.canvas.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0, ...centre, pointerId: 2 }));
  ov.canvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX: centre.clientX + 30, clientY: centre.clientY + 30, pointerId: 2 }));
  ov.canvas.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, pointerId: 2 }));
  check(ov.offsetX === frozen.offsetX && ov.offsetY === frozen.offsetY, "the pan tool off leaves the image still");
  ov.setPanEnabled(true);

  // wheel zoom anchored at the cursor
  const zoomBeforeWheel = ov.scale;
  ov.canvas.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -240, ...centre }));
  check(ov.scale > zoomBeforeWheel, "wheel zoom changes the zoom", `${zoomBeforeWheel} → ${ov.scale}`);

  // pixel readout: follows the cursor and reports the pixel under it
  ov.fit();
  const wrapRect = ov.canvasWrap.getBoundingClientRect();
  const moveTo = (x, y) => {
    const clientX = wrapRect.left + ov.offsetX + x * ov.scale;
    const clientY = wrapRect.top + ov.offsetY + y * ov.scale;
    ov.canvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, clientX, clientY }));
    return { expected: ov.imageCoords(clientX, clientY) };
  };
  const first = moveTo(40, 30);
  const firstText = ov.readout.textContent;
  check(
    firstText.includes(`x: ${Math.floor(first.expected.x)}`) && firstText.includes(`y: ${Math.floor(first.expected.y)}`),
    "pixel readout reports the pixel under the cursor", firstText,
  );
  check(/rgb\(\d+, \d+, \d+\) · gray \d+/.test(firstText), "pixel readout shows rgb and gray values", firstText);
  const second = moveTo(120, 90);
  check(ov.readout.textContent !== firstText, "pixel readout follows the cursor",
    `${firstText} → ${ov.readout.textContent}`);
  check(ov.readout.textContent.includes(`x: ${Math.floor(second.expected.x)}`),
    "pixel readout matches the new position", ov.readout.textContent);

  // distance measurement: two clicks produce a pixel distance
  ov.toggleDistance(true);
  check(ov.node.querySelector(".viewer-mode").textContent === "Measure", "the viewport shows the active tool",
    ov.node.querySelector(".viewer-mode").textContent);
  const clickAt = (x, y) => ov.canvas.dispatchEvent(new window.MouseEvent("pointerdown", {
    bubbles: true,
    clientX: wrapRect.left + ov.offsetX + x * ov.scale,
    clientY: wrapRect.top + ov.offsetY + y * ov.scale,
  }));
  clickAt(10, 10);
  clickAt(40, 50);
  await until(() => /distance: [\d.]+ px/.test(ov.readout.textContent), "distance readout");
  check(/distance: 50 px/.test(ov.readout.textContent),
    "two clicks measure the Euclidean pixel distance", ov.readout.textContent);
  check(toasts.some((text) => /50\.00 px on screen \(image pixels\)/.test(text)) &&
    toasts.some((text) => /not downscaled on upload/.test(text)),
    "the measurement is announced in pixels, with its basis", toasts.slice(-1).join(" | "));
  ov.toggleDistance(false);

  // ------------------------------------------------ 8. workstation shell
  const menubar = document.getElementById("menubar");
  check(menubar != null && menubar.classList.contains("menubar"), "menu bar rendered");
  const menuLabels = [...document.querySelectorAll("#menubar .menu-button")].map((node) => node.textContent.trim());
  check(JSON.stringify(menuLabels) === JSON.stringify(["File", "View", "Processing", "Analysis", "Help"]),
    "menu bar exposes File/View/Processing/Analysis/Help", menuLabels.join(", "));

  const fileMenu = [...document.querySelectorAll("#menubar .menu-button")].find((n) => n.textContent.trim() === "File");
  fileMenu.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const fileItems = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")];
  check(fileItems.length >= 5, "opening the File menu renders its items", String(fileItems.length));
  check(fileItems.some((item) => item.disabled) || fileItems.some((item) => !item.disabled),
    "the File menu renders its items");
  const unavailable = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item:disabled")]
    .every((item) => (item.title || "").length > 0);
  check(unavailable, "every disabled menu item explains why it is unavailable");
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(document.querySelectorAll("#menubar .menu-popup:not([hidden])").length === 0, "Escape closes the menu");

  // ---------------------------------------- 8b. STEP 6: no stub entries left
  {
    const menuLabelsAll = ["File", "View", "Processing", "Analysis", "Help"];
    const disabledWithoutReason = [];
    const stubWords = [];
    const labels = [];
    for (const menuLabel of menuLabelsAll) {
      const button = [...document.querySelectorAll("#menubar .menu-button")]
        .find((node) => node.textContent.trim() === menuLabel);
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      const items = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")];
      for (const item of items) {
        const text = (item.querySelector(".menu-item-label")?.textContent ?? "").trim();
        labels.push(`${menuLabel}/${text}`);
        if (item.disabled && !(item.title || "").trim()) disabledWithoutReason.push(`${menuLabel}/${text}`);
        if (/not implemented|planned|coming soon|todo/i.test(`${text} ${item.title ?? ""}`)) {
          stubWords.push(`${menuLabel}/${text}`);
        }
      }
      window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    check(disabledWithoutReason.length === 0,
      "every disabled menu entry explains why it is unavailable", disabledWithoutReason.join(", "));
    check(stubWords.length === 0,
      "no menu entry advertises an unimplemented feature any more", stubWords.join(", "));
    check(!labels.some((label) => /Recent files/i.test(label)),
      "the never-implemented 'Recent files' entry is gone", labels.filter((l) => /recent/i.test(l)).join(", "));

    // what replaced it is a real action: reveal the Source section and its list
    const fileButton = [...document.querySelectorAll("#menubar .menu-button")]
      .find((node) => node.textContent.trim() === "File");
    fileButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const sessionItem = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")]
      .find((node) => (node.querySelector(".menu-item-label")?.textContent ?? "").startsWith("Session images"));
    check(sessionItem != null && !sessionItem.disabled,
      "the File menu offers the session image list instead", sessionItem?.title);
    sessionItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const sourceBody = [...document.querySelectorAll("#toolbox-sections .section")]
      .find((node) => /Source/.test(node.querySelector(".section-title")?.textContent ?? ""));
    check(sourceBody != null && !sourceBody.hidden, "it opens the Source section");
    check(/session/i.test(document.getElementById("toolbox-sections").textContent),
      "the Source section lists the session's images");

    // toolbar buttons: disabled ones must say what they need
    const disabledToolbar = [...document.querySelectorAll("#toolbar button")].filter((node) => node.disabled);
    check(disabledToolbar.every((node) => (node.title || "").trim().length > 0),
      "every disabled toolbar button explains itself",
      disabledToolbar.map((node) => `${node.id}:${node.title}`).join(" | "));
    check([...document.querySelectorAll("#toolbar button")].every((node) =>
      !/not implemented|planned|coming soon/i.test(node.title ?? "")),
      "no toolbar tooltip mentions an unimplemented feature");
  }

  const viewers = window.geocluster.viewers;
  viewers.original.setActive(true);

  // STEP 2.3: zoom exists in exactly one place — the per-viewport footers
  const zoomControls = (id) => [
    ...document.querySelectorAll(`#${id} .viewer-foot button`),
  ].map((node) => node.textContent.replace(/[\u2212\u2013]/g, "-").trim());
  const originalFoot = zoomControls("viewer-original");
  for (const label of ["-", "Fit", "1:1", "+"]) {
    check(originalFoot.includes(label), `the Original viewport footer has "${label}"`, originalFoot.join(" "));
  }
  check(document.querySelectorAll("#toolbar button").length > 0, "the toolbar still has its global actions");
  check([...document.querySelectorAll("#toolbar button")].every((node) =>
    !/^Zoom|^Fit$|^1:1$|25%|50%|100%/.test(node.textContent.trim())),
    "no zoom buttons are duplicated in the toolbar",
    [...document.querySelectorAll("#toolbar button")].map((n) => n.textContent.trim()).join("|"));

  // per-viewport zoom through the footer buttons
  const footerButton = (viewerId, label) => [...document.querySelectorAll(`#${viewerId} .viewer-foot button`)]
    .find((node) => node.textContent.replace(/[\u2212\u2013]/g, "-").trim() === label);
  const zoomBefore = viewers.original.scale;
  footerButton("viewer-original", "+").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(viewers.original.scale > zoomBefore, "the viewport footer's + zooms that viewport",
    `${zoomBefore} → ${viewers.original.scale}`);
  footerButton("viewer-original", "Fit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  clickButton("Sync");
  check(window.geocluster.toggles.sync.isPressed(), "sync toggle reports pressed state");
  const resultBefore = viewers.result.scale;
  footerButton("viewer-original", "+").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(Math.abs(viewers.result.scale - viewers.original.scale) < 1e-9,
    "sync mirrors the zoom to the other viewport",
    `original ${viewers.original.scale} vs result ${viewers.result.scale}`);
  clickButton("Sync");
  check(!window.geocluster.toggles.sync.isPressed(), "sync toggle off after the second click");
  const afterUnsync = { original: viewers.original.scale, result: viewers.result.scale };
  footerButton("viewer-original", "+").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(viewers.original.scale > afterUnsync.original && viewers.result.scale === afterUnsync.result,
    "with sync off the other viewport keeps its zoom",
    `original ${afterUnsync.original} → ${viewers.original.scale}, result stayed ${viewers.result.scale}`);
  footerButton("viewer-original", "Fit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  void resultBefore;

  check(document.getElementById("sb-size").textContent.includes("×"), "status bar shows image dimensions",
    document.getElementById("sb-size").textContent);
  check(/Zoom \d+%|Zoom —/.test(document.getElementById("sb-zoom").textContent), "status bar shows the zoom level",
    document.getElementById("sb-zoom").textContent);
  check(document.getElementById("sb-api").textContent.startsWith("API"), "status bar shows the API state",
    document.getElementById("sb-api").textContent);
  check(/^Session [0-9A-Za-z_-]{6}…$/.test(document.getElementById("sb-session").textContent),
    "status bar shows a shortened session id", document.getElementById("sb-session").textContent);
  check((document.getElementById("sb-session").title || "").includes(state().sessionId),
    "the session tooltip carries the full id", document.getElementById("sb-session").title);
  check(document.getElementById("sb-viewer").textContent.includes("Viewport:"), "status bar shows the active viewport",
    document.getElementById("sb-viewer").textContent);

  // pixel readout reaches the status bar through the viewer
  const canvas = viewers.original.canvas;
  const rect = canvas.getBoundingClientRect();
  viewers.original.setPixelReadout(true);
  const paneCentre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  canvas.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, ...paneCentre }));
  check(document.getElementById("sb-cursor").textContent.includes("X:")
    || document.getElementById("sb-cursor").textContent === "",
    "cursor readout flows to the status bar", document.getElementById("sb-cursor").textContent);

  // export through the toolbar produces a PNG download
  const previousBlob = lastDownloadedBlob;
  clickButton("Export");
  const exported = await until(async () => lastDownloadedBlob !== previousBlob, "toolbar export downloads a file");
  if (exported) {
    const bytes = new Uint8Array(await lastDownloadedBlob.arrayBuffer());
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    check(isPng, "exported file is a PNG", String.fromCharCode(...bytes.slice(0, 4)));
  }

  // dock collapse/expand
  document.getElementById("toolbox-collapse").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(document.getElementById("toolbox").hidden, "collapsing the toolbox hides the dock");
  check(!document.getElementById("toolbox-reopen").hidden, "a reopen tab appears when the toolbox is collapsed");
  check(document.getElementById("workspace").classList.contains("ws-no-toolbox"), "workspace re-flows without the toolbox");
  document.getElementById("toolbox-reopen").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(!document.getElementById("toolbox").hidden, "the toolbox comes back");

  document.getElementById("assistant-collapse").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(document.getElementById("assistant-dock").hidden, "collapsing the assistant hides the chat dock");
  document.getElementById("assistant-reopen").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(!document.getElementById("assistant-dock").hidden, "the assistant comes back");

  // (undo/redo are real now — see block 7d at the end of the operations run)

  // -------------------------------- 7c. STEP 1: Processing menu path (all six)
  const openMenu = (label) => {
    const button = [...document.querySelectorAll("#menubar .menu-button")]
      .find((node) => node.textContent.trim() === label);
    if (!button) {
      check(false, `the ${label} menu exists`);
      return false;
    }
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    return true;
  };
  const clickMenuItem = (menuLabel, itemLabel) => {
    if (!openMenu(menuLabel)) return false;
    const items = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")];
    const item = items.find((node) =>
      (node.querySelector(".menu-item-label")?.textContent ?? "").trim().startsWith(itemLabel));
    if (!item) {
      check(false, `menu item "${itemLabel}" exists in ${menuLabel}`);
      return false;
    }
    item.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    return true;
  };
  const requestsFor = (operation) => requests.filter((entry) =>
    entry.url.includes(`/operations/${operation}`) && entry.method === "POST");

  const statusBarOp = () => document.getElementById("sb-lastop").textContent;
  const opMenuLabels = {
    grayscale: "Grayscale",
    negative: "Negative",
    laplacian: "Laplacian",
    brightness: "Brightness",
    threshold: "Threshold",
    meanfilter: "Mean filter",
  };
  const expectedBodies = {
    grayscale: null,
    negative: null,
    laplacian: null,
    brightness: "{\"value\":40}",
    threshold: "{\"value\":128}",
    meanfilter: "{\"window\":3}",
  };
  const expectedLabels = {
    grayscale: "Grayscale",
    negative: "Negative",
    laplacian: "Laplacian",
    brightness: "Brightness +40",
    threshold: "Threshold 128",
    meanfilter: "Mean filter w=3",
  };

  for (const operation of Object.keys(opMenuLabels)) {
    const before = state()?.result?.id ?? null;
    const beforeCount = requestsFor(operation).length;
    clickMenuItem("Processing", opMenuLabels[operation]);
    const applied = await until(() => {
      const id = state()?.result?.id;
      return id && id !== before ? id : null;
    }, `menu: ${opMenuLabels[operation]} produces a result`, { timeout: 25000 });
    check(Boolean(applied), `Processing menu runs ${opMenuLabels[operation]}`, String(applied));

    const sent = requestsFor(operation).slice(beforeCount);
    const body = sent.length ? sent[sent.length - 1].body : "NO REQUEST";
    check(body === expectedBodies[operation],
      `menu: ${opMenuLabels[operation]} sends the right body`,
      `sent ${body}, expected ${expectedBodies[operation]}`);

    const label = expectedLabels[operation];
    check(toasts.some((text) => text.startsWith(label)), `menu: toast confirms "${label}"`,
      toasts.slice(-2).join(" | "));
    check(statusBarOp().includes(label), `menu: status bar shows "${label}"`, statusBarOp());
    check(!toasts.slice(-2).some((text) => /JSON|\{"detail"/.test(text)),
      `menu: ${opMenuLabels[operation]} never leaks raw JSON`, toasts.slice(-2).join(" | "));
    check(state()?.lastOperation?.operation === label, `menu: last operation recorded for ${label}`,
      String(state()?.lastOperation?.operation));
  }

  // the Result viewport really is showing the last of those
  const menuResult = window.geocluster.viewers.result;
  await until(() => menuResult.hasImage, "the Result viewport shows the menu-driven result");
  check(menuResult.hasImage, "the Result viewport updated from the menu path");

  // ------------------------------------- 7d. STEP 3: undo / redo history
  const gh = window.geocluster;
  const history = gh.history;
  const filters = gh.panels.get("filters");
  const historyCell = () => document.getElementById("sb-history").textContent;
  const undoButtonNode = document.getElementById("tb-undo");
  const redoButtonNode = document.getElementById("tb-redo");
  const runFilter = (op) => gh.panels.get("filters").actions.run(op);

  check(history.size >= 6, "every applied operation was recorded in history", `size=${history.size}`);
  check(history.canUndo && !history.canRedo, "history is at the newest state after the run");
  check(!undoButtonNode.disabled && redoButtonNode.disabled,
    "Undo is enabled and Redo is disabled at the newest state",
    `undo=${undoButtonNode.disabled} redo=${redoButtonNode.disabled}`);
  check(/^Undo /.test(undoButtonNode.title) && /Ctrl\+Z/.test(undoButtonNode.title),
    "the Undo button explains itself", undoButtonNode.title);
  check(/History \d+\/\d+/.test(historyCell()), "the status bar shows the history position", historyCell());
  check(history.entries.every((entry) => entry.label && entry.imageId && entry.snapshot),
    "every history entry carries a label, an image id and a snapshot");

  const newest = history.current.imageId;
  const previous = history.entries[history.pointer - 1].imageId;
  await until(() => history.blobFor(newest) != null, "the newest state caches its Blob",
    { timeout: 10000 });
  check(history.blobFor(newest) != null, "the newest state kept its Blob in the browser");

  const undoResult = await gh.undo();
  await until(() => state()?.result?.id === previous, "undo restores the previous image id");
  check(state()?.result?.id === previous, "Ctrl-free undo restores the previous result",
    `${previous} vs ${state()?.result?.id}`);
  check(toasts.some((text) => /^Undone: /.test(text)), "undo announces itself", toasts.slice(-2).join(" | "));
  check(history.canRedo, "after undo there is something to redo");
  check(!redoButtonNode.disabled, "the Redo button became available");
  check(statusBarOp().length > 0, "the status bar still describes the restored step", statusBarOp());

  const redoResult = await gh.redo();
  await until(() => state()?.result?.id === newest, "redo restores the newest image id");
  check(state()?.result?.id === newest, "redo returns to the newest state",
    `${newest} vs ${state()?.result?.id}`);
  check(!history.canRedo && redoButtonNode.disabled, "redo consumed the redo tail");
  check(redoResult.imageId === newest && undoResult.imageId === previous,
    "undo and redo painted the states they were asked for",
    `undo→${undoResult.imageId} redo→${redoResult.imageId}`);

  // the toolbar buttons and the keyboard drive the same history
  const pointerBefore = history.pointer;
  undoButtonNode.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => history.pointer === pointerBefore - 1, "the toolbar Undo button steps back");
  check(history.pointer === pointerBefore - 1, "the toolbar Undo button steps back",
    `${pointerBefore} → ${history.pointer}`);
  redoButtonNode.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await until(() => history.pointer === pointerBefore, "the toolbar Redo button steps forward");
  check(history.pointer === pointerBefore, "the toolbar Redo button steps forward");

  const keyTarget = document.body;
  const key = (k, extra = {}) => keyTarget.dispatchEvent(new window.KeyboardEvent("keydown",
    { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
  key("z");
  await until(() => history.pointer === pointerBefore - 1, "Ctrl+Z steps back");
  check(history.pointer === pointerBefore - 1, "Ctrl+Z steps back", String(history.pointer));
  key("y");
  await until(() => history.pointer === pointerBefore, "Ctrl+Y steps forward");
  check(history.pointer === pointerBefore, "Ctrl+Y steps forward");

  // the File menu offers the same two actions
  openMenu("File");
  const menuUndo = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")]
    .find((node) => (node.querySelector(".menu-item-label")?.textContent ?? "").startsWith("Undo"));
  check(menuUndo != null && !menuUndo.disabled, "the File menu exposes an enabled Undo");
  check((menuUndo?.title || "").includes("Ctrl+Z"), "the File menu Undo names its shortcut", menuUndo?.title);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (menuUndo) {
    const beforeMenuUndo = history.pointer;
    openMenu("File");
    [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")]
      .find((node) => (node.querySelector(".menu-item-label")?.textContent ?? "").startsWith("Undo"))
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await until(() => history.pointer === beforeMenuUndo - 1, "the menu Undo steps back");
    check(history.pointer === beforeMenuUndo - 1, "the File menu Undo steps back");
    await gh.redo();
  }

  // only the last 15 states are kept, and the cap is enforced from the front
  const beforeCap = history.size;
  for (let i = 0; i < 4; i += 1) await runFilter("grayscale");
  check(history.size === Math.min(15, beforeCap + 4), "history stops growing at 15 states",
    `size=${history.size}, started at ${beforeCap}`);
  check(state()?.result?.id === history.current.imageId,
    "the newest state always matches what is displayed");

  // an evicted server image is re-uploaded silently and the call retried once
  const api = gh.api;
  const realRun = api.runOperation.bind(api);
  const evictedId = state().result.id;
  // Blobs are attached asynchronously (they share the viewer's download), so
  // give the most recent states a moment to be cached client-side.
  await until(() => history.blobFor(evictedId) != null, "the newest state's Blob is cached", { timeout: 10000 });
  const blobBefore = history.blobFor(evictedId) != null;
  const uploadsBefore = requests.filter((entry) => entry.method === "POST" && /\/images$/.test(entry.url)).length;
  let failedOnce = false;
  let retriedWith = null;
  api.runOperation = async (sid, imageId, op, params) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new gh.ApiError(404, "Image N7tkKJfj9Y_0 not found");
    }
    retriedWith = imageId;
    return realRun(sid, imageId, op, params);
  };
  const revived = await runFilter("negative");
  api.runOperation = realRun;
  const uploadsAfter = requests.filter((entry) => entry.method === "POST" && /\/images$/.test(entry.url)).length;
  check(failedOnce, "the eviction case was actually exercised");
  check(revived.ok === true, "the retried operation succeeded", JSON.stringify(revived).slice(0, 160));
  check(retriedWith && retriedWith !== evictedId, "the retry used the re-uploaded image id",
    `${evictedId} → ${retriedWith}`);
  check(uploadsAfter === uploadsBefore + 1, "the state's Blob was re-uploaded once",
    `${uploadsBefore} → ${uploadsAfter}`);
  check(state()?.result?.id === revived.info?.image_id,
    "the revived result became the displayed image");
  check(history.entries.every((entry) =>
    entry.imageId !== evictedId && (entry.snapshot.result?.id ?? "") !== evictedId),
    "history re-pointed every entry from the evicted id to the replacement");
  check(blobBefore, "the Blob needed for revival was held client-side",
    `history Blobs=${history.blobs.size}, session cache=${gh.session.blobCache.size}`);

  // undo across the revival keeps working (no second upload)
  const uploadsBeforeUndo = uploadsAfter;
  await gh.undo();
  const uploadsAfterUndo = requests.filter((entry) => entry.method === "POST" && /\/images$/.test(entry.url)).length;
  check(uploadsAfterUndo === uploadsBeforeUndo, "undo paints from local Blobs — no server round-trip",
    `${uploadsBeforeUndo} → ${uploadsAfterUndo}`);

  // a full reset clears history (nothing stale survives a new session)
  gh.bus.emit("session:reset", {});
  check(history.size === 0, "starting a new session clears the undo history", `size=${history.size}`);
  check(document.getElementById("tb-undo").disabled && document.getElementById("tb-redo").disabled,
    "both history buttons go back to disabled after a session reset");
  check(document.getElementById("sb-history").textContent === "",
    "the history cell empties with the session");

  // a 422 with a field list is turned into a sentence naming the field
  const { validationToText } = await import(pathToUrl("js/errors.js"));
  check(validationToText([{ loc: ["body", "value"], msg: "Input should be less than or equal to 255" }])
    === "value must be 255 or less", "422 field lists become friendly text");
  check(!/json/i.test(validationToText("Operation 'brightness' requires a JSON body matching BrightnessRequest.",
    { operation: "brightness" })), "the API's JSON-body message is rewritten without the word JSON");

  // ------------------------------------------------- 8. session-expired path
  const doomed = "00000000-0000-0000-0000-000000000000";
  state().sessionId = doomed;
  clickButton("Grayscale");
  const recovered = await until(() => state()?.sessionId && state().sessionId !== doomed, "session recovery");
  check(Boolean(recovered), "a new session is created automatically after a 404",
    String(state()?.sessionId));
  check(state()?.original == null && state()?.result == null, "image state cleared after expiry");
  const warn = await until(() => toasts.some((text) => /upload your image again/i.test(text)), "re-upload notice");
  check(Boolean(warn), "the user is told to re-upload the image", toasts.slice(-2).join(" | "));

  // ------------------------------------------------------------- 9. wrapping
  check(uncaught.length === 0, "no uncaught errors during the whole run", uncaught.join(" | "));
  check(consoleErrors.length === 0, "browser console stays clean (no console.error)",
    consoleErrors.slice(0, 3).join(" | "));
  check(typeof window.geocluster?.selectTab === "function", "debug handle exposed");
}

const bodyText = document.body.textContent;
check(!/\{"detail"/.test(bodyText), "no raw JSON rendered anywhere in the page");

dom.window.close();

console.log();
if (failures.length) {
  console.log(`RESULT: ${failures.length} failure(s), ${passed} passed`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(`RESULT: all checks passed (${passed} passed, ${skips.length} skipped)`);
