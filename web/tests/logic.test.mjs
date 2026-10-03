/**
 * Logic tests for the DOM-free frontend modules.
 *
 * Run:  node --test web/tests/     (from the repository root)
 *       node --test tests/         (from web/)
 */

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
import { OPERATIONS_WITH_PARAMS, describeOperation } from "../js/panels/operations.js";
import { ApiClient } from "../js/api.js";
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
