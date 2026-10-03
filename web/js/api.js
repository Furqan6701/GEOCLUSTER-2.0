/**
 * Thin API client for the GeoCluster backend (see api/README.md).
 *
 * Every method maps 1:1 to an endpoint and throws `ApiError` on failure, so
 * the UI can map errors to friendly text in one place (js/errors.js).
 */

import { ApiError } from "./errors.js";
import { DEFAULT_API_BASE, normalizeBase } from "./config.js";

export class ApiClient {
  constructor({ base = DEFAULT_API_BASE, fetchImpl = null } = {}) {
    this.base = normalizeBase(base);
    this.fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  url(path) {
    return `${this.base}${path}`;
  }

  async request(path, { method = "GET", json, form, responseType = "json" } = {}) {
    const target = this.url(path);
    const init = { method, headers: {} };
    if (json !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    if (form !== undefined) {
      init.body = form; // FormData: let the browser set the boundary
    }

    let response;
    try {
      response = await this.fetchImpl(target, init);
    } catch (cause) {
      throw new ApiError(0, "network", { url: target, method, cause });
    }

    if (!response.ok) {
      const detail = await readDetail(response);
      throw new ApiError(response.status, detail, { url: target, method });
    }

    if (responseType === "blob") return response.blob();
    if (responseType === "text") return response.text();
    if (responseType === "none") return null;
    if (response.status === 204) return null;
    return response.json();
  }

  // --------------------------------------------------------------- session
  health() {
    return this.request("/health");
  }

  createSession() {
    return this.request("/sessions", { method: "POST" });
  }

  // ---------------------------------------------------------------- images
  uploadImage(sessionId, blob, filename = "upload.png") {
    const form = new FormData();
    form.append("file", blob, filename);
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/images`, { method: "POST", form });
  }

  downloadImage(sessionId, imageId, format = "png") {
    const query = new URLSearchParams({ format });
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}?${query}`,
      { responseType: "blob" },
    );
  }

  // ------------------------------------------------------------ operations
  runOperation(sessionId, imageId, operation, params = null) {
    const path = `/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}/operations/${encodeURIComponent(operation)}`;
    // Parameterless operations must not send a body: the API rejects extras.
    return this.request(path, { method: "POST", json: params ?? undefined });
  }

  kmeans(sessionId, imageId, { k, maxIter = 30 } = {}) {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}/kmeans`,
      { method: "POST", json: { k, max_iter: maxIter } },
    );
  }

  classify(sessionId, imageId, { ranges, assignments }) {
    return this.request(
      `/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}/classify`,
      { method: "POST", json: { ranges, assignments } },
    );
  }

  histogram(sessionId, imageId) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}/histogram`);
  }

  stats(sessionId, imageId) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}/stats`);
  }

  // -------------------------------------------------------------- huffman
  huffmanCompress(blob, filename = "image.png") {
    const form = new FormData();
    form.append("file", blob, filename);
    return this.request("/huffman/compress", { method: "POST", form, responseType: "blob" });
  }

  huffmanDecompress(blob, filename = "image.gch") {
    const form = new FormData();
    form.append("file", blob, filename);
    return this.request("/huffman/decompress", { method: "POST", form, responseType: "blob" });
  }

  // ------------------------------------------------------------- satellite
  locations() {
    return this.request("/locations");
  }

  /**
   * Fetch a Sentinel-2 crop.
   *
   * Place mode sends the place text (a sector code, an alias or a place name)
   * plus the requested square size; corner mode sends the two pasted corners.
   * Optional values are only added when the user actually supplied them — a
   * placeholder date or a blank corner must never reach the API.
   */
  satelliteFetch({
    sessionId,
    location = null,
    start = null,
    end = null,
    mode = "place",
    sizeKm = null,
    corner1 = null,
    corner2 = null,
    refresh = false,
  }) {
    // "place" is the server-side default, so it is only sent when it differs;
    // empty fields are omitted rather than sent as blank placeholders.
    const body = { session_id: sessionId };
    if (mode === "bbox") {
      body.mode = "bbox";
      if (corner1) body.corner1 = corner1;
      if (corner2) body.corner2 = corner2;
    } else if (location) {
      body.location = location;
    }
    if (mode !== "bbox" && sizeKm != null && sizeKm !== "") body.size_km = Number(sizeKm);
    if (refresh) body.refresh = true;
    // Dates are optional: only send them when the user actually chose them.
    if (start) body.start = start;
    if (end) body.end = end;
    return this.request("/satellite/fetch", { method: "POST", json: body });
  }

  // ------------------------------------------------------------------ chat
  chat(message) {
    return this.request("/ai/chat", { method: "POST", json: { message } });
  }
}

async function readDetail(response) {
  try {
    const data = await response.json();
    return data && typeof data === "object" && "detail" in data ? data.detail : data;
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}
