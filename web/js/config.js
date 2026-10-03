/**
 * Frontend configuration.
 *
 * The API runs at http://localhost:8000 by default (see api/README.md).
 * Override the address without editing code:
 *   - query string:  http://localhost:5173/?api=http://127.0.0.1:8000
 *   - localStorage:  localStorage.setItem("geocluster.apiBase", "http://127.0.0.1:8000")
 *
 * The page MUST be served over http(s) (not file://) so the browser sends a
 * real Origin header that the API's ALLOWED_ORIGINS accepts.
 */

export const DEFAULT_API_BASE = "http://localhost:8000";
export const API_BASE_STORAGE_KEY = "geocluster.apiBase";
export const DEFAULT_PORT = 5173;

/** Strip trailing slashes so paths can be concatenated safely. */
export function normalizeBase(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

/** True for http(s) URLs we can actually call. */
export function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve the API base URL from (in order): ?api= query, localStorage, default.
 * Returns the default when a candidate is missing or not a usable http(s) URL.
 */
export function resolveApiBase({ search = "", storage = null } = {}) {
  const fromQuery = readQueryBase(search);
  if (fromQuery) return fromQuery;
  const fromStorage = readStoredBase(storage);
  if (fromStorage) return fromStorage;
  return DEFAULT_API_BASE;
}

function readQueryBase(search) {
  try {
    const params = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
    const candidate = normalizeBase(params.get("api"));
    return isValidHttpUrl(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

function readStoredBase(storage) {
  try {
    const candidate = normalizeBase(storage ? storage.getItem(API_BASE_STORAGE_KEY) : "");
    return isValidHttpUrl(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

/** Small helper used by the status chips and hints. */
export function webOriginHint(port = DEFAULT_PORT) {
  return `http://localhost:${port}`;
}
