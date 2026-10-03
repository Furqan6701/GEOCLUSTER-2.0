/**
 * Logic tests for the DOM-free frontend modules.
 *
 * Run:  node --test web/tests/     (from the repository root)
 *       node --test tests/         (from web/)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_API_BASE, isValidHttpUrl, normalizeBase, resolveApiBase } from "../js/config.js";
import { ApiError, detailToText, humanizeError } from "../js/errors.js";
import { ApiClient } from "../js/api.js";

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
    "value: Input should be less than or equal to 255; window: window must be an odd number",
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
  assert.match(text, /Please check these values/);
  assert.match(text, /k: Input should be less than or equal to 20/);
  assert.doesNotMatch(text, /[{}[\]"]/);
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
      assert.match(humanizeError(error), /k: too big/);
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

test("chat posts the message", async () => {
  const { calls, fetchImpl } = recordingFetch({ intent: "ask_question", reply: "hi", commands: [] });
  const api = new ApiClient({ fetchImpl });
  const response = await api.chat("what is NDVI?");
  assert.equal(calls[0].url, `${DEFAULT_API_BASE}/ai/chat`);
  assert.deepEqual(parseBody(calls[0].init), { message: "what is NDVI?" });
  assert.equal(response.reply, "hi");
});
