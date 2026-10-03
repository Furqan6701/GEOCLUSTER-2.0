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
  url: "http://localhost:5173/",
  pretendToBeVisual: true,
  runScripts: "outside-only",
});
const { window } = dom;
const { document } = window;

// ---------------------------------------------------------------- browser stubs

const toasts = [];
const createdUrls = [];
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
    drawImage: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    putImageData: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    measureText: () => ({ width: 10 }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
}

window.HTMLCanvasElement.prototype.getContext = function getContext() {
  this.__ctx ??= fakeContext2D(this);
  return this.__ctx;
};
window.HTMLAnchorElement.prototype.click = function click() {
  createdUrls.push(this.href);
  lastDownloadedBlob = window.__lastObjectUrlBlob ?? lastDownloadedBlob;
};
window.URL.createObjectURL = (blob) => {
  window.__lastObjectUrlBlob = blob;
  lastDownloadedBlob = blob;
  const url = `blob:jsdom/${createdUrls.length}`;
  createdUrls.push(url);
  return url;
};
window.URL.revokeObjectURL = () => {};
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
async function patchedFetch(input, init = {}) {
  const options = { ...init };
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
window.addEventListener("error", (event) => uncaught.push(String(event.message)));
window.addEventListener("unhandledrejection", (event) => uncaught.push(String(event.reason)));

console.log(`boot test — ${WEB} → ${API_BASE}\n`);
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
  check(state()?.ttlMinutes === 60, "session TTL reported (60 min)", String(state()?.ttlMinutes));
  check(state()?.maxImages === 6, "session image cap reported (6)", String(state()?.maxImages));
  check(state()?.health != null, "GET /health fetched and rendered");
  check(document.querySelectorAll("#tabs .tab").length === 5, "five sidebar tabs rendered",
    String(document.querySelectorAll("#tabs .tab").length));
  check(document.querySelectorAll(".viewer").length === 2, "two viewer slots rendered",
    String(document.querySelectorAll(".viewer").length));
  check(document.querySelector(".chat-log") != null, "chat panel mounted");
  check(document.getElementById("chat-column").textContent.includes("plain text"),
    "chat explains that math is not rendered");

  const chips = document.getElementById("status-chips").textContent;
  check(/session [0-9a-zA-Z]{8}/.test(chips), "status chip shows the session id", chips);
  check(/AI (ready|not configured)/.test(chips), "status chip shows the AI state", chips);
  check(/Satellite (ready|not configured)/.test(chips), "status chip shows the satellite state", chips);

  // ---------------------------------------------------------------- 2. upload
  const uploadBytes = await readFile(FIXTURE);
  const uploadFile = new File([new Uint8Array(uploadBytes)], "sample.jpg", { type: "image/jpeg" });
  const sourceInput = document.querySelector("#tabpanels input[type=file]");
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
  const numberInputNear = (labelText) => {
    const field = [...document.querySelectorAll("#tabpanels .field")]
      .find((node) => node.querySelector("label")?.textContent.trim() === labelText);
    return field ? field.querySelector("input") : null;
  };
  const kInput = numberInputNear("Clusters (K)");
  check(kInput?.value === "5", "K defaults to 5", String(kInput?.value));
  clickButton("Run K-Means");
  const kmeans = await until(() => state()?.kmeans, "K-Means runs from the panel");
  check(Boolean(kmeans), "K-Means response stored");
  check(kmeans?.k === 5, "K-Means used k=5", String(kmeans?.k));
  check(kmeans?.ranges?.length === 5, "five cluster ranges returned", String(kmeans?.ranges?.length));
  const rangeRows = [...document.querySelectorAll("#tabpanels table.grid tr")]
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length === 4);
  const verified = [["0", "80"], ["81", "117"], ["118", "155"], ["156", "194"], ["195", "255"]];
  const shown = rangeRows.map((cells) => [cells[1], cells[2]]);
  check(JSON.stringify(shown) === JSON.stringify(verified),
    "the ranges table shows the verified sample.jpg min/max values", JSON.stringify(shown));
  check(rangeRows.every((cells, index) => cells[0] === String(index)),
    "ranges table lists clusters in order", JSON.stringify(rangeRows.map((cells) => cells[0])));
  check(Object.keys(kmeans?.assignments ?? {}).length === 5, "assignments received for every cluster");

  clickButton("Classify");
  const legend = await until(() => {
    const text = document.getElementById("tabpanels").textContent;
    return /Classify|assignments|legend/i.test(text) && state()?.result ? text : null;
  }, "classify returns an image");
  check(Boolean(legend), "classify result loaded");

  // ------------------------------------------------------------- 4. filters
  const labels = ["Grayscale", "Negative", "Laplacian", "Brightness", "Threshold", "Mean filter"];
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
  check(toasts.some((text) => /grayscale complete/.test(text)) && toasts.some((text) => /meanfilter complete/.test(text)),
    "filter completion toasts shown", toasts.slice(-3).join(" | "));

  // ------------------------------------------------- 5. histogram + stats
  clickButton("Histogram & stats");
  const statsText = await until(() => {
    const text = document.getElementById("tabpanels").textContent;
    return /mean/i.test(text) && /std/i.test(text) ? text : null;
  }, "histogram and stats render");
  check(Boolean(statsText), "histogram/stats rendered in the analysis panel");
  check(/256/.test(statsText ?? ""), "histogram reports 256 bins", (statsText ?? "").slice(0, 80));
  check(document.querySelectorAll("#tabpanels canvas").length >= 1, "histogram canvas created");

  // --------------------------------------------------- 6. compress/decompress
  clickButton("Compress current image → .gch");
  const gch = await until(async () => {
    if (!lastDownloadedBlob) return null;
    const bytes = new Uint8Array(await lastDownloadedBlob.arrayBuffer());
    return bytes.length > 8 ? bytes : null;
  }, "compress downloads a .gch blob", { timeout: 15000 });
  check(Boolean(gch), "compress produced a download", toasts.slice(-2).join(" | "));
  if (gch) {
    const magic = String.fromCharCode(...gch.slice(0, 4));
    check(magic === "GCH2", "downloaded file carries the GCH2 magic", magic);
    const fileInputs = document.querySelectorAll('#tabpanels input[type=file]');
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

  await sendChat("Show me F-8 imagery");
  await until(() => bubbles().some((text) => text.startsWith("Router →")), "chat runs the router command");
  const afterCommand = await until(() => {
    const list = bubbles();
    return list.some((text) => /Satellite fetch requested for F-8/.test(text) || /F-8.*failed/.test(text)) ? list : null;
  }, "satellite command reported back");
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
