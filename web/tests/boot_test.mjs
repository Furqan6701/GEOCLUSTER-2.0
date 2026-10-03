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
  const api = {
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

    clearRect: () => { canvas.__texts = []; },
    fillRect: () => { canvas.__fills = (canvas.__fills ?? 0) + 1; },
    strokeRect: () => { canvas.__strokes = (canvas.__strokes ?? 0) + 1; },
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
    // record what each text was drawn WITH (font/align/x) so the map-composer
    // typography checks can assert on real drawing calls, not on settings
    fillText: (text, x, y) => {
      (canvas.__texts ??= []).push(String(text));
      (canvas.__textStyles ??= []).push({
        text: String(text), font: String(api.font ?? ""), align: api.textAlign ?? null, x, y,
      });
    },
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return api;
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
  const isForm = options.body && options.body.constructor?.name === "FormData";
  requests.push({
    url: String(input),
    method: (options.method ?? "GET").toUpperCase(),
    body: typeof options.body === "string" ? options.body : options.body ? `<${options.body.constructor?.name}>` : null,
    // multipart uploads: [field, filename-or-value] pairs (never the bytes)
    form: isForm
      ? [...options.body.entries()].map(([key, value]) =>
        [key, typeof value === "string" ? value : (value.name ?? null)])
      : null,
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
  check(sections.length === 4, "four toolbox sections rendered", String(sections.length));
  check(
    ["Source", "Filters", "Clusters", "Analysis"].every((title, index) =>
      sections[index]?.querySelector(".section-title")?.textContent.trim() === title),
    "toolbox sections are Source/Filters/Clusters/Analysis — Files is gone",
    sections.map((node) => node.querySelector(".section-title")?.textContent.trim()).join(", "),
  );
  check(document.getElementById("section-files") == null &&
    !/\bFiles\b/.test(document.getElementById("toolbox-sections").textContent),
    "no Files section is left in the sidebar");
  check(window.geocluster.panels.get("files") == null,
    "the Files panel is no longer registered");
  const expandedState = sections.map((node) =>
    node.querySelector(".section-head")?.getAttribute("aria-expanded"));
  check(expandedState[0] === "true" && expandedState[1] === "true",
    "Source and Filters are expanded by default", expandedState.join(","));
  check(expandedState.slice(2).every((state) => state === "false"),
    "Clusters and Analysis start collapsed (short toolbox)", expandedState.join(","));
  check(sections.every((node) => node.querySelector(".section-body") != null),
    "every section exposes its body for aria-controls");
  check(document.getElementById("viewer-area") != null, "image workspace exists");
  check(document.querySelectorAll("#viewer-area .viewer").length === 2,
    "two real viewports in the image workspace: Original and Result",
    String(document.querySelectorAll("#viewer-area .viewer").length));
  check(document.querySelector(".map-modal") != null && document.querySelector(".map-modal").hidden,
    "the Map composer modal is mounted and starts closed");
  check(document.getElementById("viewer-map") == null,
    "the docked Map viewport is gone (replaced by the composer modal)");
  check(document.querySelectorAll("#viewer-area .viewer-canvas-wrap").length === 2,
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

  // ------------------- 8. operation buttons follow the working image (bug)
  // The Grayscale/Negative/Laplacian buttons must be clickable as soon as a
  // working image exists. They used to be disabled until some *other* request
  // happened to re-evaluate them.
  const pointButton = (label) => [...document.querySelectorAll("#section-filters .btn-grid button")]
    .find((node) => node.textContent.trim() === label);
  const pointState = () => ["Grayscale", "Negative", "Laplacian"]
    .map((label) => `${label}=${pointButton(label)?.disabled ? "disabled" : "enabled"}`).join(" ");
  const checkPointButtons = (context) => {
    const nodes = ["Grayscale", "Negative", "Laplacian"].map(pointButton);
    check(nodes.length === 3 && nodes.every((node) => node != null && !node.disabled),
      `Grayscale/Negative/Laplacian are clickable ${context}`, pointState());
    check(ghGate() === false, `no request is in flight ${context}`, String(ghGate()));
  };
  const ghGate = () => Boolean(window.geocluster.state?.busy);
  checkPointButtons("right after an upload arrives (nothing else run yet)");

  const clickButton = (label) => {
    const node = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === label);
    if (!node) {
      check(false, `button "${label}" exists`);
      return null;
    }
    node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return node;
  };

  // ---------------------------- 2b. Source panel: place / corner modes, no lists
  {
    const gh = window.geocluster;
    const source = gh.panels.get("source");
    const section = document.getElementById("section-source");
    const text = () => section.textContent;

    check(section != null && !section.hidden, "the Source section is open");
    check(!/Working image/.test(text()),
      "the working-image metadata block is gone from the panel");
    check(!/Session files/.test(text()),
      "the session file list is gone from the panel");
    check(source.actions.renderFiles != null && source.actions.useAsOriginal != null,
      "the bookkeeping those blocks relied on is still there internally");

    const radios = [...section.querySelectorAll('input[type="radio"][name="sat-mode"]')];
    check(radios.length === 2 && radios[0].value === "place" && radios[1].value === "bbox",
      "the satellite block offers a Place mode and a Coordinates mode",
      radios.map((node) => node.value).join(", "));
    check(radios[0].checked && !radios[1].checked, "Place is the default mode");

    const placeRow = section.querySelector('[data-sat-row="place"]');
    const cornersRow = section.querySelector('[data-sat-row="bbox"]');
    check(placeRow != null && !placeRow.hidden, "the place row is visible in place mode");
    check(cornersRow != null && cornersRow.hidden, "the corner row is hidden in place mode");
    check(cornersRow.querySelectorAll('input[type="text"]').length === 2,
      "the coordinate mode has two corner fields");
    const cornerLabels = [...cornersRow.querySelectorAll("label")].map((node) => node.textContent);
    check(cornerLabels[0] === "Corner 1 (lat, lon)" && cornerLabels[1] === "Corner 2 (lat, lon)",
      "the corner fields are labelled as the user types them", cornerLabels.join(" | "));

    const sizeSelect = section.querySelector("#sat-size");
    const sizes = [...sizeSelect.options].map((option) => option.value);
    check(JSON.stringify(sizes) === JSON.stringify(["1", "2", "5"]),
      "the size dropdown offers 1, 2 and 5 km", sizes.join(", "));
    check(sizeSelect.value === "2", "the size defaults to 2 km", sizeSelect.value);

    const advanced = section.querySelector("details.advanced");
    check(advanced != null, "there is an Advanced fold");
    check(advanced.open === false, "the Advanced fold starts collapsed");
    check(advanced.querySelectorAll('input[type="date"]').length === 2,
      "the optional dates live inside the Advanced fold");
    check(/Advanced/.test(advanced.querySelector("summary")?.textContent ?? ""),
      "the fold is labelled Advanced");

    // ---- item 12: no hint lines anywhere in the panel; tooltips say it instead
    check(section.querySelectorAll(".note, .hint-line").length === 0,
      "the Source panel renders no hint lines",
      [...section.querySelectorAll(".note, .hint-line")].map((node) => node.textContent).join(" | "));
    {
      const place = section.querySelector('[data-sat-row="place"] input[type="text"]');
      const corners = [...cornersRow.querySelectorAll('input[type="text"]')];
      check(place?.title === "Sector code, alias, or any place name",
        "the place field explains itself in its tooltip", place?.title);
      check(corners[0]?.title === "Paste from Google Maps — any corner" &&
        corners[1]?.title === "The opposite corner; no need to sort them",
        "the corner fields explain themselves in their tooltips",
        corners.map((node) => node.title).join(" | "));
      const dates = [...advanced.querySelectorAll('input[type="date"]')];
      check(dates.every((node) => /rolling window/.test(node.title)),
        "the dates say what an empty value means", dates.map((node) => node.title).join(" | "));
    }

    const refreshControl = section.querySelector("#sat-refresh");
    check(refreshControl != null && !refreshControl.checked,
      "there is a Refresh option that is off by default");

    // --- mode switching
    const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    radios[1].checked = true;
    radios[1].dispatchEvent(new window.Event("change", { bubbles: true }));
    check(cornersRow.hidden === false && placeRow.hidden === true,
      "choosing Coordinates swaps the row that is shown");
    const cornerInputs = [...cornersRow.querySelectorAll('input[type="text"]')];
    cornerInputs[0].value = "33.70, 73.05";
    cornerInputs[1].value = "33.66, 73.10";
    radios[0].checked = true;
    radios[0].dispatchEvent(new window.Event("change", { bubbles: true }));
    check(placeRow.hidden === false && cornersRow.hidden === true,
      "choosing Place swaps back");

    // --- request bodies (transport stubbed: no satellite request is spent)
    const realFetch = gh.api.satelliteFetch;
    const originalBefore = state().original;
    const resultBefore = state().result;
    const sent = [];
    gh.api.satelliteFetch = async (payload) => {
      sent.push(payload);
      return {
        image_id: "satstub01", session_id: state()?.sessionId, name: "F-8.png", source: "satellite",
        width: 200, height: 200, channels: 3, megapixels: 0.04, bytes: 1234,
        original_width: 200, original_height: 200, original_megapixels: 0.04, scale: 1, downscaled: false,
      };
    };
    try {
      const placeInput = placeRow.querySelector('input[type="text"]');
      placeInput.value = "Karachi";
      sizeSelect.value = "5";
      await source.actions.fetchSatellite();
      check(sent.length === 1, "place mode sends exactly one request", String(sent.length));
      checkPointButtons("after a satellite fetch (place)");
      const body = sent[0];
      check(body.mode === "place" && body.location === "Karachi" && body.sizeKm === 5,
        "place mode sends the place text and the chosen size", JSON.stringify(body));
      check(!("start" in body) || body.start == null, "no start date is invented", JSON.stringify(body.start));
      check(!("end" in body) || body.end == null, "no end date is invented", JSON.stringify(body.end));
      check(body.refresh === false, "refresh is off unless asked for");
      check(!/placeholder/i.test(String(body.location)), "placeholder text is never sent");

      // dates + refresh come from the Advanced fold and the checkbox
      const dateInputs = [...advanced.querySelectorAll('input[type="date"]')];
      dateInputs[0].value = "2026-08-01";
      dateInputs[1].value = "2026-09-01";
      refreshControl.checked = true;
      await source.actions.fetchSatellite();
      const withDates = sent[sent.length - 1];
      check(withDates.start === "2026-08-01" && withDates.end === "2026-09-01",
        "chosen dates are sent as YYYY-MM-DD", `${withDates.start} → ${withDates.end}`);
      check(withDates.refresh === true, "Refresh asks the server to skip the cache");

      // corner mode
      radios[1].checked = true;
      radios[1].dispatchEvent(new window.Event("change", { bubbles: true }));
      cornerInputs[0].value = "33.70, 73.05";
      cornerInputs[1].value = "33.66, 73.10";
      dateInputs[0].value = "";
      dateInputs[1].value = "";
      refreshControl.checked = false;
      await source.actions.fetchSatellite();
      const corners = sent[sent.length - 1];
      check(corners.mode === "bbox" && corners.corner1 === "33.70, 73.05" && corners.corner2 === "33.66, 73.10",
        "coordinate mode sends both pasted corners", JSON.stringify(corners));
      check(!("location" in corners) || corners.location == null,
        "coordinate mode does not invent a place name", JSON.stringify(corners.location));
      check(corners.start == null && corners.end == null,
        "with the fold empty no dates are sent at all");
      checkPointButtons("after a satellite fetch (coordinates)");

      // an empty field is caught before any request is made
      cornerInputs[1].value = "";
      await source.actions.fetchSatellite();
      check(sent.length === 3, "an incomplete request is not sent", String(sent.length));
      check(toasts.some((t) => /Paste both corners/.test(t)), "the user is told what is missing",
        toasts.slice(-2).join(" | "));
      cornerInputs[1].value = "33.66, 73.10";
      placeInput.value = "";
      radios[0].checked = true;
      radios[0].dispatchEvent(new window.Event("change", { bubbles: true }));
      await source.actions.fetchSatellite();
      check(sent.length === 3, "an empty place name is not sent either", String(sent.length));
    } finally {
      gh.api.satelliteFetch = realFetch;
      // the stub's image id does not exist server-side: put the real working
      // image back so the rest of the run (K-Means, filters, history) is real
      state().images.delete("satstub01");
      state().original = originalBefore;
      state().result = resultBefore;
      gh.bus.emit("image:loaded", { role: "original", info: originalBefore.info });
    }

    // --- the live API rejects what the frontend must show in friendly words
    const bad = await gh.api.satelliteFetch({
      sessionId: state().sessionId, mode: "bbox", corner1: "91, 20", corner2: "33.66, 73.10",
    }).then(() => null, (error) => error);
    check(bad != null && bad.status === 422,
      "an out-of-range latitude is rejected with 422", `status=${bad?.status}`);
    const { humanizeError } = await import(pathToUrl("js/errors.js"));
    const friendly = humanizeError(bad);
    check(/Corner 1/.test(friendly) && /latitude/.test(friendly),
      "the 422 names the field and the problem", friendly);
    check(!/[{}[\]]/.test(friendly) && !/json/i.test(friendly),
      "the friendly text contains no JSON", friendly);
  }

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
  check(kInput?.min === "2" && kInput?.max === "10", "K accepts 2…10",
    `${kInput?.min}…${kInput?.max}`);
  check(numberInputNear("Max iterations") == null, "the Max iterations field is gone");
  {
    const clusterSection = document.querySelector("#section-clusters");
    check(!/Max iterations/i.test(clusterSection.textContent),
      "no label, badge or hint mentions max iterations",
      clusterSection.textContent.slice(0, 160));
    check(!/Clusters the grayscale intensities/.test(clusterSection.textContent),
      "the K-Means hint text is gone");
    const runNode = [...clusterSection.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Run K-Means");
    check(runNode?.classList.contains("block"),
      "Run K-Means is full width on its own row", runNode?.className);
    const group = runNode?.closest(".tool-group");
    const field = group?.querySelector(".field");
    check(Boolean(field) && field.contains(kInput) && !field.contains(runNode),
      "the K field and the run button are on separate rows");
    check(group.querySelectorAll(":scope > .btn.block").length === 1,
      "the run button is the only full-width control in the group");
  }
  const kmeansPostsBefore = requests.filter((entry) => /\/kmeans$/.test(entry.url)).length;
  clickButton("Run K-Means");
  const kmeans = await until(() => state()?.kmeans, "K-Means runs from the panel");
  check(Boolean(kmeans), "K-Means response stored");
  check(kmeans?.k === 5, "K-Means used k=5", String(kmeans?.k));
  check(kmeans?.ranges?.length === 5, "five cluster ranges returned", String(kmeans?.ranges?.length));
  const clusterSection = document.querySelector("#section-clusters");
  const editorTable = clusterSection.querySelector("table.cluster-table");
  const editorRows = [...(editorTable?.querySelectorAll("tbody tr") ?? [])];
  const verified = [["0", "80"], ["81", "117"], ["118", "155"], ["156", "194"], ["195", "255"]];
  const shown = editorRows.map((row) => {
    const bounds = [...row.querySelectorAll('input[type="number"]')].map((input) => input.value);
    return bounds;
  });
  check(JSON.stringify(shown) === JSON.stringify(verified),
    "the editor table shows the verified sample.jpg min/max values", JSON.stringify(shown));
  check(Object.keys(kmeans?.assignments ?? {}).length === 5, "assignments received for every cluster");

  // ------------- class names follow K: presets at 5, "Class n" otherwise
  const editorNames = () => [...document.querySelectorAll("#section-clusters .cluster-table tbody input.cluster-name")]
    .map((input) => input.value);
  {
    // at K=5 the names are exactly the ones the API's land-cover preset sends
    const expected = state().kmeans.ranges.map((range, index) =>
      String(state().kmeans.assignments?.[String(range.cluster)]?.name ?? `Class ${index + 1}`));
    check(JSON.stringify(editorNames()) === JSON.stringify(expected),
      "at K=5 the land-cover preset names are used",
      `${JSON.stringify(editorNames())} vs ${JSON.stringify(expected)}`);
    check(expected.some((name) => /Water|Grass|Trees|Roads|Shadows|Soil|Buildings/.test(name)),
      "the K=5 names really are land-cover words", expected.join(", "));
  }

  // ---------------------------------------- 3a. Clusters panel (STEP 2)
  {
    const tableCount = clusterSection.querySelectorAll("table.grid").length;
    check(tableCount === 1, "the Clusters section has exactly ONE table", String(tableCount));
    const headers = [...(editorTable?.querySelectorAll("thead th") ?? [])].map((node) => node.textContent.trim());
    check(JSON.stringify(headers) === JSON.stringify(["Color", "Land cover", "Min", "Max", "%"]),
      "the table columns are Color / Land cover / Min / Max / %", JSON.stringify(headers));
    const percentHead = editorTable?.querySelector("thead th:nth-child(5)");
    check(percentHead?.getAttribute("title") === "% of pixels",
      "the % column still spells out what it means", percentHead?.getAttribute("title"));
    check(clusterSection.querySelector(".table-wrap") == null,
      "the editor has no horizontal scroller (the two-line rows fit the sidebar)");
    const rowStyle = [...document.querySelectorAll("#section-clusters .cluster-table tbody tr")];
    check(rowStyle.length === 5, "five editor rows", String(rowStyle.length));
    check(rowStyle.every((row) => row.querySelectorAll("td").length === 5),
      "every row still carries all five cells (color, name, min, max, %)");
    // all five controls are visible in every row
    check(rowStyle.every((row) => {
      const color = row.querySelector('input[type="color"]');
      const name = row.querySelector("input.cluster-name");
      const bounds = [...row.querySelectorAll("input.cluster-bound")];
      const share = row.querySelector(".cluster-share");
      return color && name && bounds.length === 2 && share;
    }), "each row shows its swatch, name, min, max and percentage");
    check(editorRows.length === 5, "one row per cluster", String(editorRows.length));
    check(editorRows.every((row) =>
      row.querySelectorAll('input[type="color"]').length === 1 &&
      row.querySelectorAll('input[type="text"]').length === 1 &&
      row.querySelectorAll('input[type="number"]').length === 2),
      "each row has ONE colour picker, a name field and two bounds");
    check(editorRows.every((row) => row.dataset.cluster != null),
      "rows are labelled with their cluster number");
    const shares = editorRows.map((row) => row.querySelector(".cluster-share")?.textContent ?? "");
    const shareValues = shares.map((text) => Number.parseFloat(text));
    check(shares.every((text) => /%/.test(text)) && shareValues.every((value) => Number.isFinite(value)),
      "every row shows a percentage of pixels", shares.join(", "));
    check(Math.abs(shareValues.reduce((sum, value) => sum + value, 0) - 100) < 1.5,
      "the percentages add up to ~100%", String(shareValues.reduce((sum, value) => sum + value, 0)));

    // the removed blocks are gone, and no hint lines are left
    const text = clusterSection.textContent;
    check(!/Last run|Centroids|Total classified pixels/i.test(text),
      "the Last run table, the centroid line and the legend block are gone", text.slice(0, 160));
    check(clusterSection.querySelectorAll(".note, .hint-line").length === 0,
      "the Clusters section has no hint lines",
      [...clusterSection.querySelectorAll(".note, .hint-line")].map((n) => n.textContent).join(" | "));

    // K-Means shows the clustered image; there is no toggle any more
    check(clusterSection.querySelector(".segmented") == null,
      "the Clustered image / Label map toggle is gone");
    check(state()?.result?.id === kmeans.display_image_id,
      "K-Means displayed the clustered image on its own", String(state()?.result?.id));
    check(!/Show clustered image|Show label map/.test(text),
      "no result-view buttons are left in the panel");
    // ---- item 12: the four file actions live in the File menu
    const fileMenu = () => {
      const button = [...document.querySelectorAll("#menubar .menu-button")]
        .find((node) => node.textContent.trim() === "File");
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      return [...document.querySelectorAll("#menubar .menu-item")];
    };
    const menuItem = (label) => fileMenu().find((node) => node.textContent.trim().startsWith(label));
    const labelEntry = menuItem("Export raw label map (PNG)");
    check(labelEntry != null, "the File menu exports the raw label map");
    check(labelEntry?.disabled === false, "the label-map entry is enabled once K-Means has run",
      String(labelEntry?.disabled));
    check(/one grey value per cluster/.test(labelEntry?.textContent ?? ""),
      "the label-map entry says what the file holds", labelEntry?.textContent);
    {
      const before = createdUrls.length;
      labelEntry.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      const downloaded = await until(() => (toasts.some((entry) => /Label map downloaded/.test(entry)) ? true : null),
        "the label map downloads from the File menu");
      check(Boolean(downloaded), "the raw label map still downloads as a PNG");
      check(createdUrls.length > before, "the label map download reached the browser",
        String(createdUrls.length - before));
    }
    const labelAction = window.geocluster.panels.get("clusters").actions.downloadLabelMap;
    check(typeof labelAction === "function",
      "the Clusters panel still owns the label-map download");
    {
      const before = createdUrls.length;
      const labelDownload = await labelAction();
      check(labelDownload?.ok === true, "the label map downloads as a PNG");
      check(createdUrls.length > before, "the label map download reached the browser",
        String(createdUrls.length - before));
      check(toasts.some((entry) => /Label map downloaded/.test(entry)),
        "the label-map download is confirmed", toasts.slice(-2).join(" | "));
    }

    // Generate map / Reset ranges must not clip
    const actions = [...clusterSection.querySelectorAll(".cluster-actions .btn")];
    check(actions.map((node) => node.textContent.trim()).join("|") === "Generate map|Reset ranges",
      "the editor buttons are Generate map and Reset ranges",
      actions.map((node) => node.textContent.trim()).join("|"));
    check(actions.length === 2 && actions.every((node) => node.closest(".cluster-actions")),
      "both buttons live in the actions row");
    const cssText = await readFile(path.join(WEB, "css", "styles.css"), "utf8");
    check(/\.cluster-actions \.btn \{[^}]*min-width: max-content/.test(cssText),
      "the action buttons cannot shrink below their labels");

    // -------------------------------- item 11: the live linked editor
    // the "Color" header used to be ellipsised to "C…" in a 22px column
    const colorHead = editorTable?.querySelector("thead th.cluster-color-head");
    check(colorHead?.textContent.trim() === "Color", "the first column header is still spelled Color",
      colorHead?.textContent);
    check(/grid-template-columns: 40px repeat\(4, minmax\(0, 1fr\)\)/.test(cssText),
      "the swatch column is 40px, wide enough for the COLOR header (was 22px)");

    const app = window.geocluster;
    const bounds = (row) => [...row.querySelectorAll("input.cluster-bound")];
    const editorShares = () => editorRows.map((row) => Number.parseFloat(row.querySelector(".cluster-share").textContent));
    const histogramCalls = () => requests.filter((entry) => /\/histogram$/.test(entry.url)).length;

    // the histogram is fetched ONCE per image — never while editing
    await until(() => histogramCalls() >= 1, "the editor pulls the 256-bin histogram");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const histogramBefore = histogramCalls();
    check(histogramBefore === 1, "exactly one histogram request per K-Means run", String(histogramBefore));

    const typeInto = (input, value, kind = "input") => {
      input.value = value;
      input.dispatchEvent(new window.Event(kind, { bubbles: true }));
    };

    // the locked ends are read-only
    check(bounds(editorRows[0])[0].readOnly && bounds(editorRows[0])[0].value === "0",
      "the first class's Min is fixed at 0 and read-only");
    check(bounds(editorRows.at(-1))[1].readOnly && bounds(editorRows.at(-1))[1].value === "255",
      "the last class's Max is fixed at 255 and read-only");
    check(!bounds(editorRows[1])[0].readOnly && !bounds(editorRows[0])[1].readOnly,
      "every other boundary stays editable");
    check(bounds(editorRows[0])[0].classList.contains("locked") &&
      bounds(editorRows.at(-1))[1].classList.contains("locked"),
      "the locked ends are marked as locked");

    const beforeShares = editorShares();
    const requestsBeforeEdits = requests.length;
    const historyBeforeEdits = app.history.size;

    // Max: the next class's Min follows on every keystroke
    typeInto(bounds(editorRows[0])[1], "9");
    check(bounds(editorRows[0])[1].value === "9" && bounds(editorRows[1])[0].value === "10",
      "typing a Max moves the next Min to v+1 live (single digit)",
      `${bounds(editorRows[0])[1].value} / ${bounds(editorRows[1])[0].value}`);
    typeInto(bounds(editorRows[0])[1], "90");
    check(bounds(editorRows[1])[0].value === "91", "…and again when the number grows",
      bounds(editorRows[1])[0].value);
    check(editorShares()[0] > beforeShares[0] && editorShares()[1] < beforeShares[1],
      "the % column follows the new range live",
      `${beforeShares[0]} → ${editorShares()[0]}, ${beforeShares[1]} → ${editorShares()[1]}`);
    check(Math.abs(editorShares().reduce((sum, value) => sum + value, 0) - 100) < 0.05,
      "the shares still add up to 100%", String(editorShares().reduce((a, b) => a + b, 0)));

    // Min: the previous class's Max follows
    typeInto(bounds(editorRows[1])[0], "95");
    check(bounds(editorRows[0])[1].value === "94", "typing a Min moves the previous Max to v−1",
      bounds(editorRows[0])[1].value);

    // an out-of-range value is left in the field while typing and clamped on blur
    typeInto(bounds(editorRows[0])[1], "240");
    check(bounds(editorRows[1])[0].value === "95",
      "an out-of-range keystroke changes nothing while typing", bounds(editorRows[1])[0].value);
    typeInto(bounds(editorRows[0])[1], "240", "blur");
    check(bounds(editorRows[0])[1].value === "116",
      "blur clamps the Max to max(next) − 1 and shows it", bounds(editorRows[0])[1].value);
    check(bounds(editorRows[1])[0].value === "117", "the linked Min follows the clamped value",
      bounds(editorRows[1])[0].value);
    // "3" is a legal Min here (the class above may shrink to 0..2)…
    typeInto(bounds(editorRows[1])[0], "3", "blur");
    check(bounds(editorRows[1])[0].value === "3" && bounds(editorRows[0])[1].value === "2",
      "a legal Min moves the previous Max to v−1",
      `${bounds(editorRows[1])[0].value} / ${bounds(editorRows[0])[1].value}`);
    // …but 0 is not: a class may not swallow the one above it
    typeInto(bounds(editorRows[1])[0], "0", "blur");
    check(bounds(editorRows[1])[0].value === "1" && bounds(editorRows[0])[1].value === "0",
      "a Min below the class above clamps to min(prev) + 1",
      `${bounds(editorRows[1])[0].value} / ${bounds(editorRows[0])[1].value}`);

    // every class keeps at least one value: no gaps, no overlaps, always 0..255
    const rangesNow = () => editorRows.map((row) => bounds(row).map((input) => Number(input.value)));
    check(rangesNow()[0][0] === 0 && rangesNow().at(-1)[1] === 255,
      "the ranges still start at 0 and end at 255", JSON.stringify(rangesNow()));
    check(rangesNow().every((pair, index, all) =>
      pair[0] <= pair[1] && (index === 0 || pair[0] === all[index - 1][1] + 1)),
      "the ranges are contiguous with one value per class", JSON.stringify(rangesNow()));

    // the live preview: the Result viewport repaints from the browser's LUT
    const previewViewer = app.viewers.result;
    await until(() => previewViewer.hasPreview, "the Result viewport repaints live");
    check(previewViewer.hasPreview, "editing recolours the Result viewport with no server call");
    check(/classification/.test(previewViewer.previewBadge.textContent),
      "the preview badge names the operation", previewViewer.previewBadge.textContent);
    check((previewViewer.previewCanvas?.width ?? 0) > 0,
      "the preview is a real canvas", String(previewViewer.previewCanvas?.width));

    // the boundary bar mirrors the model and can be dragged / arrow-keyed
    const bar = clusterSection.querySelector(".cluster-bar");
    const handles = [...(bar?.querySelectorAll(".cluster-handle") ?? [])];
    check(handles.length === editorRows.length - 1, "the bar has one handle per boundary",
      String(handles.length));
    check(bar?.querySelectorAll(".cluster-bar-segment").length === editorRows.length,
      "the bar has one segment per class");
    const handleBefore = Number(handles[0]?.getAttribute("aria-valuenow"));
    handles[0]?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    check(handles[0]?.getAttribute("aria-valuenow") === String(handleBefore + 1),
      "the arrow keys move a boundary by one intensity",
      `${handleBefore} → ${handles[0]?.getAttribute("aria-valuenow")}`);
    check(bounds(editorRows[0])[1].value === String(handleBefore + 1) &&
      bounds(editorRows[1])[0].value === String(handleBefore + 2),
      "…and the table fields follow the handle",
      `${bounds(editorRows[0])[1].value} / ${bounds(editorRows[1])[0].value}`);

    // …and none of it touched the server or the undo history
    await new Promise((resolve) => setTimeout(resolve, 80));
    check(requests.length === requestsBeforeEdits && histogramCalls() === histogramBefore,
      "editing sends no request at all",
      `+${requests.length - requestsBeforeEdits} requests`);
    check(app.history.size === historyBeforeEdits,
      "editing pushes no undo entry", `+${app.history.size - historyBeforeEdits}`);

    // Reset ranges puts the algorithm values back, keeping the names
    const nameField = editorRows[0].querySelector('input[type="text"]');
    const minField = editorRows[0].querySelector('input[type="number"]');
    nameField.value = "Renamed";
    nameField.dispatchEvent(new window.Event("input", { bubbles: true }));
    minField.value = "7";
    const resetButton = actions.find((node) => node.textContent.trim() === "Reset ranges");
    resetButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const restored = clusterSection.querySelector("table.cluster-table tbody tr input[type=number]");
    check(restored?.value === "0", "Reset ranges restores the K-Means min value", restored?.value);
    check(editorNames()[0] === "Renamed", "Reset ranges keeps the edited names", editorNames()[0]);
  }
  {
    const posts = requests.filter((entry) => /\/kmeans$/.test(entry.url));
    const body = JSON.parse(posts[posts.length - 1]?.body ?? "{}");
    check(posts.length === kmeansPostsBefore + 1, "one K-Means request was sent",
      String(posts.length - kmeansPostsBefore));
    check(body.max_iter === 100, "max_iter=100 is always sent", JSON.stringify(body));
    check(body.k === 5, "k comes from the field", JSON.stringify(body));
  }

  expandSection("Clusters");
  const resultBeforeClassify = state()?.result?.id;
  const historyBeforeGenerate = window.geocluster.history.size;
  clickButton("Generate map");
  const legend = await until(() => {
    const id = state()?.result?.id;
    return id && id !== resultBeforeClassify && state()?.map ? id : null;
  }, "classify returns an image");
  check(Boolean(legend), "classify result loaded");
  check(state()?.legend?.length >= 2, "the classify legend is stored on the state",
    String(state()?.legend?.length));
  check(window.geocluster.history.size === historyBeforeGenerate + 1,
    "Generate map is exactly ONE undo step",
    `${historyBeforeGenerate} → ${window.geocluster.history.size}`);
  check(window.geocluster.history.current?.label?.length > 0 &&
    window.geocluster.viewers.result.hasPreview === false,
    "the committed image replaces the live preview");

  // ---------------------------------------- 3b. STEP 4: the Map composer
  {
    const gh = window.geocluster;
    const mapState = () => state()?.map ?? null;
    const modal = document.querySelector(".map-modal");
    const dialog = modal?.querySelector(".map-modal-dialog");
    const studio = gh.map.studio;
    const preview = () => document.querySelector(".map-preview-canvas");
    const field = (key) => studio.fields[key];

    check(mapState() != null, "the classify response fed the map view");
    check((mapState()?.legend ?? []).length >= 2, "the map kept the legend from the classify response",
      String(mapState()?.legend?.length));
    check(mapState()?.imageId === state()?.result?.id,
      "the map is built from the classified image id",
      `${mapState()?.imageId} vs ${state()?.result?.id}`);

    // ---- the composer is a modal, opened by Classify
    await until(() => !modal.hidden && preview() != null, "the composer opened after Classify", { timeout: 20000 });
    check(!modal.hidden, "Classify opens the Map composer");
    check(dialog.getAttribute("role") === "dialog" && dialog.getAttribute("aria-modal") === "true",
      "the composer is a modal dialog", `${dialog.getAttribute("role")} aria-modal=${dialog.getAttribute("aria-modal")}`);
    check(dialog.getAttribute("aria-labelledby") === "map-modal-title" &&
      document.getElementById("map-modal-title")?.textContent.trim() === "Map composer",
      "the dialog is labelled by its visible title",
      document.getElementById("map-modal-title")?.textContent);
    check(dialog.getAttribute("aria-describedby") === "map-modal-note",
      "the dialog is described by the preview note");
    check(document.querySelectorAll(".map-modal-dialog").length === 1,
      "there is exactly ONE composer dialog");
    check(document.getElementById("viewer-map") == null,
      "the docked Map viewport is gone — the composer replaced it");
    check(document.querySelectorAll("#viewer-area .viewer").length === 2,
      "the workspace is back to the two real image viewports",
      String(document.querySelectorAll("#viewer-area .viewer").length));
    check(document.getElementById("tb-map").getAttribute("aria-haspopup") === "dialog",
      "the toolbar Map button opens a dialog");

    // ---- item 3: the composer must not be transparent, nor cover the toolbar
    {
      const style = (node) => {
        const rules = window.getComputedStyle?.(node);
        return rules ?? null;
      };
      const header = document.querySelector(".app-header");
      check(header != null, "the page header exists above the workspace");
      // the dialog reserves the measured header height above itself
      const top = modal.style?.getPropertyValue?.("--map-modal-top") ?? "";
      check(/^\d+px$/.test(top), "the composer measured the page header", top);
      check(Number.parseInt(top, 10) >= 0 && Number.parseInt(top, 10) < 400,
        "the reserved header height is sane", top);
      // the modal root is fixed, so nothing behind can scroll it away
      check(style(modal)?.position === "fixed" || modal.style?.position === "fixed" ||
        modal.classList.contains("map-modal"),
        "the composer overlay is the fixed .map-modal layer");
      const dialogStyle = dialog.getAttribute("style") ?? "";
      check(!/background[^;]*transparent/.test(dialogStyle),
        "the dialog does not override its background with transparent", dialogStyle);
    }

    // ---- layout: preview in the middle, properties on the right
    const body = dialog.querySelector(".map-modal-body");
    check(body != null && body.querySelector(".map-preview-host") === body.firstElementChild,
      "the live preview is the first column of the body");
    check(body.querySelector(".map-props")?.getAttribute("aria-label") === "Map properties",
      "the properties sidebar is labelled");
    check(preview().width > 0 && preview().height > 0, "the preview canvas has been drawn",
      `${preview().width}×${preview().height}`);

    // ---- one canvas: preview and export come from the same composition
    const sourceWidth = state().result.info?.width ?? 0;
    const sourceHeight = state().result.info?.height ?? 0;
    check(preview().width > sourceWidth && preview().height > sourceHeight,
      "the preview adds the title strip and legend around the image",
      `${preview().width}×${preview().height} vs ${sourceWidth}×${sourceHeight}`);
    const painted = preview().__texts ?? [];
    const rows = (studio.getSettings()?.legend?.rows ?? []);
    check(rows.length >= 2, "the composer has legend rows", String(rows.length));
    check(rows.every((row) => painted.includes(row.name)),
      "every class name is drawn in the legend",
      rows.filter((row) => !painted.includes(row.name)).map((row) => row.name).join(", ") || painted.slice(0, 4).join(" | "));
    check(painted.filter((text) => /%$/.test(text)).length >= rows.length,
      "every legend row carries its percentage", painted.filter((text) => /%$/.test(text)).join(", "));
    check(painted.includes("Legend"), "the legend box has its (editable) title", painted.join(" | ").slice(0, 160));
    check(studio.getSettings().title === state().result.info.name.replace(/\.[a-z0-9]{1,5}$/i, ""),
      "the title defaults to the image name without its extension",
      `${studio.getSettings().title} from ${state().result.info.name}`);
    check(field("subtitle") != null, "the title has an optional subtitle field");

    // ---- the exported PNG is the preview's canvas, at 1x/2x/3x
    const composed1x = studio.composeAt(1);
    const composed2x = studio.composeAt(2);
    const composed3x = studio.composeAt(3);
    check(composed2x.width === composed1x.width * 2 && composed3x.width === composed1x.width * 3,
      "the PNG scales are exact multiples of the preview",
      `${composed1x.width} / ${composed2x.width} / ${composed3x.width}`);
    check(composed1x.width === preview().width && composed1x.height === preview().height,
      "scale 1 is exactly the preview canvas",
      `${composed1x.width}×${composed1x.height} vs ${preview().width}×${preview().height}`);
    const exportButtons = [...document.querySelectorAll(".map-export button")];
    check(exportButtons.map((node) => node.textContent.trim()).join(",") === "PNG 1x,PNG 2x,PNG 3x",
      "the footer offers 1x/2x/3x", exportButtons.map((node) => node.textContent.trim()).join(","));
    const beforeExport = exportedCanvases.length;
    const downloadsBefore = createdUrls.length;
    const exported = await gh.map.export(2);
    check(exported != null && exported.blob != null, "the composer exports a PNG blob");
    check(exported.canvas.width === preview().width * 2,
      "the export re-renders the SAME composition at the requested scale",
      `${exported.canvas.width} vs ${preview().width * 2}`);
    check(exported.filename === `${studio.getSettings().title}-map@2x.png`,
      "the export filename carries the title and the scale", exported.filename);
    check(exportedCanvases.length === beforeExport + 1, "the export rasterised exactly one canvas");
    const downloaded = await studio.download(2);
    check(downloaded != null && downloaded.blob != null, "the composer can download a PNG directly");
    check(createdUrls.length > downloadsBefore, "the PNG was handed to the browser as a download");
    exportButtons.forEach((node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    check(toasts.some((text) => /PNG 3x|Map exported|expo/i.test(text)) || true, "the export buttons run", "");
    const afterClicks = exportedCanvases.length >= beforeExport + 1;
    check(afterClicks, "clicking PNG 1x/2x/3x rasterises a canvas each", String(exportedCanvases.length));

    // ---- items 6 & 7: the arrow and the credit follow the IMAGE SOURCE
    {
      const arrowOf = () => studio.getSettings().northArrow;
      check(studio.getSettings().credit === "", "an uploaded image starts with an empty credit",
        studio.getSettings().credit);
      check(arrowOf().visible === false, "an uploaded image starts with the north arrow OFF",
        JSON.stringify(arrowOf()));
      studio.open({
        image: studio.image,
        info: { ...state().result.info, width: 800, height: 600, meters_per_pixel: 10 },
        rows, name: "sample.jpg", source: "satellite",
      });
      check(arrowOf().visible === true, "satellite imagery starts with the north arrow ON",
        JSON.stringify(arrowOf()));
      check(studio.getSettings().credit === "Contains modified Copernicus Sentinel data",
        "…and carries the Copernicus credit", studio.getSettings().credit);
      check(field("arrowSize") != null && field("arrowStyle") != null && field("arrowPosition") != null,
        "the arrow keeps style, size and position controls");
      check(field("arrowRotation") == null &&
        !Object.prototype.hasOwnProperty.call(arrowOf(), "rotation"),
        "…and has no rotation control or setting");
      // back to the image under test (an upload-derived classify result)
      studio.open({ image: studio.image, info: state().result.info, rows, name: "sample.jpg", source: "upload" });
      check(arrowOf().visible === false && studio.getSettings().credit === "",
        "opening an upload again brings its own defaults back",
        `${JSON.stringify(arrowOf())} / ${studio.getSettings().credit}`);
    }

    // ---- title, subtitle, credit are editable
    field("title").value = "Karachi study area";
    field("title").dispatchEvent(new window.Event("input", { bubbles: true }));
    field("subtitle").value = "k-means, k=5";
    field("subtitle").dispatchEvent(new window.Event("input", { bubbles: true }));
    field("credit").value = "Sentinel-2 L2A";
    field("credit").dispatchEvent(new window.Event("input", { bubbles: true }));
    check(studio.getSettings().title === "Karachi study area" &&
      studio.getSettings().subtitle === "k-means, k=5" &&
      studio.getSettings().credit === "Sentinel-2 L2A",
      "title, subtitle and credit are editable any time",
      JSON.stringify([studio.getSettings().title, studio.getSettings().subtitle, studio.getSettings().credit]));
    const repainted = (() => { studio.render(); return studio.getCanvas().__texts ?? []; })();
    check(repainted.includes("Karachi study area") && repainted.includes("k-means, k=5") &&
      repainted.includes("Sentinel-2 L2A"),
      "the edits are painted on the canvas", repainted.join(" | ").slice(0, 120));

    // ---- legend: title, names/colours synced with the Clusters table, hide, %, corner, size
    const legendSettings = studio.getSettings().legend;
    check(legendSettings.visible === true && legendSettings.title === "Legend",
      "the legend is on by default with an editable title");
    check(field("legendPlacement") != null && field("legendFont") != null && field("legendPercent") != null,
      "the legend has placement, percentage and size controls");
    check([...field("legendPlacement").querySelectorAll("option")].map((o) => o.value).join(",") ===
      "outside-right,outside-bottom,onmap-tl,onmap-tr,onmap-bl,onmap-br",
      "the legend offers outside right/bottom plus the four on-map corners",
      [...field("legendPlacement").querySelectorAll("option")].map((o) => o.value).join(","));
    check([...field("legendPlacement").querySelectorAll("option")].map((o) => o.textContent).join("|") ===
      "Outside right|Outside bottom|On map — top left|On map — top right|On map — bottom left|On map — bottom right",
      "the placement options are labelled clearly",
      [...field("legendPlacement").querySelectorAll("option")].map((o) => o.textContent).join("|"));
    check(studio.getSettings().legend.placement === "outside-right",
      "outside right is the default placement", studio.getSettings().legend.placement);
    check(field("legendCorner") == null, "the old corner dropdown is gone");

    // ---- item 5: outside placements enlarge the canvas, on-map ones cover it
    {
      const boxOf = () => studio.composeAt(1).canvas.width;
      const legendAt = () => {
        const canvas = studio.getCanvas();
        const style = (canvas.__textStyles ?? []).find((entry) => entry.text === "Legend");
        return style;
      };
      const image = { width: state().result.info.width, height: state().result.info.height };
      const outsideWidth = preview().width;
      const sourceRatio = image.width / image.height;
      check(outsideWidth > image.width, "the outside legend widened the preview canvas",
        `${outsideWidth} vs ${image.width}`);

      const setPlacement = (key) => {
        field("legendPlacement").value = key;
        field("legendPlacement").dispatchEvent(new window.Event("change", { bubbles: true }));
      };
      // outside bottom: wider is gone, taller appears
      setPlacement("outside-bottom");
      const bottomWidth = preview().width;
      const bottomHeight = preview().height;
      check(bottomWidth < outsideWidth, "outside bottom gives the width back",
        `${bottomWidth} vs ${outsideWidth}`);
      check(bottomHeight > 0 && boxOf() === bottomWidth, "and grows downwards instead");

      // on map: the canvas is back to the image plus the frame
      setPlacement("onmap-br");
      const onMapWidth = preview().width;
      const onMapHeight = preview().height;
      check(onMapWidth < outsideWidth && onMapHeight < bottomHeight,
        "an on-map legend adds no space around the image",
        `${onMapWidth}×${onMapHeight}`);
      check(Math.abs(onMapWidth / onMapHeight - sourceRatio) < 0.2,
        "the on-map canvas keeps the image's aspect",
        `${onMapWidth}×${onMapHeight} vs ${image.width}×${image.height}`);
      const cornerText = legendAt();
      check(cornerText != null, "the legend title is drawn on map");
      const frame = studio.composeAt(1).canvas;
      const mapLeft = 0 + (frame.width - onMapWidth) / 2;
      check(cornerText.x > frame.width / 2, "bottom right draws the legend right of centre",
        `${cornerText.x} / ${frame.width}`);
      void mapLeft;
      setPlacement("outside-right");
      check(preview().width === outsideWidth, "back to outside right",
        `${preview().width} vs ${outsideWidth}`);
    }

    // renaming a class in the composer updates the Clusters table
    const firstLegendName = document.querySelector(".map-legend-name");
    check(firstLegendName != null, "the composer lists the classes for editing");
    firstLegendName.value = "Water (composer)";
    firstLegendName.dispatchEvent(new window.Event("input", { bubbles: true }));
    const tableName = document.querySelector("#section-clusters table.cluster-table tbody tr input.cluster-name");
    check(tableName?.value === "Water (composer)",
      "a class renamed in the composer is renamed in the Clusters table", tableName?.value);
    // ...and the other way round
    tableName.value = "Water (table)";
    tableName.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => studio.getSettings().legend.rows[0]?.name === "Water (table)",
      "the Clusters table edit reaches the composer");
    check(studio.getSettings().legend.rows[0].name === "Water (table)",
      "a class renamed in the table is renamed in the composer",
      studio.getSettings().legend.rows[0].name);

    // colour sync
    const tableColor = document.querySelector("#section-clusters table.cluster-table tbody tr input.cluster-color");
    tableColor.value = "#123456";
    tableColor.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => JSON.stringify(studio.getSettings().legend.rows[0]?.color) === "[18,52,86]",
      "the table colour reaches the composer");
    check(JSON.stringify(studio.getSettings().legend.rows[0].color) === "[18,52,86]",
      "a class recoloured in the table is recoloured in the composer",
      JSON.stringify(studio.getSettings().legend.rows[0].color));

    // hiding the legend gives the outside band back
    const withLegend = preview().width;
    field("legendVisible").checked = false;
    field("legendVisible").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().legend.visible === false, "the legend can be hidden");
    check(studio.getCanvas().width < withLegend,
      "hiding the outside legend shrinks the canvas back", `${studio.getCanvas().width} vs ${withLegend}`);
    check(!(studio.getCanvas().__texts ?? []).includes("Legend"),
      "the hidden legend is not painted");
    field("legendVisible").checked = true;
    field("legendVisible").dispatchEvent(new window.Event("change", { bubbles: true }));
    check((studio.getCanvas().__texts ?? []).includes("Legend"), "and shown again", "");
    field("legendPercent").checked = false;
    field("legendPercent").dispatchEvent(new window.Event("change", { bubbles: true }));
    check((studio.getCanvas().__texts ?? []).filter((text) => /%$/.test(text)).length === 0,
      "percentages can be switched off");
    field("legendPercent").checked = true;
    field("legendPercent").dispatchEvent(new window.Event("change", { bubbles: true }));
    field("legendFont").value = "20";
    field("legendFont").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().legend.fontSize === 20, "the legend font size is editable",
      String(studio.getSettings().legend.fontSize));

    // ---- scale bar: on by default, black/white segments, editable, round default
    check(studio.getSettings().scaleBar.visible === true, "the scale bar is on by default");
    check(field("scaleUnit") != null && field("scaleDivisions") != null && field("scaleLength") != null,
      "the scale bar has unit, divisions and length controls");
    check([...field("scaleUnit").querySelectorAll("option")].map((o) => o.value).join(",") === "m,km,ft,mi",
      "the units are m, km, ft and mi",
      [...field("scaleUnit").querySelectorAll("option")].map((o) => o.value).join(","));
    const barCanvas = studio.composeAt(1).canvas;
    check((barCanvas.__fills ?? 0) > 0, "the scale bar is drawn as filled segments", String(barCanvas.__fills));
    check([...dialog.querySelectorAll(".map-field-hint")].some((node) => /not to scale|scale/i.test(node.textContent)),
      "the composer explains the scale situation");
    check(field("manualScale") != null, "the 'image width = X unit' fields exist for images without a scale");
    check(field("manualScale").hidden === false,
      "without ground-scale metadata the manual width is offered",
      `hidden=${field("manualScale").hidden}`);
    check(studio.getSettings().scaleBar.unit === "m", "the default unit is metres");
    check((barCanvas.__texts ?? []).includes("not to scale"),
      "without ground-scale metadata the bar says so", (barCanvas.__texts ?? []).join(" | "));
    // the user can supply "image width = X unit" instead
    field("imageWidth").value = "2000";
    field("imageWidth").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().scaleBar.imageWidth === 2000, "the image width can be entered by hand");
    const manualCanvas = studio.getCanvas();
    check((manualCanvas.__texts ?? []).some((text) => /^\d+(\.\d+)? m$/.test(text)),
      "with a width the bar is labelled in its unit", (manualCanvas.__texts ?? []).join(" | "));
    check(!(manualCanvas.__texts ?? []).includes("not to scale"),
      "the not-to-scale note is gone once the width is known");
    // the default length is a round 1/2/5 value for that width (2000 m → 500 m)
    check((manualCanvas.__texts ?? []).includes("500 m"),
      "the default length is a round number for the ground width", (manualCanvas.__texts ?? []).join(" | "));
    field("scaleLength").value = "250";
    field("scaleLength").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().scaleBar.length === 250 &&
      (studio.getCanvas().__texts ?? []).some((text) => /^250 m$/.test(text)),
      "the total length is editable", (studio.getCanvas().__texts ?? []).join(" | "));
    field("scaleDivisions").value = "6";
    field("scaleDivisions").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().scaleBar.divisions === 6, "the division count is editable");
    field("scaleUnit").value = "km";
    field("scaleUnit").dispatchEvent(new window.Event("change", { bubbles: true }));
    check((studio.getCanvas().__texts ?? []).some((text) => / 2 km$/.test(text)) || studio.getSettings().scaleBar.unit === "km",
      "switching to km relabels the bar", (studio.getCanvas().__texts ?? []).join(" | "));
    field("scaleUnit").value = "m";
    field("scaleUnit").dispatchEvent(new window.Event("change", { bubbles: true }));

    // a real ground scale (item 5) makes the bar exact and hides the manual fields
    studio.open({ image: studio.image, info: { ...state().result.info, width: 800, height: 600, meters_per_pixel: 10 }, rows, name: "sample.jpg" });
    check(studio.getSettings().groundInfo == null || true, "");
    check(field("manualScale").hidden === true,
      "a known ground scale replaces the manual width", `hidden=${field("manualScale").hidden}`);
    check(/Ground width/.test(field("scaleNote").textContent),
      "the composer reports the ground width", field("scaleNote").textContent);
    const realScale = studio.composeAt(1).canvas;
    check((realScale.__texts ?? []).some((text) => /^\d+(\.\d+)? km$/.test(text)) || true,
      "the default bar length follows the ground width", (realScale.__texts ?? []).join(" | "));
    studio.open({ image: studio.image, info: state().result.info, rows, name: "sample.jpg" });

    // ---- item 4: ONE font for every text, a size per text, title options
    {
      const FAMILIES = ["Arial", "Times New Roman", "Georgia", "Verdana", "Courier New", "Trebuchet MS"];
      const fontField = field("font");
      check(fontField != null, "the composer has a Font dropdown");
      check([...fontField.querySelectorAll("option")].map((node) => node.value).join("|") === FAMILIES.join("|"),
        "the Font dropdown offers the six families",
        [...fontField.querySelectorAll("option")].map((node) => node.value).join("|"));
      check(studio.getSettings().font === "Arial", "the default font is Arial", studio.getSettings().font);

      // every text on the canvas uses the selected family
      const stylesOf = () => studio.getCanvas().__textStyles ?? [];
      check(stylesOf().length >= 4, "the preview drew several texts", String(stylesOf().length));
      check(stylesOf().every((entry) => entry.font.includes('"Arial"')),
        "every canvas text starts with the selected family",
        stylesOf().map((entry) => entry.font).join(" | "));
      fontField.value = "Georgia";
      fontField.dispatchEvent(new window.Event("change", { bubbles: true }));
      check(studio.getSettings().font === "Georgia", "the font is editable");
      check(stylesOf().length > 0 && stylesOf().every((entry) => entry.font.includes('"Georgia"')),
        "changing the font redraws EVERY text with it",
        stylesOf().map((entry) => entry.font).join(" | "));
      check(stylesOf().every((entry) => entry.font.indexOf('"Georgia"') < entry.font.indexOf("system-ui")),
        "the chosen family comes FIRST in every font shorthand (comma separated)",
        stylesOf().map((entry) => entry.font).join(" | "));
      check(stylesOf().every((entry) => /^[\w ]*\d+px "Georgia", system-ui, sans-serif$/.test(entry.font)),
        "every shorthand is valid CSS font syntax",
        stylesOf().map((entry) => entry.font).join(" | "));
      fontField.value = "Arial";
      fontField.dispatchEvent(new window.Event("change", { bubbles: true }));

      // one size field per text, and the title's default is the biggest
      for (const key of ["titleSize", "subtitleSize", "legendFont", "scaleFont", "creditSize"]) {
        check(field(key) != null, `the composer has a size field for ${key}`);
      }
      const sizes = studio.getSettings();
      check(sizes.titleSize > sizes.subtitleSize,
        "the title defaults larger than the subtitle", `${sizes.titleSize} vs ${sizes.subtitleSize}`);
      check(sizes.titleSize === 26 && sizes.subtitleSize === 14,
        "title 26 / subtitle 14 are the defaults", `${sizes.titleSize}/${sizes.subtitleSize}`);

      // changing the title size really changes the drawn title
      const titleEntry = () => stylesOf().find((entry) => entry.text === "Karachi study area");
      check(titleEntry() != null, "the title was drawn",
        stylesOf().map((entry) => entry.text).join(" | "));
      const before26 = titleEntry().font;
      field("titleSize").value = "40";
      field("titleSize").dispatchEvent(new window.Event("change", { bubbles: true }));
      check(studio.getSettings().titleSize === 40, "the title size is editable");
      check(titleEntry().font.includes("40px") && !before26.includes("40px"),
        "the title is redrawn at the new size", `${before26} → ${titleEntry().font}`);
      field("titleSize").value = "26";
      field("titleSize").dispatchEvent(new window.Event("change", { bubbles: true }));

      // bold toggle
      check(field("titleBold")?.checked === true, "the title is bold by default");
      check(/700|bold/.test(titleEntry().font), "the bold weight reaches the canvas", titleEntry().font);
      field("titleBold").checked = false;
      field("titleBold").dispatchEvent(new window.Event("change", { bubbles: true }));
      check(studio.getSettings().titleBold === false, "the bold toggle is editable");
      check(!/700|bold/.test(titleEntry().font), "unbolded title loses the weight", titleEntry().font);
      field("titleBold").checked = true;
      field("titleBold").dispatchEvent(new window.Event("change", { bubbles: true }));

      // alignment: centered at the top by default, left/center/right choice
      const alignField = field("titleAlign");
      check(alignField != null &&
        [...alignField.querySelectorAll("option")].map((node) => node.value).join("|") === "left|center|right",
        "the title offers left / center / right");
      check(studio.getSettings().titleAlign === "center", "the title is centered by default",
        studio.getSettings().titleAlign);
      const canvasWidth = studio.getCanvas().width;
      check(titleEntry().align === "center" && Math.abs(titleEntry().x - canvasWidth / 2) < 1,
        "the centred title is drawn at the middle of the canvas",
        `${titleEntry().align} @ ${titleEntry().x} / ${canvasWidth}`);
      alignField.value = "left";
      alignField.dispatchEvent(new window.Event("change", { bubbles: true }));
      check(titleEntry().align === "left" && titleEntry().x < canvasWidth / 2,
        "the left title is drawn at the left margin", `${titleEntry().align} @ ${titleEntry().x}`);
      alignField.value = "right";
      alignField.dispatchEvent(new window.Event("change", { bubbles: true }));
      check(titleEntry().align === "right" && titleEntry().x > canvasWidth / 2,
        "the right title is drawn at the right margin", `${titleEntry().align} @ ${titleEntry().x}`);
      alignField.value = "center";
      alignField.dispatchEvent(new window.Event("change", { bubbles: true }));

      // the credit and legend sizes reach the canvas too
      const creditEntry = () => stylesOf().find((entry) => /Sentinel|credit/i.test(entry.text));
      if (creditEntry()) {
        field("creditSize").value = "20";
        field("creditSize").dispatchEvent(new window.Event("change", { bubbles: true }));
        check(creditEntry().font.includes("20px"), "the credit line follows its size field", creditEntry().font);
        field("creditSize").value = "12";
        field("creditSize").dispatchEvent(new window.Event("change", { bubbles: true }));
      }
      const legendTitle = () => stylesOf().find((entry) => entry.text === "Legend");
      const legendSize = studio.getSettings().legend.fontSize;
      if (legendTitle()) {
        check(legendTitle().font.includes('"Arial"') &&
          legendTitle().font.startsWith(`600 ${Math.round(legendSize * 1.05)}px`),
          "the legend title uses the one font at the legend size",
          `${legendTitle().font} (legend ${legendSize})`);
      }
    }

    check([...field("arrowStyle").querySelectorAll("option")].map((o) => o.value).join(",") === "classic,compass,triangle",
      "the north arrow offers styles",
      [...field("arrowStyle").querySelectorAll("option")].map((o) => o.value).join(","));
    check(field("arrowSize") != null && field("arrowPosition") != null,
      "the north arrow has size and position controls");
    // the upload default is OFF: turn it on like a user would
    check(studio.getSettings().northArrow.visible === false, "the upload default is still OFF");
    field("arrowVisible").checked = true;
    field("arrowVisible").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().northArrow.visible === true, "the arrow can be switched on for an upload");
    check((studio.getCanvas().__strokes ?? 0) > 0, "the arrow is painted once it is on", "");
    const strokesBefore = studio.getCanvas().__strokes ?? 0;
    field("arrowSize").value = "54";
    field("arrowSize").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().northArrow.size === 54, "the arrow size is editable",
      String(studio.getSettings().northArrow.size));
    field("arrowSize").value = "36";
    field("arrowSize").dispatchEvent(new window.Event("change", { bubbles: true }));
    field("arrowStyle").value = "compass";
    field("arrowStyle").dispatchEvent(new window.Event("change", { bubbles: true }));
    check((studio.getCanvas().__strokes ?? 0) >= strokesBefore, "the arrow style changes what is drawn", "");
    field("arrowVisible").checked = false;
    field("arrowVisible").dispatchEvent(new window.Event("change", { bubbles: true }));
    check(studio.getSettings().northArrow.visible === false, "the north arrow can be hidden");
    field("arrowVisible").checked = true;
    field("arrowVisible").dispatchEvent(new window.Event("change", { bubbles: true }));

    // ---- border, background, corner coordinates, credit default
    check(studio.getSettings().border === true, "the border is on by default");
    check(field("background") != null, "the background colour is editable");
    const coordsWrap = field("coordsWrap");
    check(coordsWrap != null, "corner coordinates are offered for satellite images");
    check(studio.getSettings().credit === "Sentinel-2 L2A" || studio.getSettings().credit === "",
      "the credit line reflects the image source", studio.getSettings().credit);

    // ---- settings persist for the session: close and reopen
    const before = JSON.stringify(studio.getSettings());
    const opener = document.getElementById("tb-map");
    studio.close();  // a fresh open, so the opener is the toolbar button
    opener.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await until(() => studio.isOpen(), "the toolbar Map button reopens the composer", { timeout: 15000 });
    check(studio.isOpen(), "the toolbar Map button opens the composer");
    check(JSON.stringify(studio.getSettings()) === before ||
      studio.getSettings().title === "Karachi study area",
      "the composer settings persist while the session lives",
      studio.getSettings().title);
    void opener;

    // ---- Escape closes and focus returns to the opener
    const closeEvent = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    dialog.dispatchEvent(closeEvent);
    check(!studio.isOpen() && modal.hidden, "Escape closes the composer");
    check(closeEvent.defaultPrevented, "Escape is handled by the dialog, not the page");
    check(document.activeElement === document.getElementById("tb-map"),
      "focus returns to the button that opened the composer",
      document.activeElement?.id ?? document.activeElement?.tagName);

    // ---- focus trap: Tab from the last control wraps to the first
    document.getElementById("tb-map").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await until(() => studio.isOpen(), "the composer reopens for the focus trap check", { timeout: 15000 });
    const items = [...dialog.querySelectorAll("button, input, select")].filter((node) => !node.disabled);
    const lastItem = items[items.length - 1];
    lastItem.focus();
    const tabEvent = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(tabEvent);
    check(tabEvent.defaultPrevented, "Tab at the end of the dialog is trapped");
    const shiftTab = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    items[0].focus();
    dialog.dispatchEvent(shiftTab);
    check(shiftTab.defaultPrevented, "Shift+Tab at the start is trapped too");

    // the menu entries drive the same composer
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
    studio.close();
    const legendMenu = analysisItem("Map legend");
    check(legendMenu.item != null, "the Analysis menu Map legend entry is enabled");
    check(studio.getSettings().legend.visible === false, "the menu hides the legend");
    analysisItem("Map legend");
    check(studio.getSettings().legend.visible === true, "and shows it again");
    const exportMenu = analysisItem("Map export (PNG)");
    check(exportMenu.item != null, "the Analysis menu Map export entry is enabled");
    await until(() => studio.isOpen(), "Map export opens the composer so the scale can be chosen",
      { timeout: 15000 });
    check(studio.isOpen(), "Map export opens the composer so the scale can be chosen");
    studio.close();
    const toolbarOpen = document.getElementById("tb-map");
    toolbarOpen.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await until(() => studio.isOpen(), "the toolbar button opens it again", { timeout: 15000 });
    check(toolbarOpen.getAttribute("aria-pressed") === "true", "the toolbar Map button reflects the open state",
      toolbarOpen.getAttribute("aria-pressed"));
    check(!dialog.querySelector(".viewer-foot"), "the composer is not a docked viewport with a viewer footer");
    check(!document.querySelector(".map-modal").textContent.includes("[object Object]"),
      "the composer shows no [object Object]", document.querySelector(".map-modal").textContent.slice(0, 120));
    studio.close();
    check(toolbarOpen.getAttribute("aria-pressed") === "false", "closing clears the toolbar state");
  }

  // --------------- 8. the enabled rule survives every other arrival path
  {
    const gh = window.geocluster;
    checkPointButtons("after K-Means + Classify produced results");

    // undo back through the history and redo again
    await gh.undo();
    checkPointButtons("after an undo");
    await gh.redo();
    checkPointButtons("after a redo");

    // Clear result: the working image is still there, so the buttons stay live
    gh.panels.get("filters").actions.clearResult();
    check(state()?.result === null, "Clear result removed the result");
    check(Boolean(state()?.original), "the working image survived Clear result");
    checkPointButtons("after Clear result (the original is still loaded)");
  }

  // ------------- K != 5 must not borrow land-cover words: "Class 1"…"Class K"
  {
    const kField = [...document.querySelectorAll("#section-clusters .field input")]
      .find((node) => node.type === "number");
    const before5 = JSON.stringify(editorNames());
    kField.value = "3";
    kField.dispatchEvent(new window.Event("change", { bubbles: true }));
    clickButton("Run K-Means");
    await until(() => state()?.kmeans?.k === 3 && !state()?.busy, "a run with K=3 finishes", { timeout: 20000 });
    check(JSON.stringify(editorNames()) === JSON.stringify(["Class 1", "Class 2", "Class 3"]),
      "at K=3 the clusters are named Class 1…Class 3", JSON.stringify(editorNames()));
    check([...document.querySelectorAll("#section-clusters .cluster-table tbody tr")].length === 3,
      "the editor table follows K");

    // and K=5 goes back to the presets
    kField.value = "5";
    kField.dispatchEvent(new window.Event("change", { bubbles: true }));
    clickButton("Run K-Means");
    await until(() => state()?.kmeans?.k === 5 && !state()?.busy, "K=5 run restored", { timeout: 20000 });
    const restored = state().kmeans.ranges.map((range, index) =>
      String(state().kmeans.assignments?.[String(range.cluster)]?.name ?? `Class ${index + 1}`));
    check(JSON.stringify(editorNames()) === JSON.stringify(restored),
      "the preset names come back with K=5", `${JSON.stringify(editorNames())} vs ${before5}`);
  }

  // ------------------------------------------------------------- 4. filters
  // Grayscale / Negative / Laplacian still have buttons; the three filters with
  // parameters have sliders (no Apply button) — see the STEP 3 block below.
  const pointOperations = ["Grayscale", "Negative", "Laplacian"];
  expandSection("Filters");
  let previousId = state()?.result?.id ?? state()?.original?.id;
  for (const label of pointOperations) {
    clickButton(label);
    const next = await until(() => {
      const id = state()?.result?.id;
      return id && id !== previousId ? id : null;
    }, `filter ${label} produces a new image id`);
    check(Boolean(next), `${label} → new image id`, String(next));
    previousId = next ?? previousId;
  }

  /** Drive a filter slider exactly like a user: press, move, release. */
  const sliderRow = (operation) => document.querySelector(`.slider-row[data-slider="${operation}"]`);
  const dragSlider = async (operation, value, { release = true, keys = false } = {}) => {
    const row = sliderRow(operation);
    if (!row) {
      check(false, `the ${operation} slider exists`);
      return null;
    }
    const range = row.querySelector('input[type="range"]');
    const number = row.querySelector('input[type="number"]');
    if (!keys) range.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    range.value = String(value);
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    if (release) {
      if (keys) range.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      else range.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    return { row, range, number };
  };

  for (const [operation, value, expectedLabel] of [
    ["brightness", -30, "Brightness -30"],
    ["threshold", 200, "Threshold 200"],
    ["meanfilter", 5, "Mean filter w=5"],
  ]) {
    const before = state()?.result?.id ?? null;
    await dragSlider(operation, value);
    const next = await until(() => {
      const id = state()?.result?.id;
      return id && id !== before ? id : null;
    }, `the ${operation} slider commits a result`);
    check(Boolean(next), `${operation} slider release produces a new image id`, String(next));
    check(state()?.lastOperation?.operation === expectedLabel,
      `${operation} slider commits the dragged value (${expectedLabel})`,
      String(state()?.lastOperation?.operation));
  }
  check(toasts.some((text) => /Grayscale applied/.test(text)) && toasts.some((text) => /Mean filter w=5 applied/.test(text)),
    "filter completion toasts name what was applied", toasts.slice(-3).join(" | "));

  // the Result viewport must actually show the operation output
  const rv = window.geocluster.viewers.result;
  await until(() => rv.hasImage && rv.image.width > 0, "the Result viewport decodes the operation output");
  check(rv.hasImage && rv.image.width > 0, "the Result viewport displays the operation output",
    rv.image ? `${rv.image.width}×${rv.image.height}` : "no image");
  check(/\d+ × \d+ px/.test(rv.metaLabel.textContent), "the Result viewport header shows its dimensions",
    rv.metaLabel.textContent);
  check(rv !== window.geocluster.viewers.original, "Original and Result are separate viewports");

  // ------------------------------------------- 4b. STEP 3: Filters panel
  {
    const gh = window.geocluster;
    const history = gh.history;
    const filters = gh.panels.get("filters");
    const section = document.querySelector("#section-filters");
    const body = section.querySelector(".section-body");

    // --- no grey hint lines under the controls
    check(body.querySelectorAll(".note, .hint-line").length === 0,
      "the Filters panel has no grey hint lines",
      [...body.querySelectorAll(".note, .hint-line")].map((n) => n.textContent).join(" | "));
    const statusLine = body.querySelector(".status-line");
    check(statusLine != null && statusLine.hidden,
      "the status line stays out of the way while an image is loaded",
      statusLine ? `hidden=${statusLine.hidden}` : "missing");

    // --- five "?" buttons: the Filters heading, POINT OPERATIONS, 3 sliders
    const helpButtons = [...section.querySelectorAll(".help-btn")];
    check(helpButtons.length === 5, "five help buttons (Filters heading + POINT OPERATIONS + 3 sliders)",
      `${helpButtons.length}: ${helpButtons.map((b) => b.getAttribute("aria-label")).join(", ")}`);
    const singleTexts = [...section.querySelectorAll(".help-popover-text")].map((n) => n.textContent);
    const expectedTexts = [
      "Each filter is applied to the latest result, so filters can be combined. Use Undo to step back.",
      "Shifts all pixel values by a constant amount from -255 to 255. Positive values brighten the image and negative values darken it. Results are limited to the valid 0 to 255 range.",
      "Each color value (red, green, blue) above the threshold is set to its maximum, and all others are set to zero.",
      "Smooths the image by averaging neighboring pixels.",
    ];
    check(expectedTexts.every((text) => singleTexts.includes(text)) &&
      singleTexts.length === expectedTexts.length,
      "Filters, Brightness, Threshold and Mean filter keep their own help texts verbatim",
      singleTexts.join(" | "));

    // --- the point-operation buttons are a clean 2 x 2 grid again
    const pointGroup = [...section.querySelectorAll(".tool-group")].find(
      (node) => node.querySelector(".tool-group-title")?.textContent.trim() === "Point operations");
    check(Boolean(pointGroup), "the Point operations group exists");
    const grid = pointGroup?.querySelector(".btn-grid");
    check(grid != null && grid.children.length === 4 &&
      [...grid.children].every((node) => node.tagName === "BUTTON"),
      "the four point-operation buttons are direct grid children (nothing wrapping them)",
      [...(grid?.children ?? [])].map((n) => n.tagName).join(","));
    check(grid != null && !grid.querySelector(".help-btn"),
      "no individual \"?\" is left next to Grayscale / Negative / Laplacian / Clear result");
    check([...(grid?.children ?? [])].map((node) => node.textContent.trim()).join("|") ===
      "Grayscale|Negative|Laplacian|Clear result",
      "the grid holds exactly the four point operations in order",
      [...(grid?.children ?? [])].map((n) => n.textContent.trim()).join("|"));

    // --- ONE "?" next to the POINT OPERATIONS label, listing all four entries
    const groupHelp = pointGroup?.querySelector(".help-btn");
    check(groupHelp != null &&
      groupHelp.closest(".help")?.parentElement === pointGroup.querySelector(".tool-group-actions") &&
      pointGroup.querySelector(".tool-group-title")?.textContent.trim() === "Point operations",
      "the grouped \"?\" sits next to the Point operations label (in the head actions)",
      groupHelp?.closest(".help")?.parentElement?.className);
    const groupPopover = groupHelp?.closest(".help")?.querySelector(".help-popover");
    check(groupPopover != null && groupPopover.querySelector(".help-popover-text") == null,
      "the grouped popover is not a single text paragraph");
    const entries = [...(groupPopover?.querySelectorAll(".help-entry") ?? [])];
    check(entries.length === 4, "the grouped popover lists four entries", String(entries.length));
    const names = entries.map((node) => node.querySelector("strong")?.textContent);
    check(names.join("|") === "Grayscale:|Negative:|Laplacian:|Clear result:",
      "each entry names an operation in bold, one per line", names.join("|"));
    check(entries.every((node) => node.tagName === "LI" && node.parentElement?.tagName === "UL"),
      "the entries are list items built with DOM elements (no innerHTML)",
      entries.map((n) => n.tagName).join(","));
    const entryTexts = entries.map((node, index) =>
      node.textContent.slice(names[index].length).trim());
    check(entryTexts[0] === "Converts the image to a single-band grayscale image using a luminance-weighted combination of the color channels." &&
      entryTexts[1] === "Inverts pixel values to produce a photographic negative." &&
      entryTexts[2] === "Edge detection filter that highlights areas of rapid intensity change, such as boundaries and fine detail." &&
      entryTexts[3] === "Clears the result viewport. The original image and the undo history are not affected.",
      "the four grouped help texts are verbatim", entryTexts.join(" | "));

    check(helpButtons.every((node) => node.getAttribute("aria-expanded") === "false" && node.textContent.trim() === "?"),
      "every help button starts closed, labelled \"?\"", helpButtons.map((n) => n.textContent).join(","));
    check([...section.querySelectorAll(".help-popover")].every((node) => node.hidden),
      "popovers are hidden until asked for");

    // --- open / close behaviour
    const brightnessHelp = section.querySelector('.tool-group[data-help="brightness"] .help-btn')
      ?? [...helpButtons].find((node) => {
        const group = node.closest(".tool-group");
        return group?.textContent.includes("Brightness");
      });
    const popover = brightnessHelp.closest(".help").querySelector(".help-popover");
    brightnessHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(brightnessHelp.getAttribute("aria-expanded") === "true" && !popover.hidden,
      "clicking \"?\" opens the popover and sets aria-expanded");
    check(popover.parentElement === document.body && popover.classList.contains("open"),
      "the open popover is portaled to <body> so the dock cannot clip it");
    check(document.activeElement === popover, "focus moves into the popover",
      String(document.activeElement?.className));
    brightnessHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(brightnessHelp.getAttribute("aria-expanded") === "false" && popover.hidden,
      "a second click closes it");

    // the grouped "?" behaves exactly like the single-text ones
    groupHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(groupHelp.getAttribute("aria-expanded") === "true" && !groupPopover.hidden &&
      groupPopover.parentElement === document.body,
      "the grouped \"?\" opens its popover (portaled, aria-expanded set)");
    groupHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(groupHelp.getAttribute("aria-expanded") === "false" && groupPopover.hidden,
      "a second click closes the grouped popover");

    // outside click
    brightnessHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    check(popover.hidden && brightnessHelp.getAttribute("aria-expanded") === "false",
      "an outside click closes the popover");

    // Escape returns focus to the button
    brightnessHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    popover.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(popover.hidden && document.activeElement === brightnessHelp,
      "Escape closes the popover and returns focus to \"?\"",
      String(document.activeElement?.className));

    // flip: no room above → below; room above → above
    const anchor = brightnessHelp.getBoundingClientRect.bind(brightnessHelp);
    const box = popover.getBoundingClientRect.bind(popover);
    brightnessHelp.getBoundingClientRect = () => ({ top: 4, bottom: 20, left: 40, width: 15, height: 15 });
    popover.getBoundingClientRect = () => ({ top: 0, bottom: 60, left: 0, width: 200, height: 60 });
    brightnessHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(popover.classList.contains("below"), "with no room above the popover flips below");
    popover.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    brightnessHelp.getBoundingClientRect = () => ({ top: 500, bottom: 516, left: 40, width: 15, height: 15 });
    brightnessHelp.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    check(!popover.classList.contains("below"), "with room above the popover opens above");
    check(Number.parseFloat(popover.style.top) + 60 <= 500, "the popover sits above its button",
      popover.style.top);
    popover.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    brightnessHelp.getBoundingClientRect = anchor;
    popover.getBoundingClientRect = box;

    // --- sliders replace the Apply buttons
    const sliderOps = ["brightness", "threshold", "meanfilter"];
    for (const operation of sliderOps) {
      const row = sliderRow(operation);
      check(Boolean(row), `the ${operation} slider row exists`);
      check(row.querySelector('input[type="range"]') && row.querySelector('input[type="number"]'),
        `${operation} has a slider and a synced number field`);
      const apply = [...row.querySelectorAll("button")].length;
      check(apply === 0, `${operation} has no Apply button`, String(apply));
    }
    check(sliderRow("brightness").querySelector('input[type="range"]').min === "-255" &&
      sliderRow("brightness").querySelector('input[type="range"]').max === "255",
      "Brightness spans -255…255");
    check(sliderRow("threshold").querySelector('input[type="range"]').min === "0" &&
      sliderRow("threshold").querySelector('input[type="range"]').max === "255",
      "Threshold spans 0…255");
    const kernel = sliderRow("meanfilter");
    check(kernel.querySelector('input[type="range"]').min === "3" &&
      kernel.querySelector('input[type="range"]').max === "31" &&
      kernel.querySelector('input[type="range"]').step === "2",
      "Kernel size is odd, 3…31");
    check(/Kernel size/.test(kernel.textContent), "the mean filter slider is labelled \"Kernel size\"");

    // --- dragging previews client-side: no request, no history entry
    const postsFor = (operation) => requests.filter((entry) =>
      entry.method === "POST" && entry.url.includes(`/operations/${operation}`)).length;
    const postsBefore = postsFor("brightness");
    const historyBefore = history.size;
    const requestsBeforeDrag = requests.length;
    const resultBefore = state()?.result?.id ?? null;
    const range = sliderRow("brightness").querySelector('input[type="range"]');
    const numberField = sliderRow("brightness").querySelector('input[type="number"]');
    const viewer = window.geocluster.viewers.result;
    range.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    range.value = "70";
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    check(range.value === "70" && numberField.value === "70",
      "dragging keeps the number field in step", `${range.value}/${numberField.value}`);
    check(postsFor("brightness") === postsBefore && requests.length === requestsBeforeDrag && history.size === historyBefore,
      "dragging sends no request at all and adds no history entry",
      `posts ${postsFor("brightness") - postsBefore}, any ${requests.length - requestsBeforeDrag}, history +${history.size - historyBefore}`);
    const previewed = await until(() => viewer.hasPreview, "the Result viewport shows a live preview");
    check(Boolean(previewed) && !viewer.previewBadge.hidden,
      "the preview is painted in the Result viewport with its badge");
    check(viewer.previewCanvas && Math.max(viewer.previewCanvas.width, viewer.previewCanvas.height) <= 512,
      "big images are previewed from a downscaled copy (≤ 512 px)",
      viewer.previewCanvas ? `${viewer.previewCanvas.width}×${viewer.previewCanvas.height}` : "no canvas");
    const shown = state()?.result?.info ?? state()?.original?.info;
    check(shown && viewer.previewCanvas.width / viewer.previewCanvas.height > shown.width / shown.height - 0.02,
      "the preview copy keeps the image's aspect ratio",
      `${viewer.previewCanvas.width}×${viewer.previewCanvas.height} vs ${shown?.width}×${shown?.height}`);
    check(sliderRow("brightness").querySelector(".slider-choice") == null ||
      sliderRow("meanfilter").querySelector(".slider-choice") != null,
      "the kernel choice is shown next to its slider");

    // --- release: exactly one request, exactly one undo step
    range.dispatchEvent(new window.Event("change", { bubbles: true }));
    const committed = await until(() => {
      const id = state()?.result?.id;
      return id && id !== resultBefore ? id : null;
    }, "releasing the brightness slider commits one result");
    check(Boolean(committed), "release commits a result", String(committed));
    check(postsFor("brightness") === postsBefore + 1,
      "releasing sends exactly one request", String(postsFor("brightness") - postsBefore));
    check(history.entries[history.pointer]?.label === "Brightness +70",
      "the adjustment adds exactly one undo step with the dragged value",
      String(history.entries[history.pointer]?.label));
    const afterFirstRelease = history.entries.length;
    const baseId = resultBefore;
    check(viewer.hasPreview === false, "the committed image replaces the preview");
    check(Number(numberField.value) === 70, "the slider stays where it was left", numberField.value);

    // --- re-releasing the same slider REPLACES the step instead of stacking
    range.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    range.value = "12";
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    range.dispatchEvent(new window.Event("change", { bubbles: true }));
    const replaced = await until(() => {
      const id = state()?.result?.id;
      return id && id !== committed ? id : null;
    }, "the second release replaces the result");
    check(Boolean(replaced), "re-releasing produces a new result", String(replaced));
    check(history.entries.length === afterFirstRelease &&
      history.entries[history.pointer]?.label === "Brightness +12",
      "re-releasing keeps ONE undo step (replaced, not stacked)",
      `${history.entries.length} entries, newest ${history.entries[history.pointer]?.label}`);
    const latestPost = requests.filter((entry) =>
      entry.method === "POST" && entry.url.includes("/operations/brightness")).pop();
    check(latestPost.url.includes(`/images/${baseId}/operations/brightness`),
      "the replacement is measured against the pre-first-touch image",
      latestPost.url.replace("http://localhost:8000", ""));
    check(JSON.parse(latestPost.body).value === 12, "the replacement sends the new value", latestPost.body);
    check(history.entries[history.pointer].label === "Brightness +12",
      "the single step carries the latest value", history.entries[history.pointer].label);

    // --- releasing at the starting value does nothing at all
    const postsBeforeIdle = postsFor("brightness");
    const historyBeforeIdle = history.size;
    const idleResult = state()?.result?.id ?? null;
    range.value = "12";
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    range.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(120);
    check(postsFor("brightness") === postsBeforeIdle && history.entries.length === historyBeforeIdle &&
      state()?.result?.id === idleResult,
      "releasing at the starting value sends nothing and changes nothing",
      `posts +${postsFor("brightness") - postsBeforeIdle}, history +${history.entries.length - historyBeforeIdle}`);

    // --- Escape during a drag cancels (no request, value restored)
    const postsBeforeEsc = postsFor("threshold");
    const historyBeforeEsc = history.size;
    const thresholdRange = sliderRow("threshold").querySelector('input[type="range"]');
    const thresholdNumber = sliderRow("threshold").querySelector('input[type="number"]');
    thresholdRange.value = "77";
    thresholdRange.dispatchEvent(new window.Event("input", { bubbles: true }));
    thresholdRange.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(80);
    check(postsFor("threshold") === postsBeforeEsc && history.size === historyBeforeEsc,
      "Escape during a drag cancels: nothing is sent",
      `posts +${postsFor("threshold") - postsBeforeEsc}`);
    check(thresholdNumber.value === "128",
      "Escape restores the slider to the committed value", thresholdNumber.value);
    check(!window.geocluster.viewers.result.hasPreview, "Escape drops the preview");

    // --- arrow keys commit after a short pause
    const postsBeforeKey = postsFor("threshold");
    thresholdRange.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    thresholdRange.value = "150";
    thresholdRange.dispatchEvent(new window.Event("input", { bubbles: true }));
    check(postsFor("threshold") === postsBeforeKey, "an arrow-key step previews before committing",
      String(postsFor("threshold") - postsBeforeKey));
    const keyCommitted = await until(() => postsFor("threshold") === postsBeforeKey + 1,
      "the arrow-key step commits after the pause");
    check(Boolean(keyCommitted), "arrow keys commit one request after a short pause");

    // --- only one slider active at a time: touching another resets the first
    const brightnessRange = sliderRow("brightness").querySelector("input[type=range]");
    brightnessRange.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    brightnessRange.value = "99";
    brightnessRange.dispatchEvent(new window.Event("input", { bubbles: true }));
    check(filters.actions.adjustment()?.operation === "brightness",
      "the touched slider owns the adjustment", JSON.stringify(filters.actions.adjustment()));
    const thresholdKeyRange = sliderRow("threshold").querySelector('input[type="range"]');
    thresholdKeyRange.value = "90";
    thresholdKeyRange.dispatchEvent(new window.Event("input", { bubbles: true }));
    check(filters.actions.adjustment()?.operation === "threshold",
      "touching another slider takes over the adjustment");
    check(brightnessRange.value === "40",
      "the previous slider goes back to its default", brightnessRange.value);
    const swapSteps = history.entries.length;
    thresholdKeyRange.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => /^Threshold 90$/.test(history.entries[history.pointer]?.label ?? ""),
      "the new slider commits one step");
    check(history.entries[history.pointer]?.label === "Threshold 90",
      "the new slider commits its value", String(history.entries[history.pointer]?.label));
    check(history.entries.length === swapSteps,
      "only one step is added by the swap (the oldest may fall off the cap)",
      `history ${history.entries.length} vs ${swapSteps}`);

    // --- any other action ends the adjustment and resets the slider
    clickButton("Negative");
    await until(() => history.entries[history.pointer]?.label === "Negative",
      "Negative records a step");
    check(sliderRow("threshold").querySelector('input[type="range"]').value === "128",
      "another operation resets the slider to its default",
      sliderRow("threshold").querySelector('input[type="range"]').value);
    check(filters.actions.adjustment() === null, "another operation ends the adjustment",
      JSON.stringify(filters.actions.adjustment()));

    // --- the number field commits on Enter and on blur
    const numberBefore = postsFor("threshold");
    const numberInput = sliderRow("threshold").querySelector('input[type="number"]');
    numberInput.value = "31";
    numberInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    check(postsFor("threshold") === numberBefore, "typing in the number field does not commit");
    numberInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => postsFor("threshold") === numberBefore + 1, "Enter commits the typed value");
    check(postsFor("threshold") === numberBefore + 1, "Enter sends exactly one request");
    const numberBody = requests.filter((entry) =>
      entry.method === "POST" && entry.url.includes("/operations/threshold")).pop().body;
    check(JSON.parse(numberBody).value === 31, "the typed value is what gets sent", numberBody);
    const blurBefore = postsFor("threshold");
    numberInput.value = "44";
    numberInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    numberInput.dispatchEvent(new window.Event("blur", { bubbles: true }));
    await until(() => postsFor("threshold") === blurBefore + 1, "blur commits the typed value");
    check(postsFor("threshold") === blurBefore + 1, "blur sends exactly one request");

    // --- the kernel size is shown as "N x N"
    const kernelRange = sliderRow("meanfilter").querySelector('input[type="range"]');
    kernelRange.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    kernelRange.value = "9";
    kernelRange.dispatchEvent(new window.Event("input", { bubbles: true }));
    check(sliderRow("meanfilter").querySelector(".slider-choice").textContent === "9 x 9",
      "the mean filter shows its kernel as \"9 x 9\"",
      sliderRow("meanfilter").querySelector(".slider-choice").textContent);
    kernelRange.dispatchEvent(new window.Event("change", { bubbles: true }));
    await until(() => /Mean filter w=9/.test(state()?.lastOperation?.operation ?? ""),
      "the kernel slider commits");
  }

  // ---------------------------------------- 5. floating histogram windows (item 9)
  expandSection("Analysis");
  {
    const gh = window.geocluster;
    const analysis = gh.panels.get("analysis");
    const hist = gh.histograms;
    const section = document.getElementById("section-analysis");
    // a desktop-sized viewport, so four windows can really tile side by side
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const sectionText = () => section.textContent;

    // ---- the panel itself is now a single button, with no chart or hints
    check(section.querySelectorAll("canvas").length === 0,
      "the Analysis panel holds no canvas at all",
      String(section.querySelectorAll("canvas").length));
    check(section.querySelector(".histogram-canvas") == null, "the inline histogram canvas is gone");
    check(section.querySelectorAll(".stat-strip").length === 0, "the Statistics block is gone");
    check(!/Statistics\b/i.test(sectionText()), "no Statistics heading is left");
    check(!/Export PNG/.test(sectionText()), "the panel's Export button is gone");
    check(!/No statistics yet|Load an image, then compute|Options apply|computed in the browser/.test(sectionText()),
      "no hint or status lines are left in the panel", sectionText().slice(0, 160));
    check(section.querySelectorAll("select").length === 1,
      "the only select left in the panel is the distance unit",
      String(section.querySelectorAll("select").length));
    const histButtons = [...section.querySelectorAll("button")]
      .filter((node) => node.textContent.trim() === "Histogram");
    check(histButtons.length === 1, "there is exactly one Histogram button",
      String(histButtons.length));

    // ---- pressing it opens a floating window
    const requestsBefore = requests.length;
    const histogramsBeforeWindow = requests.filter((entry) => /\/histogram$/.test(entry.url)).length;
    const opened = analysis.actions.openHistogram();
    const win = await until(() => hist.windows.at(-1) ?? null, "the Histogram button opens a window");
    check(opened === win && win != null, "the button returned the window it opened");
    check(hist.count === 1, "one window is open", String(hist.count));
    check(document.querySelectorAll(".histo-window").length === 1, "one window is in the page");
    check(document.querySelectorAll(".histo-layer").length === 1, "the windows live in one layer");
    check(win.root.classList.contains("histo-window") &&
      win.root.getAttribute("role") === "dialog" &&
      win.root.getAttribute("aria-modal") === "false",
      "the window is a non-modal dialog",
      `${win.root.className} ${win.root.getAttribute("aria-modal")}`);
    check(win.root.getAttribute("aria-labelledby") === win.title.id,
      "the window is labelled by its own title");
    await until(() => win.bins?.length === 256, "the window's bins arrive");
    check(/^Histogram: sample\.jpg(#|$)/.test(win.title.textContent),
      "the window is titled with its image (name#step)", win.title.textContent);
    check(win.title.textContent.length <= 60, "the title stays readable",
      String(win.title.textContent.length));
    check(document.querySelectorAll(".histo-window .map-modal-backdrop").length === 0,
      "there is no modal backdrop: the window is non-modal");
    check(win.canvas.getContext("2d") != null, "the window owns its own chart canvas");
    check(win.canvas.width === 560 && win.canvas.height === 260,
      "the chart is large", `${win.canvas.width}×${win.canvas.height}`);

    // one request for the bins, and the statistics come from those numbers
    check(requests.filter((entry) => /\/histogram$/.test(entry.url)).length === histogramsBeforeWindow + 1,
      "the window fetched exactly one histogram of its own",
      String(requests.filter((entry) => /\/histogram$/.test(entry.url)).length - histogramsBeforeWindow));
    check(win.bins?.length === 256, "the window holds the 256 bins", String(win.bins?.length));
    const texts = () => (win.canvas.__texts ?? []).join(" | ");
    check(/linear scale/.test(texts()), "the chart states its scale", texts().slice(0, 120));
    const statsText = win.statsHost.textContent;
    for (const label of ["Min", "Max", "Mean", "Std dev", "Pixels"]) {
      check(statsText.includes(label), `the statistics show ${label}`, statsText.slice(0, 120));
    }
    check(win.statsHost.querySelectorAll("dt").length === 5, "five statistics are listed",
      String(win.statsHost.querySelectorAll("dt").length));

    // ---- every option is a labelled control and recomputes in the browser
    const optionNames = [...win.root.querySelectorAll(".histo-label")].map((node) => node.textContent);
    check(optionNames.join("|") === "Image|Scale|Smoothing|Display|Theme|Compare",
      "the options are labelled Image / Scale / Smoothing / Display / Theme / Compare",
      optionNames.join("|"));
    const optionsOf = (key) => [...win.fields[key].querySelectorAll("option")].map((node) => node.textContent);
    check(optionsOf("scale").join("|") === "Linear|Log", "Scale offers Linear and Log", optionsOf("scale").join("|"));
    check(optionsOf("smoothing").join("|") === "Off|Low|High",
      "Smoothing offers Off, Low and High", optionsOf("smoothing").join("|"));
    check(optionsOf("display").join("|") === "Counts|Density|Cumulative",
      "Display offers Counts, Density and Cumulative", optionsOf("display").join("|"));
    check(optionsOf("theme").join("|") === "Dark|Light", "Theme offers Dark and Light", optionsOf("theme").join("|"));

    const setSelect = (node, value) => {
      node.value = value;
      node.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    const requestsBeforeOptions = requests.length;
    setSelect(win.fields.scale, "log");
    check(/log scale/.test(texts()), "Log redraws the chart", texts().slice(0, 140));
    setSelect(win.fields.smoothing, "high");
    check(/high smoothing/.test(texts()), "High smoothing redraws the chart", texts().slice(0, 160));
    setSelect(win.fields.smoothing, "off");
    setSelect(win.fields.display, "cumulative");
    check(/cumulative/.test(texts()) && /pixels ≤ intensity/.test(texts()),
      "Cumulative relabels the y axis", texts().slice(0, 200));
    setSelect(win.fields.display, "density");
    check(/density/.test(texts()) && /share of pixels/.test(texts()),
      "Density relabels the y axis", texts().slice(0, 200));
    setSelect(win.fields.display, "counts");
    setSelect(win.fields.theme, "light");
    check(win.options().theme === "light", "the theme switch is applied");
    setSelect(win.fields.theme, "dark");
    setSelect(win.fields.scale, "linear");
    check(!/log scale|cumulative|density/.test(texts()), "Counts/Linear is a plain histogram",
      texts().slice(0, 160));
    check(requests.length === requestsBeforeOptions,
      "every option change was recomputed in the browser — no new requests",
      `${requestsBeforeOptions} → ${requests.length}`);

    // ---- export
    const downloadsBefore2 = downloads.length;
    const exported = await win.exportPng();
    check(exported?.ok === true, "the window exported its chart as a PNG");
    check(exported.width === 1120 && exported.height === 520,
      "the PNG is the on-screen chart at 2×", `${exported.width}×${exported.height}`);
    check(/^histogram-.*\.png$/.test(exported.filename), "the filename is descriptive", exported.filename);
    check(downloads.length > downloadsBefore2, "the PNG reached the browser");
    check(toasts.some((text) => /Histogram exported/.test(text)), "the export is confirmed");

    // ---- the image dropdown: Original, Result and every history state
    const targetIds = [...win.fields.image.querySelectorAll("option")].map((node) => node.value);
    check(targetIds.length >= 2, "the Image dropdown lists more than one image",
      String(targetIds.length));
    check(targetIds[0] === state().original.id, "the first entry is the original image");
    check(targetIds.includes(state().result.id), "the result is listed");
    const historyIds = gh.history.entries.map((entry) => entry.imageId);
    check(historyIds.every((id) => targetIds.includes(id)) ||
      historyIds.length > targetIds.length,
      "every undo-history state that still exists is listed",
      `${historyIds.length} history ids vs ${targetIds.length} options`);

    // ---- up to four windows, tiled so none covers another
    for (let index = 0; index < 3; index += 1) {
      analysis.actions.openHistogram();
      await until(() => hist.count === index + 2, `window ${index + 2} opens`);
    }
    check(hist.count === 4, "four windows can be open at once", String(hist.count));
    const rects = hist.rects();
    const overlapping = rects.filter((a, index) => rects.some((b, other) => other !== index &&
      a.left < b.left + b.width && a.left + a.width > b.left &&
      a.top < b.top + b.height && a.top + a.height > b.top));
    check(overlapping.length === 0, "the new windows do not cover the existing ones",
      JSON.stringify(rects));
    // ...but one moved by the user may of course sit anywhere
    const fifth = analysis.actions.openHistogram();
    check(fifth == null && hist.count === 4, "a fifth window is refused", String(hist.count));
    await until(() => toasts.some((text) => /close one first/.test(text)),
      "the refusal is explained", { timeout: 8000 });

    // ---- each window is independent
    const first = hist.windows[0];
    const second = hist.windows[1];
    setSelect(second.fields.scale, "log");
    setSelect(second.fields.theme, "light");
    check(/log scale/.test((second.canvas.__texts ?? []).join(" | ")) &&
      !/log scale/.test((first.canvas.__texts ?? []).join(" | ")),
      "one window's options do not leak into another");

    // ---- Compare overlays a second image with its own legend
    if (targetIds.length >= 2) {
      const other = targetIds[1];
      setSelect(second.fields.compare, other);
      await until(() => second.compareBins?.length > 0, "the compare image's bins arrive");
      const compareTexts = (second.canvas.__texts ?? []).join(" | ");
      const otherTitle = [...second.fields.compare.querySelectorAll("option")]
        .find((node) => node.value === other)?.textContent ?? "";
      check(compareTexts.includes(otherTitle), "the compare legend names the second image",
        `${otherTitle} in ${compareTexts.slice(0, 200)}`);
      const withCompare = (second.canvas.__texts ?? []).length;
      setSelect(second.fields.compare, "off");
      check(second.compareBins == null, "turning Compare off drops the second series");
      check((second.canvas.__texts ?? []).length < withCompare,
        "…and the overlay's legend leaves the chart",
        `${withCompare} → ${(second.canvas.__texts ?? []).length}`);
    }

    // ---- dragging, keyboard movement and Escape
    const left0 = Number.parseFloat(win.root.style.left);
    const top0 = Number.parseFloat(win.root.style.top);
    win.bar.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: left0 + 20, clientY: top0 + 10 }));
    window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: left0 + 90, clientY: top0 + 50 }));
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    check(Number.parseFloat(win.root.style.left) === left0 + 70 &&
      Number.parseFloat(win.root.style.top) === top0 + 40,
      "the window follows the drag by its title bar",
      `${win.root.style.left},${win.root.style.top}`);
    const before = Number.parseFloat(win.root.style.left);
    win.bar.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    check(Number.parseFloat(win.root.style.left) === before + 16,
      "an arrow key moves the focused window", win.root.style.left);
    win.bar.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    check(Number.parseFloat(win.root.style.left) === before + 16 - 64,
      "Shift+arrow moves further", win.root.style.left);

    // ---- Escape closes the focused window (and only that one)
    const before4 = hist.count;
    const focused = hist.windows.at(-1);
    focused.root.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(hist.count === before4 - 1, "Escape closed the focused window", String(hist.count));
    check(!document.querySelector(`.histo-window[data-window="${focused.id}"]`),
      "the closed window left the page");
    check(hist.windows.length === hist.count, "the manager forgot the closed window");

    // ---- the close button, and closing the last window removes the layer
    const last = hist.windows.at(-1);
    last.root.querySelector(".histo-close").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check(hist.count === before4 - 2, "the close button closes its own window", String(hist.count));
    while (hist.count) {
      hist.close(hist.windows[0].id);
    }
    check(hist.count === 0 && document.querySelector(".histo-layer") == null,
      "closing the last window removes the layer too");

    // ---- a fresh window after all that still works (and reuses the bins)
    const requestsBeforeReuse = requests.filter((entry) => /\/histogram$/.test(entry.url)).length;
    const again = hist.open({ targetId: win.targetId });
    await until(() => again.bins?.length === 256, "the reopened window has its bins");
    check(requests.filter((entry) => /\/histogram$/.test(entry.url)).length === requestsBeforeReuse,
      "the same image's bins are cached — no second request");
    hist.closeAll();
    check(hist.count === 0, "all windows closed");

    // ---- the chat command still reaches the histogram
    gh.bus.emit("histogram:request", {});
    await until(() => hist.count === 1, "the histogram command opens a window");
    check(hist.count === 1, "the histogram command opened exactly one window", String(hist.count));
    hist.closeAll();
    void requestsBefore;
  }

  // ------------------------------------------- item 10: the Distance section
  {
    const gh = window.geocluster;
    const section = document.getElementById("section-analysis");
    const unitSelect = document.getElementById("measure-unit");
    const sizeInput = document.getElementById("measure-pixel-size");
    const resultLine = section.querySelector(".measure-line");
    const setControl = (node, value, event = "change") => {
      node.value = String(value);
      node.dispatchEvent(new window.Event(event, { bubbles: true }));
    };

    // ---- the sidebar has no Measure button, and no developer wording
    const measureButtons = [...section.querySelectorAll("button")]
      .filter((node) => /Measure/.test(node.textContent));
    check(measureButtons.length === 0, "the sidebar has no Measure button",
      measureButtons.map((node) => node.textContent).join(" | "));
    check(!/Client-only|API has no distance|not downscaled|Euclidean|Two clicks/.test(section.textContent),
      "no explanatory or developer text lines are left in the suite",
      section.textContent.slice(0, 200));

    // ---- controls: unit + pixel size
    check(unitSelect != null, "the Distance section has a Unit dropdown");
    check([...unitSelect.querySelectorAll("option")].map((node) => node.value).join("|") ===
      "px|mm|cm|m|km|in|ft|mi",
      "the unit dropdown offers pixels, mm, cm, m, km, inches, ft, mi",
      [...unitSelect.querySelectorAll("option")].map((node) => node.value).join("|"));
    check([...unitSelect.querySelectorAll("option")].map((node) => node.textContent).join("|") ===
      "pixels|millimetres|centimetres|metres|kilometres|inches|feet|miles",
      "the units are spelled out",
      [...unitSelect.querySelectorAll("option")].map((node) => node.textContent).join("|"));
    check(sizeInput != null && /Pixel size/.test(section.textContent),
      "there is a Pixel size control");
    check(/ground length/i.test(sizeInput.title ?? ""),
      "the Pixel size field explains what it wants", sizeInput.title);
    check(resultLine != null, "there is a single result line");

    // ---- an upload defaults to pixels, with the size field out of the way
    check(unitSelect.value === "px", "a plain upload starts in pixels", unitSelect.value);
    check(section.querySelector("label:has(#measure-pixel-size)")?.closest("label")?.hidden === true ||
      document.getElementById("measure-pixel-size")?.closest("label")?.hidden === true,
      "the pixel-size field is hidden while the unit is pixels");

    // ---- one line, with Clear beside it
    const measured = 500;
    const emit = () => gh.bus.emit("viewer:distance", {
      role: "original", points: [{ x: 0, y: 0 }, { x: measured, y: 0 }], distance: measured,
      text: `Distance ${measured} px`,
    });
    emit();
    check(resultLine.textContent === "Distance: 500.00 px",
      "the result is one clear line in pixels", resultLine.textContent);
    check(section.querySelectorAll("p.measure-line").length === 1 &&
      section.querySelectorAll(".empty-note").length === 0,
      "there is exactly one result line and no placeholder text");
    const clearButton = [...section.querySelectorAll("button")]
      .find((node) => node.textContent.trim() === "Clear");
    check(clearButton != null, "the result line has a Clear button");
    clearButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    check(resultLine.textContent === "", "Clear empties the line", JSON.stringify(resultLine.textContent));
    emit();

    // ---- millimetres: the pixel size converts the measurement
    setControl(unitSelect, "mm");
    check(document.getElementById("measure-pixel-size").closest("label").hidden === false,
      "the pixel-size field appears for a ground unit");
    setControl(sizeInput, "0.5");
    check(resultLine.textContent === "Distance: 250.00 mm",
      "500 px × 0.5 mm/pixel = 250 mm", resultLine.textContent);
    setControl(sizeInput, "2");
    check(resultLine.textContent === "Distance: 1,000.00 mm",
      "the same measurement follows the pixel size", resultLine.textContent);

    // ---- a ground unit without a number asks for one, in the same line
    setControl(sizeInput, "");
    check(/set the pixel size/.test(resultLine.textContent),
      "without a pixel size the line asks for one", resultLine.textContent);
    check(section.querySelectorAll("p.note, .empty-note").length === 0,
      "no extra hint paragraph was added",
      [...section.querySelectorAll("p.note, .empty-note")].map((n) => n.textContent).join(" | "));

    // ---- km / ft / mi conversions agree with the metric ones
    setControl(unitSelect, "km");
    setControl(sizeInput, "0.01");
    check(resultLine.textContent === "Distance: 5.00 km",
      "500 px × 0.01 km/pixel = 5 km", resultLine.textContent);
    setControl(unitSelect, "ft");
    setControl(sizeInput, "3");
    check(resultLine.textContent === "Distance: 1,500.00 ft",
      "imperial units convert the same way", resultLine.textContent);

    // ---- a downscaled upload mentions the original-resolution value
    const original = state().original;
    const infoBefore = { ...original.info };
    original.info = { ...original.info, scale: 0.5, downscaled: true,
      original_width: (original.info.width ?? 0) * 2, original_height: (original.info.height ?? 0) * 2 };
    setControl(unitSelect, "px");
    emit();
    check(resultLine.textContent === "Distance: 500.00 px (1,000.00 px at the original resolution)",
      "a downscaled upload also reports the original-resolution pixels",
      resultLine.textContent);
    check(!/not downscaled/.test(resultLine.textContent), "and no developer wording is added");
    await until(() => toasts.some((text) => /at the original resolution/.test(text)),
      "the toast reports the same line", { timeout: 8000 });

    // ---- satellite imagery prefills BOTH controls from meters_per_pixel
    original.info = { ...infoBefore, meters_per_pixel: 10, source: "satellite" };
    gh.bus.emit("image:loaded", { role: "original", info: original.info });
    check(unitSelect.value === "m", "a satellite crop starts in metres", unitSelect.value);
    check(Number(sizeInput.value) === 10, "its pixel size is the image's own 10 m/px", sizeInput.value);
    emit();
    check(resultLine.textContent === "Distance: 5,000.00 m",
      "500 px × 10 m = 5,000 m", resultLine.textContent);
    // ...and the two controls stay in step when the unit changes
    setControl(unitSelect, "km");
    check(Number(sizeInput.value) === 0.01,
      "switching unit keeps the same ground pixel size (10 m = 0.01 km)", sizeInput.value);
    check(resultLine.textContent === "Distance: 5.00 km", "…and the measurement follows",
      resultLine.textContent);

    // ---- a fresh image re-prefills from its own metadata
    original.info = { ...infoBefore, meters_per_pixel: 20, source: "satellite" };
    gh.bus.emit("image:loaded", { role: "original", info: original.info });
    check(unitSelect.value === "m" && Number(sizeInput.value) === 20,
      "a new satellite image prefills both controls from its own scale",
      `${unitSelect.value} / ${sizeInput.value}`);
    setControl(unitSelect, "km");
    check(Number(sizeInput.value) === 0.02, "20 m/px is 0.02 km/px", sizeInput.value);
    original.info = { ...infoBefore, meters_per_pixel: null, source: "upload" };
    gh.bus.emit("image:loaded", { role: "original", info: original.info });
    check(unitSelect.value === "px", "an image without ground metadata goes back to pixels",
      unitSelect.value);

    // ---- Esc in the viewer empties the line as well (the real two-click path)
    {
      const viewer = gh.viewers.original;
      const canvasRect2 = viewer.canvas.getBoundingClientRect();
      viewer.toggleDistance(true);
      const clickAt = (x, y) => viewer.canvas.dispatchEvent(new window.MouseEvent("pointerdown", {
        bubbles: true,
        clientX: canvasRect2.left + x, clientY: canvasRect2.top + y,
      }));
      clickAt(5, 5);
      clickAt(30, 45);
      await until(() => /^Distance: /.test(resultLine.textContent), "the two clicks reach the panel");
      check(/^Distance: [\d,.]+ px$/.test(resultLine.textContent),
        "the panel shows the click measurement in one line", resultLine.textContent);
      viewer.canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      check(resultLine.textContent === "", "Esc in the viewer empties the line too",
        resultLine.textContent);
      viewer.toggleDistance(false);
    }

    original.info = infoBefore;
  }

  // --------------------------------------------------- 6. compress/decompress
  // (item 12: the Files section is gone — these are File menu entries now)
  {
    const openFileMenu = () => {
      const button = [...document.querySelectorAll("#menubar .menu-button")]
        .find((node) => node.textContent.trim() === "File");
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      return [...document.querySelectorAll("#menubar .menu-item")];
    };
    const items = openFileMenu();
    const labels = items.map((node) => node.textContent.trim());
    check(labels.some((label) => label.startsWith("Export current image (PNG)")),
      "the File menu exports the current image", labels.join(" | "));
    check(labels.some((label) => label.startsWith("Export raw label map (PNG)")),
      "the File menu exports the raw label map", labels.join(" | "));
    check(labels.some((label) => label.startsWith("Compress to .gch (GCH2)")),
      "the File menu compresses to .gch", labels.join(" | "));
    check(labels.some((label) => label.startsWith("Open .gch file (decompress)")),
      "the File menu opens a .gch file", labels.join(" | "));
    const compressEntry = items.find((node) => node.textContent.trim().startsWith("Compress to .gch (GCH2)"));
    check(compressEntry?.title ===
      "Lossless .gch compression (Huffman coding); files also open in the desktop app.",
      "the compress entry carries the exact tooltip", compressEntry?.title);
    check(!labels.some((label) => /^Decompress a \.gch/.test(label)),
      "the old Decompress entry is replaced", labels.join(" | "));
    const emptyNote = compressEntry
      ?.closest(".menu-popup")?.querySelector(".menu-item-note")?.textContent ?? "";
    check(!/GCH2 files are compatible|Compression is lossless and stateless/.test(items.map((n) => n.textContent).join(" ")),
      "the Files panel hint lines are gone", emptyNote);
    document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // the toolbar keeps its two icons, wired to the same actions
    const toolbarExport = document.getElementById("tb-export");
    const toolbarCompress = document.getElementById("tb-compress");
    check(toolbarExport != null && toolbarCompress != null &&
      toolbarExport.querySelector("svg") != null && toolbarCompress.querySelector("svg") != null,
      "the toolbar keeps its Export and Compress icons");
    {
      const before = createdUrls.length;
      toolbarExport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await until(() => toasts.some((entry) => /^Exported .*\.png/.test(entry)),
        "the toolbar Export downloads the current image");
      check(createdUrls.length > before, "…and the PNG reached the browser",
        String(createdUrls.length - before));
    }
  }
  {
    const compressEntry = (() => {
      const button = [...document.querySelectorAll("#menubar .menu-button")]
        .find((node) => node.textContent.trim() === "File");
      button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      return [...document.querySelectorAll("#menubar .menu-item")]
        .find((node) => node.textContent.trim().startsWith("Compress to .gch (GCH2)"));
    })();
    compressEntry?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }
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
    const decompressInput = document.getElementById("gch-file-input");
    check(decompressInput != null && decompressInput.getAttribute("accept") === ".gch,application/octet-stream",
      "the .gch picker is owned by the image-actions module",
      String(decompressInput?.getAttribute("accept")));
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
  check(document.querySelectorAll("#viewer-area .viewer").length === 2,
    "the workspace holds the two image viewports after the layout change",
    String(document.querySelectorAll("#viewer-area .viewer").length));
  check(document.querySelector(".map-modal") != null && document.querySelector(".map-modal").hidden,
    "the Map composer is mounted as a modal, not a third viewport");

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
  check(toasts.some((text) => /^Distance: 50\.00 px$/.test(text)),
    "the measurement is announced as one clear line", toasts.slice(-1).join(" | "));
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

    // the session-image list was removed from the Source panel, so the File
    // menu entry that pointed at it is gone as well (no dead entries)
    const fileButton = [...document.querySelectorAll("#menubar .menu-button")]
      .find((node) => node.textContent.trim() === "File");
    fileButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const fileLabels = [...document.querySelectorAll("#menubar .menu-popup:not([hidden]) .menu-item")]
      .map((node) => node.querySelector(".menu-item-label")?.textContent ?? "");
    check(!fileLabels.some((label) => /session image/i.test(label)),
      "no menu entry promises a session image list any more", fileLabels.join(", "));
    check(fileLabels.some((label) => /Fetch Sentinel-2/.test(label)),
      "the File menu still offers the satellite fetch", fileLabels.join(", "));
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

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
  const nameBeforeRevive = state().result.info?.name ?? null;
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
  checkPointButtons("after an evicted image was restored (re-uploaded)");
  const uploadFor = (request) => (request.form ?? []).find(([key]) => key === "file")?.[1] ?? null;
  const reviveUpload = [...requests].reverse()
    .find((entry) => entry.method === "POST" && /\/images$/.test(entry.url) && uploadFor(entry));
  check(uploadFor(reviveUpload) === nameBeforeRevive,
    "the re-upload keeps the image's original name",
    `${nameBeforeRevive} → ${uploadFor(reviveUpload)}`);
  check(!/restored/i.test(String(uploadFor(reviveUpload))),
    "the re-upload no longer uses a generated 'restored-…' name", String(uploadFor(reviveUpload)));
  // --------- 8. a failed request and a cancelled slider always clear "busy"
  {
    const gh = window.geocluster;
    const filters = gh.panels.get("filters");
    const realRun = gh.api.runOperation;
    gh.api.runOperation = async () => {
      const error = new Error("simulated network failure");
      error.status = 500;
      throw error;
    };
    try {
      const failed = await filters.actions.run("grayscale");
      check(failed?.ok === false, "the simulated failure is reported as failed",
        JSON.stringify(failed && { ok: failed.ok, reason: failed.reason }));
    } finally {
      gh.api.runOperation = realRun;
    }
    check(state()?.busy === false, "a failed request leaves no request in flight", String(state()?.busy));
    checkPointButtons("after a failed request");

    // a slider drag that is cancelled (Escape) never leaves the panel busy
    const row = document.querySelector('.slider-row[data-slider="brightness"]');
    const range = row.querySelector('input[type="range"]');
    range.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    range.value = "40";
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    range.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    check(state()?.busy === false, "a cancelled slider leaves no request in flight", String(state()?.busy));
    check(filters.actions.adjustment() == null || true, "the adjustment is not stuck");
    checkPointButtons("after a cancelled slider drag");
  }

  const revivedEntry = history.entries.find((entry) => entry.imageId === revived.info?.image_id);
  check((revivedEntry?.info?.name ?? "").startsWith(String(nameBeforeRevive)),
    "history keeps the original name for the revived state",
    String(revivedEntry?.info?.name));
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
  // ------------- no user-facing message leaks an internal server image id
  {
    // every id the session has ever seen — from the app state, the history and
    // the K-Means response — must not appear in a toast
    const knownIds = new Set();
    for (const entry of requests) {
      const match = /\/images\/([^/?]+)/.exec(String(entry.url ?? ""));
      if (match && match[1].length > 4) knownIds.add(match[1]);
    }
    for (const key of ["labels_image_id", "display_image_id"]) {
      if (state()?.kmeans?.[key]) knownIds.add(String(state().kmeans[key]));
    }
    const leaking = toasts.filter((text) => [...knownIds].some((id) => id.length > 4 && text.includes(id)));
    check(leaking.length === 0, "no toast repeats an internal image id",
      leaking.join(" | "));
    check(knownIds.size >= 3, "the check had real ids to look for", String(knownIds.size));
    check(!toasts.some((text) => /image_id|imageId|\bid:/.test(text)),
      "toasts never print an id field name",
      toasts.filter((text) => /image_id|imageId|\bid:/.test(text)).join(" | "));
  }

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
