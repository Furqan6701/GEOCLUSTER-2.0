/**
 * Logic tests for the DOM-free frontend modules.
 *
 * Run:  node --test web/tests/     (from the repository root)
 *       node --test tests/         (from web/)
 */

import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_API_BASE,
  PROXY_API_BASE,
  isUsableApiBase,
  isValidHttpUrl,
  normalizeBase,
  resolveApiBase,
} from "../js/config.js";
import { ApiError, detailToText, humanizeError, sanitizeMessage, validationToText } from "../js/errors.js";
import {
  HELP_TEXTS,
  KEY_COMMIT_DELAY,
  OPERATIONS_WITH_PARAMS,
  POINT_OPERATION_HELP,
  SLIDER_SPECS,
  describeOperation,
  paramsForValue,
  snapSliderValue,
} from "../js/panels/operations.js";
import {
  PREVIEW_MAX_SIDE,
  applyBrightness,
  applyMeanFilter,
  applyPixels,
  applyThreshold,
  previewSize,
  reflect101,
} from "../js/preview.js";
import { ApiClient } from "../js/api.js";
import { HISTORY_LIMIT, ImageHistory, snapshotOf } from "../js/history.js";
import {
  SCALES,
  SMOOTHING_WINDOWS,
  THEMES,
  axisLabels,
  cumulativeBins,
  densityBins,
  describeOptions,
  drawHistogram,
  histogramFileName,
  prepareBins,
  smoothBins,
} from "../js/histogram.js";
import { UNITS, convertPixels, describeDistance, formatMeasurement, unitRateLabel } from "../js/measure.js";
import {
  composeMap,
  drawLegend,
  fitText,
  formatPercentage,
  legendMetrics,
  legendRows,
  mapFileName,
} from "../js/map.js";
import { defaultParamsFor, describeCommand, executeCommands } from "../js/commands.js";

// --------------------------------------------------------------- test doubles

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)]),
  };
}

function recordingFetch(payload = {}, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(payload, options);
  };
  return { calls, fetchImpl };
}

const parseBody = (init) => (init.body ? JSON.parse(init.body) : undefined);

// ------------------------------------------------------------------- config

test("normalizeBase trims whitespace and trailing slashes", () => {
  assert.equal(normalizeBase("  http://localhost:8000///  "), "http://localhost:8000");
  assert.equal(normalizeBase(null), "");
  assert.equal(normalizeBase(undefined), "");
});

test("isValidHttpUrl accepts http(s) only", () => {
  assert.equal(isValidHttpUrl("http://localhost:8000"), true);
  assert.equal(isValidHttpUrl("https://api.example.com"), true);
  assert.equal(isValidHttpUrl("ftp://localhost"), false);
  assert.equal(isValidHttpUrl("localhost:8000"), false);
  assert.equal(isValidHttpUrl(""), false);
});

test("resolveApiBase falls back to the default", () => {
  assert.equal(resolveApiBase({}), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ search: "?other=1" }), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ search: "?api=not-a-url" }), DEFAULT_API_BASE);
});

test("resolveApiBase prefers the query string, then storage", () => {
  assert.equal(resolveApiBase({ search: "?api=http://127.0.0.1:9000/" }), "http://127.0.0.1:9000");
  const storage = { getItem: (key) => (key === "geocluster.apiBase" ? "http://10.0.0.5:8000" : null) };
  assert.equal(resolveApiBase({ search: "", storage }), "http://10.0.0.5:8000");
  assert.equal(resolveApiBase({ search: "?api=http://127.0.0.1:9000", storage }), "http://127.0.0.1:9000");
});

test("resolveApiBase uses the same-origin /api path off the dev machine", () => {
  assert.equal(resolveApiBase({ hostname: "localhost" }), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ hostname: "127.0.0.1" }), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ hostname: "" }), DEFAULT_API_BASE);
  assert.equal(resolveApiBase({ hostname: "5173-abc.e2b.app" }), PROXY_API_BASE);
  assert.equal(resolveApiBase({ hostname: "192.168.1.20" }), PROXY_API_BASE);
  // an explicit choice always wins over the host default
  assert.equal(resolveApiBase({ hostname: "5173-abc.e2b.app", search: "?api=http://127.0.0.1:9000" }),
    "http://127.0.0.1:9000");
  assert.equal(resolveApiBase({ hostname: "5173-abc.e2b.app", search: "?api=/api" }), "/api");
  assert.equal(resolveApiBase({ hostname: "5173-abc.e2b.app", search: "?api=//evil.example" }), PROXY_API_BASE);
});

test("isUsableApiBase accepts http(s) URLs and same-origin paths only", () => {
  assert.equal(isUsableApiBase("http://localhost:8000"), true);
  assert.equal(isUsableApiBase("https://api.example.com/"), true);
  assert.equal(isUsableApiBase("/api"), true);
  assert.equal(isUsableApiBase("//evil.example/api"), false);
  assert.equal(isUsableApiBase("javascript:alert(1)"), false);
  assert.equal(isUsableApiBase(""), false);
});

test("resolveApiBase survives a storage that throws", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(resolveApiBase({ storage }), DEFAULT_API_BASE);
});

// ------------------------------------------------------------------- errors

test("detailToText handles every detail shape", () => {
  assert.equal(detailToText("boom"), "boom");
  assert.equal(detailToText(null), "");
  assert.equal(
    detailToText([
      { loc: ["body", "value"], msg: "Input should be less than or equal to 255" },
      { loc: ["body", "window"], msg: "window must be an odd number" },
    ]),
    "value must be 255 or less; window size must be an odd number",
  );
  assert.equal(detailToText(["one", "two"]), "one; two");
  assert.equal(detailToText({ detail: "nested" }), "nested");
  assert.equal(detailToText({ message: "with message" }), "with message");
  assert.equal(detailToText({ unexpected: true }), ""); // never dump raw JSON
});

test("ApiError flags network and session failures", () => {
  assert.equal(new ApiError(0, "network").isNetwork, true);
  assert.equal(new ApiError(404, "Unknown or expired session: abc").isSessionExpired, true);
  assert.equal(new ApiError(404, "Unknown image: xyz").isSessionExpired, false);
  assert.equal(new ApiError(500, null).isSessionExpired, false);
});

test("humanizeError maps statuses to friendly text", () => {
  assert.match(humanizeError(new ApiError(0, "network"), { apiBase: "http://localhost:8000" }), /Can't reach the API at http:\/\/localhost:8000/);
  assert.match(humanizeError(new ApiError(413, null)), /too large/i);
  assert.match(humanizeError(new ApiError(415, null)), /isn't a supported image/i);
  assert.match(humanizeError(new ApiError(429, null)), /Too many requests/i);
  assert.match(humanizeError(new ApiError(503, null)), /isn't configured/i);
  assert.match(humanizeError(new ApiError(507, null)), /memory is full/i);
  assert.match(humanizeError(new ApiError(502, null)), /unavailable/i);
  assert.equal(humanizeError(new ApiError(404, "Unknown image: abc")), "Unknown image: abc");
  assert.equal(humanizeError(new ApiError(500, null)), "The request failed (HTTP 500).");
  assert.equal(humanizeError(new Error("boom")), "boom");
  assert.equal(humanizeError("weird"), "Something went wrong.");
});

test("humanizeError turns a 422 detail list into one sentence and never shows JSON", () => {
  const error = new ApiError(422, [{ loc: ["body", "k"], msg: "Input should be less than or equal to 20" }]);
  const text = humanizeError(error);
  assert.equal(text, "cluster count (K) must be 20 or less");
  assert.doesNotMatch(text, /[{}[\]"]/);
  assert.doesNotMatch(text, /json/i);
});

// -------------------------------------------------------------- api client

test("ApiClient builds URLs from a normalized base", async () => {
  const { calls, fetchImpl } = recordingFetch({ ok: true });
  const api = new ApiClient({ base: "http://localhost:8000/", fetchImpl });
  await api.health();
  assert.equal(calls[0].url, "http://localhost:8000/health");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
});

test("createSession posts to /sessions without a body", async () => {
  const { calls, fetchImpl } = recordingFetch({ session_id: "s1", ttl_minutes: 60, max_images: 6 });
  const api = new ApiClient({ fetchImpl });
  const session = await api.createSession();
  assert.equal(session.session_id, "s1");
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/sessions`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, undefined);
});

test("runOperation sends a JSON body only when parameters exist", async () => {
  const { calls, fetchImpl } = recordingFetch({ image_id: "img2" });
  const api = new ApiClient({ fetchImpl });

  await api.runOperation("s1", "img1", "grayscale");
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/sessions/s1/images/img1/operations/grayscale`);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers["Content-Type"], undefined);

  await api.runOperation("s1", "img1", "brightness", { value: 40 });
  assert.deepEqual(parseBody(calls[1].init), { value: 40 });
  assert.equal(calls[1].init.headers["Content-Type"], "application/json");

  await api.runOperation("s1", "img1", "meanfilter", { window: 3 });
  assert.deepEqual(parseBody(calls[2].init), { window: 3 });
});

test("kmeans sends {k, max_iter}", async () => {
  const { calls, fetchImpl } = recordingFetch({ k: 5 });
  const api = new ApiClient({ fetchImpl });
  await api.kmeans("s1", "img1", { k: 5, maxIter: 30 });
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/sessions/s1/images/img1/kmeans`);
  assert.deepEqual(parseBody(calls[0].init), { k: 5, max_iter: 30 });
});

test("classify sends ranges and assignments", async () => {
  const { calls, fetchImpl } = recordingFetch({ image_id: "img9", legend: [] });
  const api = new ApiClient({ fetchImpl });
  const ranges = { 0: [0, 80], 1: [81, 255] };
  const assignments = { 0: { name: "Shadows", color: [0, 0, 0] }, 1: { name: "Light", color: [255, 255, 255] } };
  await api.classify("s1", "img1", { ranges, assignments });
  assert.deepEqual(parseBody(calls[0].init), { ranges, assignments });
});

test("satelliteFetch omits empty dates and includes chosen ones", async () => {
  const { calls, fetchImpl } = recordingFetch({ image_id: "sat1" });
  const api = new ApiClient({ fetchImpl });

  await api.satelliteFetch({ sessionId: "s1", location: "F-8" });
  assert.deepEqual(parseBody(calls[0].init), { session_id: "s1", location: "F-8" });
  assert.equal("start" in parseBody(calls[0].init), false);
  assert.equal("end" in parseBody(calls[0].init), false);

  await api.satelliteFetch({ sessionId: "s1", location: "F-8", start: "2026-08-01", end: "2026-10-02" });
  assert.deepEqual(parseBody(calls[1].init), {
    session_id: "s1",
    location: "F-8",
    start: "2026-08-01",
    end: "2026-10-02",
  });
});

test("satelliteFetch sends corner mode, refresh and no blank placeholders", async () => {
  const { calls, fetchImpl } = recordingFetch({ image_id: "sat1" });
  const api = new ApiClient({ fetchImpl });
  const wire = () => parseBody(calls[calls.length - 1].init);

  await api.satelliteFetch({ sessionId: "s1", mode: "bbox", corner1: "33.70, 73.05", corner2: "33.66, 73.10" });
  assert.deepEqual(wire(), { session_id: "s1", mode: "bbox", corner1: "33.70, 73.05", corner2: "33.66, 73.10" });
  assert.equal("size_km" in wire(), false, "corner mode does not send the place size box");

  await api.satelliteFetch({
    sessionId: "s1", mode: "bbox", corner1: "33.70, 73.05", corner2: null, sizeKm: 2, refresh: true,
  });
  assert.deepEqual(wire(), { session_id: "s1", mode: "bbox", corner1: "33.70, 73.05", refresh: true });

  await api.satelliteFetch({ sessionId: "s1", mode: "place", location: "Karachi", sizeKm: 5, refresh: true });
  assert.deepEqual(wire(), { session_id: "s1", location: "Karachi", size_km: 5, refresh: true });
  assert.equal("mode" in wire(), false, "the default place mode stays off the wire");
});

test("uploadImage sends multipart FormData", async () => {
  const { calls, fetchImpl } = recordingFetch({ image_id: "img1" });
  const api = new ApiClient({ fetchImpl });
  const file = new File([new Uint8Array([1, 2, 3])], "sample.jpg", { type: "image/jpeg" });
  await api.uploadImage("s1", file, "sample.jpg");
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/sessions/s1/images`);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("file").name, "sample.jpg");
  assert.equal(calls[0].init.headers["Content-Type"], undefined, "boundary must be browser-set");
});

test("downloadImage returns a blob and uses the format query", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, blob: async () => new Blob(["png-bytes"]), json: async () => ({}) };
  };
  const api = new ApiClient({ fetchImpl });
  const blob = await api.downloadImage("s1", "img1", "jpeg");
  assert.equal(blob.size, "png-bytes".length);
  assert.match(calls[0].url, /\/sessions\/s1\/images\/img1\?format=jpeg$/);
});

test("request throws ApiError with the API detail (string and list)", async () => {
  const failing = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ detail: [{ loc: ["body", "k"], msg: "too big" }] }),
    text: async () => "",
  });
  const api = new ApiClient({ fetchImpl: failing });
  await assert.rejects(
    () => api.kmeans("s1", "img1", { k: 99 }),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.match(humanizeError(error), /cluster count \(K\) too big/);
      return true;
    },
  );
});

test("request maps a transport failure to ApiError(0)", async () => {
  const failing = async () => {
    throw new TypeError("Failed to fetch");
  };
  const api = new ApiClient({ fetchImpl: failing });
  await assert.rejects(
    () => api.health(),
    (error) => {
      assert.equal(error.status, 0);
      assert.equal(error.isNetwork, true);
      return true;
    },
  );
});

// ------------------------------------------------------------ chat commands

test("defaultParamsFor returns the documented defaults", () => {
  assert.deepEqual(defaultParamsFor("kmeans"), { k: 5, max_iter: 30 });
  assert.deepEqual(defaultParamsFor("meanfilter"), { window: 3 });
  assert.deepEqual(defaultParamsFor("threshold"), { value: 128 });
  assert.deepEqual(defaultParamsFor("brightness"), { value: 20 });
  assert.equal(defaultParamsFor("negative"), null);
  assert.equal(defaultParamsFor("grayscale"), null);
  assert.equal(defaultParamsFor("nonsense"), null);
});

test("defaultParamsFor hands out copies, not shared state", () => {
  const first = defaultParamsFor("kmeans");
  first.k = 99;
  assert.deepEqual(defaultParamsFor("kmeans"), { k: 5, max_iter: 30 });
});

test("describeCommand covers every router action", () => {
  assert.match(describeCommand({ action: "run_operation", operation: "kmeans" }), /run kmeans \(defaults: \{"k":5,"max_iter":30\}\)/);
  assert.equal(describeCommand({ action: "run_operation", operation: "negative" }), "run negative");
  assert.equal(describeCommand({ action: "open_histogram" }), "open the histogram");
  assert.equal(describeCommand({ action: "open_compress" }), "compress the current image to .gch");
  assert.equal(describeCommand({ action: "open_distance" }), "open the distance tool");
  assert.equal(describeCommand({ action: "fetch_satellite", location: "F-8" }), "fetch satellite imagery for F-8");
  assert.match(describeCommand({ action: "mystery" }), /unknown action/);
  assert.match(describeCommand({}), /unknown action/);
});

test("executeCommands dispatches every action exactly once", async () => {
  const calls = [];
  const handlers = {
    runOperation: async (operation, params) => calls.push(["run", operation, params]),
    openHistogram: async () => calls.push(["histogram"]),
    openCompress: async () => calls.push(["compress"]),
    openDistance: async () => calls.push(["distance"]),
    fetchSatellite: async (location) => calls.push(["satellite", location]),
  };
  const notes = await executeCommands(
    [
      { action: "fetch_satellite", location: "F-8" },
      { action: "run_operation", operation: "kmeans" },
      { action: "run_operation", operation: "negative" },
      { action: "open_histogram" },
      { action: "open_compress" },
      { action: "open_distance" },
    ],
    handlers,
  );

  assert.deepEqual(calls, [
    ["satellite", "F-8"],
    ["run", "kmeans", { k: 5, max_iter: 30 }],
    ["run", "negative", null],
    ["histogram"],
    ["compress"],
    ["distance"],
  ]);
  assert.equal(notes.length, 6);
  assert.match(notes[0], /Satellite fetch requested for F-8/);
  assert.match(notes[1], /Ran kmeans with \{"k":5,"max_iter":30\}/);
  assert.match(notes[2], /Ran negative/);
});

test("executeCommands never throws: failures and unknown actions become notes", async () => {
  const notes = await executeCommands(
    [{ action: "fetch_satellite", location: "atlantis" }, { action: "teleport" }],
    {
      fetchSatellite: async () => {
        throw new Error("Unknown location: atlantis");
      },
      describeError: (error) => error.message,
    },
  );
  assert.match(notes[0], /failed: Unknown location: atlantis/);
  assert.match(notes[1], /Nothing handles "teleport" yet/);
});

test("executeCommands tolerates missing/empty command lists and handlers", async () => {
  assert.deepEqual(await executeCommands([], {}), []);
  assert.deepEqual(await executeCommands(undefined, {}), []);
  const notes = await executeCommands([{ action: "open_histogram" }], {});
  assert.deepEqual(notes, ["Histogram ready."]);
});

test("chat posts the message", async () => {
  const { calls, fetchImpl } = recordingFetch({ intent: "ask_question", reply: "hi", commands: [] });
  const api = new ApiClient({ fetchImpl });
  const response = await api.chat("what is NDVI?");
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/ai/chat`);
  assert.deepEqual(parseBody(calls[0].init), { message: "what is NDVI?" });
  assert.equal(response.reply, "hi");
});

// ------------------------------------------- STEP 1: operation params + 422s

test("describeOperation names what was applied", () => {
  assert.equal(describeOperation("grayscale"), "Grayscale");
  assert.equal(describeOperation("brightness", { value: 40 }), "Brightness +40");
  assert.equal(describeOperation("brightness", { value: -30 }), "Brightness -30");
  assert.equal(describeOperation("threshold", { value: 128 }), "Threshold 128");
  assert.equal(describeOperation("meanfilter", { window: 3 }), "Mean filter w=3");
  assert.equal(describeOperation("brightness"), "Brightness");
});

test("the operations that require a body are the ones the API requires", () => {
  assert.deepEqual([...OPERATIONS_WITH_PARAMS], ["brightness", "threshold", "meanfilter"]);
});

test("validationToText names the field for list details", () => {
  assert.equal(
    validationToText([{ loc: ["body", "value"], msg: "Input should be less than or equal to 255" }]),
    "value must be 255 or less",
  );
  assert.equal(
    validationToText([{ loc: ["body", "window"], msg: "window must be an odd number" }], { operation: "meanfilter" }),
    "window size must be an odd number",
  );
  assert.equal(
    validationToText([{ loc: ["body", "k"], msg: "Field required" }], { operation: "kmeans" }),
    "cluster count (K) is required",
  );
  assert.equal(
    validationToText([
      { loc: ["body", "value"], msg: "Input should be less than or equal to 255" },
      { loc: ["body", "window"], msg: "window must be an odd number" },
    ]),
    "value must be 255 or less; window size must be an odd number",
  );
});

test("the API's missing-body message becomes a sentence naming the field", () => {
  const text = validationToText("Operation 'brightness' requires a JSON body matching BrightnessRequest.",
    { operation: "brightness" });
  assert.equal(text, "Brightness needs a whole number from \u2212255 to 255, but none was sent.");
  assert.ok(!/json/i.test(text), "never says JSON");
});

test("parameterless operations are described as such", () => {
  assert.equal(validationToText("Operation 'grayscale' takes no parameters.", { operation: "grayscale" }),
    "Grayscale does not take any parameters.");
});

test("no 422 message ever leaks raw JSON", () => {
  const samples = [
    [{ loc: ["body", "value"], msg: "Input should be a valid integer" }],
    "Operation 'threshold' requires a JSON body matching ThresholdRequest.",
    { detail: "boom" },
    null,
    [{ loc: ["body", "value"], msg: "value: {\"detail\": \"x\"}" }],
  ];
  for (const sample of samples) {
    const text = validationToText(sample, { operation: "threshold" });
    assert.ok(!/\{/.test(text), `no braces in: ${text}`);
    assert.ok(!/json/i.test(text), `no JSON mention in: ${text}`);
  }
});

test("sanitizeMessage strips developer jargon", () => {
  assert.ok(!/json/i.test(sanitizeMessage("requires a JSON body matching MeanFilterRequest.")));
  assert.equal(sanitizeMessage('{"detail": "x"}'), "detail: x");
  assert.doesNotMatch(sanitizeMessage('{"detail": "x"}'), /[{}"]/);
});

test("humanizeError passes the operation through to the 422 mapper", () => {
  const error = new ApiError(422, [{ loc: ["body", "value"], msg: "Field required" }]);
  assert.equal(humanizeError(error, { operation: "brightness" }), "value is required");
});

// ------------------------------------------------------- STEP 3: image history

function fakeState(overrides = {}) {
  return { original: { id: "orig1", info: { image_id: "orig1" } }, result: null, ...overrides };
}

function fakeEntry(id, label = `step ${id}`) {
  return {
    label,
    role: "result",
    imageId: id,
    info: { image_id: id, width: 4, height: 4 },
    blob: { id },
    kmeans: null,
    snapshot: { original: { id: "orig1", info: null }, result: { id, info: null } },
  };
}

test("ImageHistory keeps at most 15 states and drops the oldest", () => {
  assert.equal(HISTORY_LIMIT, 15, "the documented limit is 15");
  const history = new ImageHistory();
  for (let i = 1; i <= 20; i += 1) history.record(fakeEntry(`img${i}`));
  assert.equal(history.size, 15);
  assert.equal(history.entries[0].imageId, "img6", "the five oldest states were dropped");
  assert.equal(history.current.imageId, "img20");
  assert.equal(history.summary, "15/15");
});

test("ImageHistory undo/redo walk the states and can be limited", () => {
  const history = new ImageHistory();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  history.record(fakeEntry("a"));
  history.record(fakeEntry("b"));
  history.record(fakeEntry("c"));
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo().imageId, "b");
  assert.equal(history.undo().imageId, "a");
  assert.equal(history.undo(), null, "undo stops at the oldest state");
  assert.equal(history.canUndo, false);
  assert.equal(history.redo().imageId, "b");
  assert.equal(history.redo().imageId, "c");
  assert.equal(history.redo(), null, "redo stops at the newest state");
});

test("recording after an undo discards the redo tail", () => {
  const history = new ImageHistory();
  history.record(fakeEntry("a"));
  history.record(fakeEntry("b"));
  history.undo();
  history.record(fakeEntry("c"));
  assert.deepEqual(history.entries.map((entry) => entry.imageId), ["a", "c"]);
  assert.equal(history.canRedo, false, "the stale redo branch is gone");
});

test("ImageHistory re-points every entry when an evicted image is re-uploaded", () => {
  const history = new ImageHistory();
  history.record(fakeEntry("old"));
  history.record(fakeEntry("new"));
  history.record({
    ...fakeEntry("newest"),
    snapshot: { original: { id: "old", info: null }, result: { id: "newest", info: null } },
  });
  history.rememberBlob("old", { id: "old-blob" });
  const replaced = [];
  history.onReplaced = (oldId, info) => replaced.push([oldId, info.image_id]);
  history.adopt("old", { image_id: "replacement" });
  assert.equal(history.entries[0].imageId, "replacement");
  assert.equal(history.entries[2].snapshot.original.id, "replacement");
  assert.equal(history.entries[1].imageId, "new", "unrelated entries are untouched");
  assert.deepEqual(replaced, [["old", "replacement"]]);
  assert.deepEqual(history.blobFor("replacement"), { id: "old-blob" }, "the Blob moved with the id");
  assert.equal(history.blobFor("old"), null);
});

test("Blobs are capped separately so history metadata survives", () => {
  const history = new ImageHistory({ blobLimit: 3 });
  for (const id of ["a", "b", "c", "d"]) {
    history.record(fakeEntry(id));
    history.rememberBlob(id, { id });
  }
  assert.equal(history.size, 4, "states are all still there");
  assert.equal(history.blobCount, 3);
  assert.equal(history.blobFor("a"), null, "the oldest Blob was released");
  assert.deepEqual(history.blobFor("d"), { id: "d" });
});

test("snapshotOf captures both viewport slots without the info payload shape", () => {
  const snapshot = snapshotOf(fakeState({ result: { id: "r1", info: { image_id: "r1" } } }));
  assert.deepEqual(snapshot, {
    original: { id: "orig1", info: { image_id: "orig1" } },
    result: { id: "r1", info: { image_id: "r1" } },
  });
  assert.deepEqual(snapshotOf({ original: null, result: null }), { original: null, result: null });
});

test("reset clears every state and Blob", () => {
  const history = new ImageHistory();
  history.record(fakeEntry("a"));
  history.rememberBlob("a", { id: "a" });
  history.reset();
  assert.equal(history.size, 0);
  assert.equal(history.canUndo, false);
  assert.equal(history.blobCount, 0);
});

// ------------------------------------------------- STEP 4: map composition

/** Canvas/document stub: enough for composeMap to lay out and draw. */
function fakeDocument() {
  const created = [];
  const canvasFor = () => {
    const canvas = { width: 0, height: 0, __texts: [], __fonts: [] };
    canvas.getContext = () => ({
      canvas,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      textBaseline: "",
      font: "",
      save() {}, restore() {},
      fillRect() {}, strokeRect() {}, clearRect() {},
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      drawImage(image) { canvas.__drawn = { width: image?.width, height: image?.height }; },
      measureText: (text) => ({ width: String(text).length * 7 }),
      fillText: (text, x, y) => {
        if (typeof text === "string") {
          canvas.__fonts.push({ text, font: undefined });
          canvas.__texts.push(text);
        }
        void x; void y;
      },
      __texts: [],
    });
    return canvas;
  };
  return {
    created,
    createElement(tag) {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      const canvas = canvasFor();
      created.push(canvas);
      return canvas;
    },
  };
}

const SAMPLE_LEGEND = [
  { cluster: 1, name: "Water", color: [64, 128, 255], min: 0, max: 85, count: 1200, percentage: 42.31 },
  { cluster: 2, name: "Vegetation", color: [60, 180, 90], min: 86, max: 170, count: 1100, percentage: 38.02 },
  { cluster: 3, name: "Built-up", color: [220, 180, 60], min: 171, max: 255, count: 560, percentage: 19.67 },
];

test("legendRows normalises the classify legend and survives junk", () => {
  const rows = legendRows(SAMPLE_LEGEND);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    cluster: 1, name: "Water", color: [64, 128, 255], percentage: 42.31, count: 1200, min: 0, max: 85,
  });
  const junk = legendRows([{ color: [300, -20, "x"], percentage: "nope", name: "" }]);
  assert.deepEqual(junk[0].color, [255, 0, 128], "colours are clamped and rounded");
  assert.equal(junk[0].percentage, 0, "a non-numeric percentage becomes 0");
  assert.equal(junk[0].name, "Cluster 1", "a missing name falls back to the cluster number");
  assert.deepEqual(legendRows(undefined), []);
});

test("formatPercentage keeps slivers readable and never prints '0%' for real data", () => {
  assert.equal(formatPercentage(42.31), "42.3%");
  assert.equal(formatPercentage(7.5), "7.50%");
  assert.equal(formatPercentage(0.04), "<0.1%");
  assert.equal(formatPercentage(0), "0%");
  assert.equal(formatPercentage(undefined), "—");
});

test("fitText ellipsises to the available width", () => {
  const ctx = { measureText: (text) => ({ width: text.length * 10 }) };
  assert.equal(fitText(ctx, "Water", 100), "Water");
  assert.equal(fitText(ctx, "Shadows, Dark Trees / Forest", 100), "Shadows,…");
  assert.equal(fitText(ctx, "", 100), "");
});

test("legendMetrics puts the panel right when there is room, below otherwise", () => {
  const big = legendMetrics(2449, 1632, 5);
  assert.equal(big.placeRight, true, "a 2449×1632 map takes the side panel");
  assert.ok(big.panelWidth >= 200 && big.panelWidth <= 420);
  const tile = legendMetrics(260, 260, 5);
  assert.equal(tile.placeRight, true, "a short legend fits beside a 260 px tile");
  const tileTall = legendMetrics(260, 260, 20);
  assert.equal(tileTall.placeRight, false,
    "a 20-class legend cannot fit beside a 260 px tile — it goes underneath");
  const wide = legendMetrics(1200, 180, 5);
  assert.equal(wide.placeRight, true, "a 1200×180 strip still fits the side panel");
  const letterbox = legendMetrics(1200, 80, 5);
  assert.equal(letterbox.placeRight, false, "a letterbox image puts the legend underneath");
});

test("drawLegend paints a swatch, the class name and the percentage per row", () => {
  const documentStub = fakeDocument();
  const canvas = documentStub.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const height = drawLegend(ctx, {
    x: 0, y: 0, width: 300, rows: legendRows(SAMPLE_LEGEND), title: "Legend — sample.jpg", unit: 14,
  });
  assert.equal(height, 29 + 3 * 27 + 20, "the panel is title + rows + padding");
  assert.ok(canvas.__texts.includes("Water") && canvas.__texts.includes("Vegetation"));
  assert.ok(canvas.__texts.includes("42.3%") && canvas.__texts.includes("19.7%"));
  assert.ok(canvas.__texts.includes("Legend — sample.jpg"));
});

test("composeMap composites the image and the legend into one canvas", () => {
  const documentStub = fakeDocument();
  const image = { width: 800, height: 600 };
  const result = composeMap({ image, legend: SAMPLE_LEGEND, title: "Legend — sample.jpg", documentRef: documentStub });
  assert.equal(result.legendShown, true);
  assert.ok(result.width > 800, `the canvas grew for the legend (${result.width})`);
  assert.equal(result.height, 600);
  assert.ok(result.legendBox.x >= 800, "the legend starts at/after where the image ends");
  assert.equal(result.width, 800 + result.legendBox.x - 800 + result.legendBox.width,
    "canvas width = image + gutter + legend panel");
  assert.equal(result.canvas.__drawn.width, 800);
  assert.equal(result.canvas.__drawn.height, 600);
  assert.ok(result.canvas.__texts.includes("Water"));
});

test("composeMap can leave the legend out (toggle off) without changing the image", () => {
  const documentStub = fakeDocument();
  const result = composeMap({
    image: { width: 800, height: 600 }, legend: SAMPLE_LEGEND, showLegend: false, documentRef: documentStub,
  });
  assert.equal(result.legendShown, false);
  assert.equal(result.width, 800, "no legend means the canvas matches the image");
  assert.equal(result.height, 600);
  assert.equal(result.legendBox, null);
  assert.equal(result.canvas.__texts.length, 0, "nothing is painted besides the image");
});

test("composeMap puts a tall legend under a small tile", () => {
  const documentStub = fakeDocument();
  const many = Array.from({ length: 20 }, (_value, index) => ({
    cluster: index + 1,
    name: `Class ${index + 1}`,
    color: [index * 10, 128, 200],
    percentage: 100 / 20,
  }));
  const result = composeMap({ image: { width: 260, height: 260 }, legend: many, documentRef: documentStub });
  assert.equal(result.width, 260, "the tile keeps its full width");
  assert.ok(result.height > 260, `the canvas grew downwards (${result.height})`);
  assert.equal(result.legendBox.y, 260, "the legend starts below the image");
  assert.equal(result.legendBox.width, 260, "the under-panel spans the canvas");
});

test("mapFileName derives a readable, safe filename", () => {
  assert.equal(mapFileName("sample.jpg"), "map-sample.png");
  assert.equal(mapFileName(""), "map-map.png");
  assert.equal(mapFileName("a b/c.tif"), "map-a-b-c.png");
});

// ------------------------------------- STEP 5: histogram options + distance

const BINS_SPIKE = [0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 64, 128, 64, 32, 16, 8, 4, 2, 1, 0];

test("smoothBins averages neighbouring bins and keeps the 256-bin length", () => {
  const bins = Array.from({ length: 256 }, () => 0);
  bins[128] = 100;
  const smoothed = smoothBins(bins, 5);
  assert.equal(smoothed.length, 256, "the bin count never changes");
  assert.equal(smoothed[128], 20, "the spike is spread over five bins (100/5)");
  assert.equal(smoothed[127], 20);
  assert.equal(smoothed[125], 0);
  assert.deepEqual(smoothBins(BINS_SPIKE, 0), BINS_SPIKE, "0 means no smoothing");
  assert.deepEqual(smoothBins(BINS_SPIKE, 1), BINS_SPIKE, "a 1-bin window is a no-op");
});

test("cumulativeBins ends at the total and never decreases", () => {
  const cumulative = cumulativeBins(BINS_SPIKE);
  assert.equal(cumulative.at(-1), BINS_SPIKE.reduce((sum, value) => sum + value, 0));
  assert.equal(cumulative.at(-1), 382);
  for (let i = 1; i < cumulative.length; i += 1) {
    assert.ok(cumulative[i] >= cumulative[i - 1], `monotonic at ${i}`);
  }
});

test("densityBins is a share of pixels, summing to 1", () => {
  const density = densityBins(BINS_SPIKE);
  const total = density.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sums to ${total}`);
  const total381 = BINS_SPIKE.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(density[11] - 128 / total381) < 1e-9);
  assert.deepEqual(densityBins([0, 0]), [0, 0], "an empty histogram cannot divide by zero");
});

test("prepareBins applies smoothing → cumulative → density → scale in that order", () => {
  const plain = prepareBins(BINS_SPIKE);
  assert.equal(plain.values.length, 20);
  assert.equal(plain.max, 128);
  assert.equal(plain.label, "linear scale");

  const smoothed = prepareBins(BINS_SPIKE, { smoothing: 3 });
  assert.ok(smoothed.values[11] < 128, "smoothing lowers the peak");

  const cumulative = prepareBins(BINS_SPIKE, { cumulative: true });
  assert.equal(cumulative.values.at(-1), BINS_SPIKE.reduce((sum, value) => sum + value, 0));

  const density = prepareBins(BINS_SPIKE, { density: true });
  assert.ok(Math.abs(density.values.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);

  const log = prepareBins(BINS_SPIKE, { scale: "log" });
  assert.ok(Math.abs(log.values[11] - Math.log10(129)) < 1e-9, "log scale is log10(count + 1)");
  assert.equal(log.max, Math.log10(129));

  const all = prepareBins(BINS_SPIKE, { scale: "log", smoothing: 5, cumulative: true, density: true });
  assert.equal(all.label, "log scale · smoothed 5 · cumulative · density");
  assert.ok(all.values.every((value) => value >= 0), "log of a share is never negative");

  assert.deepEqual(prepareBins([]), { values: [], max: 1, total: 0, label: "no data" });
});

test("describeOptions and axisLabels describe the current view", () => {
  assert.equal(describeOptions(), "linear scale");
  assert.equal(describeOptions({ scale: "log" }), "log scale");
  assert.equal(describeOptions({ scale: "linear", smoothing: 9, cumulative: true }), "linear scale · smoothed 9 · cumulative");
  assert.equal(axisLabels().y, "pixels");
  assert.equal(axisLabels({ cumulative: true }).y, "pixels ≤ intensity");
  assert.equal(axisLabels({ density: true }).y, "share of pixels");
  assert.equal(axisLabels().x, "intensity (0–255)");
  assert.deepEqual(SCALES, ["linear", "log"]);
  assert.deepEqual(SMOOTHING_WINDOWS, [0, 3, 5, 9]);
  assert.ok(THEMES.light.background !== THEMES.dark.background);
});

test("drawHistogram paints the chart, its title and both axes for every mode", () => {
  const canvas = { width: 520, height: 170, __texts: [] };
  const ctx = {
    canvas, fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    clearRect() { canvas.__texts = []; },
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    save() {}, restore() {}, translate() {}, rotate() {},
    measureText: (text) => ({ width: text.length * 6 }),
    fillText: (text) => canvas.__texts.push(String(text)),
  };
  const painted = (options) => {
    drawHistogram(ctx, { bins: BINS_SPIKE, width: 520, height: 170, title: "Histogram — x.png", ...options });
    return canvas.__texts.join(" | ");
  };
  assert.match(painted({}), /Histogram — x\.png/);
  assert.match(painted({}), /intensity \(0–255\)/);
  assert.match(painted({}), /pixels \|/);
  assert.match(painted({ scale: "log" }), /10\^/);
  assert.match(painted({ cumulative: true }), /pixels ≤ intensity/);
  assert.match(painted({ density: true }), /share of pixels/);
  assert.match(painted({ density: true }), /%/);
  assert.match(painted({ theme: "light" }), /Histogram — x\.png/, "the light theme still titles the chart");
  drawHistogram(ctx, { bins: [], width: 520, height: 170 });
  assert.ok(canvas.__texts.includes("no histogram yet"));
  assert.equal(histogramFileName("sample.jpg"), "histogram-sample.png");
});

test("distance conversion uses the calibration the user types in", () => {
  assert.deepEqual(convertPixels(250), { unit: "px", value: 250, basis: "image pixels" });
  assert.equal(convertPixels(250, { unit: "cm", pxPerUnit: 100 }).value, 2.5);
  assert.equal(convertPixels(250, { unit: "mm", pxPerUnit: 50 }).value, 5);
  assert.equal(convertPixels(250, { unit: "in", pxPerUnit: 96 }).value, 250 / 96);
  assert.equal(convertPixels(250, { unit: "cm" }), null, "no calibration means no conversion");
  assert.equal(convertPixels(250, { unit: "cm", pxPerUnit: 0 }), null, "0 px/unit is meaningless");
  assert.equal(convertPixels("nope", { unit: "cm", pxPerUnit: 10 }), null);
  assert.deepEqual(Object.keys(UNITS), ["px", "mm", "cm", "in"]);
  assert.equal(unitRateLabel("cm"), "px/cm");
  assert.equal(unitRateLabel("px"), "");
  assert.equal(formatMeasurement(250), "250.00");
  assert.equal(formatMeasurement(2.5), "2.50");
  assert.equal(formatMeasurement(0.0042), "0.0042");
  assert.equal(formatMeasurement(undefined), "—");
});

test("describeDistance labels the screen value and the original resolution", () => {
  const plain = describeDistance({ pixels: 500 });
  assert.equal(plain.primary, "500.00 px");
  assert.equal(plain.downscaled, false);
  assert.match(plain.lines.join(" "), /on screen/);
  assert.match(plain.lines.join(" "), /was not downscaled on upload/);

  const downscaled = describeDistance({
    pixels: 500, unit: "cm", pxPerUnit: 100, scale: 0.5,
    info: { original_width: 4000, original_height: 3000 },
  });
  assert.equal(downscaled.primary, "5.00 cm");
  assert.equal(downscaled.originalPixels, 1000, "original pixels = pixels / scale");
  assert.equal(downscaled.original.text, "10.00 cm");
  assert.match(downscaled.lines[0], /5\.00 cm on screen \(100 px\/cm\)/);
  assert.match(downscaled.lines[1], /10\.00 cm at the original 4000×3000 px \(upload downscaled ×0\.5\)/);

  const originalPx = describeDistance({ pixels: 500, scale: 0.25 });
  assert.equal(originalPx.primary, "500.00 px");
  assert.equal(originalPx.originalPixels, 2000);
  assert.match(originalPx.lines[1], /2,000\.00 px at the original resolution/);

  const uncalibrated = describeDistance({ pixels: 500, unit: "mm" });
  assert.equal(uncalibrated.ok, false);
  assert.equal(uncalibrated.reason, "missing-calibration");
  assert.match(uncalibrated.lines[0], /set pixels per unit to convert to millimetres/);
});

// ───────────────────────── STEP 3: preview maths + slider helpers ───────────

test("reflect101 mirrors like OpenCV's default border", () => {
  // gfedcb|abcdefgh|gfedcba
  assert.deepEqual([-1, -2, -3, 0, 3, 4, 5].map((i) => reflect101(i, 4)), [1, 2, 3, 0, 3, 2, 1]);
  assert.equal(reflect101(0, 1), 0, "a 1-pixel axis cannot reflect");
  assert.equal(reflect101(100, 4), 2, "the pattern repeats every 2·size−2 = 6");
});

test("brightness preview clips exactly like np.clip", () => {
  const pixels = new Uint8ClampedArray([0, 10, 200, 255, 5, 100, 250, 20]);
  applyBrightness(pixels, 100);
  assert.deepEqual([...pixels], [100, 110, 255, 255, 105, 200, 255, 20]);
  applyBrightness(pixels, -200);
  assert.deepEqual([...pixels], [0, 0, 55, 255, 0, 0, 55, 20]);
  assert.deepEqual([pixels[3], pixels[7]], [255, 20], "alpha is never shifted");
});

test("threshold preview is per-channel and strictly greater-than", () => {
  const pixels = new Uint8ClampedArray([0, 128, 129, 255, 127, 128, 200, 10]);
  applyThreshold(pixels, 128);
  assert.deepEqual([...pixels], [0, 0, 255, 255, 0, 0, 255, 10]);
  assert.equal(pixels[7], 10, "alpha is never thresholded");
});

test("mean filter preview matches a brute-force box average with reflect-101", () => {
  const width = 5;
  const height = 4;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    source[offset] = (index * 13) % 256;
    source[offset + 1] = (index * 29) % 256;
    source[offset + 2] = (index * 7 + 3) % 256;
    source[offset + 3] = (index * 11) % 256;
  }
  const window = 3;
  const radius = 1;

  // independent reference: average every reflected neighbour, round half up
  // (alpha is copied through, like the API keeps it)
  const reference = new Uint8ClampedArray(source);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) { // alpha is not filtered
        let sum = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            const ny = reflect101(y + dy, height);
            const nx = reflect101(x + dx, width);
            sum += source[(ny * width + nx) * 4 + channel];
          }
        }
        reference[(y * width + x) * 4 + channel] = Math.round(sum / (window * window));
      }
    }
  }

  const result = new Uint8ClampedArray(source);
  applyMeanFilter(result, width, height, window);
  // OpenCV's 8-bit path uses a fixed-point reciprocal per pass, so a preview
  // can differ by one grey level; anything larger would be a real bug
  for (let index = 0; index < reference.length; index += 1) {
    if (index % 4 === 3) {
      assert.equal(result[index], reference[index], `alpha survives at ${index}`);
      continue;
    }
    assert.ok(Math.abs(result[index] - reference[index]) <= 1,
      `pixel ${index}: ${result[index]} vs ${reference[index]}`);
  }

  // a constant image must average back to exactly that constant
  const flat = new Uint8ClampedArray(width * height * 4).fill(90);
  applyMeanFilter(flat, width, height, 3);
  assert.deepEqual([...flat], new Array(width * height * 4).fill(90));

  // a 5×5 window still behaves, and an even window is refused by the API anyway
  const big = new Uint8ClampedArray(source);
  applyMeanFilter(big, width, height, 5);
  assert.equal(big.length, source.length);
  const even = new Uint8ClampedArray(source);
  applyMeanFilter(even, width, height, 4);
  assert.deepEqual([...even], [...source], "an even window is ignored");
});

test("applyPixels dispatches the three slider operations", () => {
  const pixels = new Uint8ClampedArray([10, 20, 30, 255]);
  applyPixels(pixels, 1, 1, "brightness", { value: 5 });
  assert.deepEqual([...pixels], [15, 25, 35, 255]);
  applyPixels(pixels, 1, 1, "threshold", { value: 30 });
  assert.deepEqual([...pixels], [0, 0, 255, 255]);
  assert.equal(pixels[3], 255, "alpha is preserved");
  const mean = new Uint8ClampedArray([0, 0, 0, 7, 255, 255, 255, 9, 0, 0, 0, 11, 255, 255, 255, 13]);
  applyPixels(mean, 2, 2, "meanfilter", { window: 3 });
  assert.equal(mean[0], 170, "a 2×2 checkerboard with reflect-101 averages to 170");
  assert.deepEqual([mean[3], mean[7], mean[11], mean[15]], [7, 9, 11, 13], "alpha survives the blur");
});

test("preview copies are capped at PREVIEW_MAX_SIDE without changing the ratio", () => {
  assert.deepEqual(previewSize(2000, 1000), { width: 512, height: 256, scale: 0.256 });
  assert.deepEqual(previewSize(260, 260), { width: 260, height: 260, scale: 1 });
  assert.deepEqual(previewSize(500, 4096), { width: 63, height: 512, scale: 0.125 });
  assert.equal(PREVIEW_MAX_SIDE, 512);
});

test("slider values snap to the documented ranges", () => {
  assert.equal(snapSliderValue("brightness", 300), 255);
  assert.equal(snapSliderValue("brightness", -900), -255);
  assert.equal(snapSliderValue("threshold", 128.4), 128);
  assert.equal(snapSliderValue("meanfilter", 3), 3);
  assert.equal(snapSliderValue("meanfilter", 4), 5, "even kernels snap up to the next odd size");
  assert.equal(snapSliderValue("meanfilter", 31), 31);
  assert.equal(snapSliderValue("meanfilter", 30), 31);
  assert.equal(snapSliderValue("meanfilter", 99), 31, "the cap is 31, and it stays odd");
  assert.equal(snapSliderValue("grayscale", 1), null, "point operations have no slider");
  assert.deepEqual(paramsForValue("brightness", -30), { value: -30 });
  assert.deepEqual(paramsForValue("threshold", 200), { value: 200 });
  assert.deepEqual(paramsForValue("meanfilter", 5), { window: 5 });
  assert.equal(paramsForValue("negative", 5), null);
});

test("the eight help texts are the verbatim strings from the brief", () => {
  assert.deepEqual(Object.keys(HELP_TEXTS).sort(),
    ["brightness", "clear", "filters", "grayscale", "laplacian", "meanfilter", "negative", "threshold"]);
  assert.equal(HELP_TEXTS.filters,
    "Each filter is applied to the latest result, so filters can be combined. Use Undo to step back.");
  assert.equal(HELP_TEXTS.grayscale,
    "Converts the image to a single-band grayscale image using a luminance-weighted combination of the color channels.");
  assert.equal(HELP_TEXTS.negative, "Inverts pixel values to produce a photographic negative.");
  assert.equal(HELP_TEXTS.laplacian,
    "Edge detection filter that highlights areas of rapid intensity change, such as boundaries and fine detail.");
  assert.equal(HELP_TEXTS.brightness,
    "Shifts all pixel values by a constant amount from -255 to 255. Positive values brighten the image and negative values darken it. Results are limited to the valid 0 to 255 range.");
  assert.equal(HELP_TEXTS.threshold,
    "Each color value (red, green, blue) above the threshold is set to its maximum, and all others are set to zero.");
  assert.equal(HELP_TEXTS.meanfilter, "Smooths the image by averaging neighboring pixels.");
  assert.equal(HELP_TEXTS.clear,
    "Clears the result viewport. The original image and the undo history are not affected.");
  assert.equal(SLIDER_SPECS.meanfilter.label, "Kernel size");
  assert.equal(SLIDER_SPECS.meanfilter.choice(5), "5 x 5");
  assert.ok(KEY_COMMIT_DELAY > 0 && KEY_COMMIT_DELAY <= 1000, "the key pause is short");
});

test("the four point operations share one grouped help entry list", () => {
  assert.equal(POINT_OPERATION_HELP.length, 4, "the grouped popover lists four entries");
  assert.deepEqual(POINT_OPERATION_HELP.map(([name]) => name),
    ["Grayscale", "Negative", "Laplacian", "Clear result"]);
  assert.deepEqual(POINT_OPERATION_HELP.map(([, text]) => text), [
    "Converts the image to a single-band grayscale image using a luminance-weighted combination of the color channels.",
    "Inverts pixel values to produce a photographic negative.",
    "Edge detection filter that highlights areas of rapid intensity change, such as boundaries and fine detail.",
    "Clears the result viewport. The original image and the undo history are not affected.",
  ]);
  // each entry reuses the single source of truth for its text
  assert.deepEqual(POINT_OPERATION_HELP.map(([, text]) => text),
    [HELP_TEXTS.grayscale, HELP_TEXTS.negative, HELP_TEXTS.laplacian, HELP_TEXTS.clear]);
});

test("ui.helpList builds bold names from DOM nodes and never markup", async () => {
  const { helpList } = await import("../js/ui.js");
  const source = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  assert.match(source, /export function helpList\(entries\)/, "helpList is exported");
  // the only mention is the guard that rejects markup, never an assignment
  assert.equal(/innerHTML\s*=/.test(source), false, "ui.js never assigns innerHTML");
  assert.equal(typeof helpList, "function");
  // it needs a DOM to run in; the boot test exercises the rendered list
});

test("dropEntry removes one step and keeps the pointer on the same entry", () => {
  const history = new ImageHistory({ limit: 10 });
  for (const id of ["a", "b", "c"]) history.record({ label: id, role: "result", imageId: id, info: { image_id: id } });
  assert.equal(history.size, 3);
  assert.equal(history.summary, "3/3");

  assert.equal(history.dropEntry("c"), true);
  assert.equal(history.size, 2);
  assert.equal(history.summary, "2/2", "dropping the newest step leaves the pointer on the new newest");
  assert.equal(history.current.label, "b");

  assert.equal(history.dropEntry("a"), true);
  assert.equal(history.size, 1);
  assert.equal(history.canUndo, false, "the first step cannot be undone any more");
  assert.equal(history.dropEntry("missing"), false);
  assert.equal(history.size, 1);

  history.record({ label: "d", role: "result", imageId: "d", info: { image_id: "d" } });
  assert.equal(history.size, 2);
  assert.equal(history.entries[history.pointer].label, "d");
});
