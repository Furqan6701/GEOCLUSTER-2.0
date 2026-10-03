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
/**
 * Same-origin path used when the page is NOT served from the dev machine
 * (hosted preview, LAN, reverse proxy). serve.py forwards /api/* to the
 * backend, so the browser never has to reach a second localhost port.
 */
export const PROXY_API_BASE = "/api";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

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
 * Resolve the API base URL from (in order):
 *   1. ?api= query string (an http(s) URL or a same-origin path like /api),
 *   2. localStorage["geocluster.apiBase"],
 *   3. the page's hostname — a local dev machine talks to
 *      http://localhost:8000 directly, anything else (hosted preview, LAN,
 *      reverse proxy) uses the same-origin /api path that serve.py forwards
 *      to the backend. Browsers must never call localhost for a service that
 *      runs on the server, not on the user's machine.
 */
export function resolveApiBase({ search = "", storage = null, hostname = null } = {}) {
  const fromQuery = readQueryBase(search);
  if (fromQuery) return fromQuery;
  const fromStorage = readStoredBase(storage);
  if (fromStorage) return fromStorage;
  const host = hostname == null ? "localhost" : String(hostname).trim().toLowerCase();
  return LOCAL_HOSTS.has(host) ? DEFAULT_API_BASE : PROXY_API_BASE;
}

/** An absolute http(s) URL or a same-origin path ("/api"); not "//evil.example". */
export function isUsableApiBase(value) {
  const candidate = normalizeBase(value);
  if (!candidate) return false;
  if (candidate.startsWith("/")) return !candidate.startsWith("//");
  return isValidHttpUrl(candidate);
}

function readQueryBase(search) {
  try {
    const params = new URLSearchParams(String(search ?? "").replace(/^\?/, ""));
    const candidate = normalizeBase(params.get("api"));
    return isUsableApiBase(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

function readStoredBase(storage) {
  try {
    const candidate = normalizeBase(storage ? storage.getItem(API_BASE_STORAGE_KEY) : "");
    return isUsableApiBase(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

/** Small helper used by the status chips and hints. */
export function webOriginHint(port = DEFAULT_PORT) {
  return `http://localhost:${port}`;
}
