/**
 * Error handling: turn anything the API (or the network) throws into text a
 * human can act on. Raw JSON is never shown in the UI.
 *
 * Error bodies from the API look like {"detail": "..."}. For 422 responses the
 * detail is usually a list of {loc, msg, type} entries.
 */

/** Human names for the parameters the operations endpoints accept. */
const FIELD_NAMES = Object.freeze({
  value: "value",
  window: "window size",
  k: "cluster count (K)",
  max_iter: "max iterations",
  ranges: "cluster ranges",
  assignments: "cluster names and colours",
  name: "cluster name",
  color: "cluster colour",
  message: "message",
});

const OPERATION_LABELS = Object.freeze({
  grayscale: "Grayscale",
  negative: "Negative",
  laplacian: "Laplacian",
  brightness: "Brightness",
  threshold: "Threshold",
  meanfilter: "Mean filter",
  kmeans: "K-Means",
  classify: "Classify",
});

/** What each operation needs, phrased for a person (used by 422 messages). */
const OPERATION_PARAMS = Object.freeze({
  brightness: { field: "value", hint: "a whole number from −255 to 255" },
  threshold: { field: "value", hint: "a whole number from 0 to 255" },
  meanfilter: { field: "window", hint: "an odd window size from 3 to 31" },
  kmeans: { field: "k", hint: "a cluster count from 2 to 20" },
  classify: { field: "ranges", hint: "one 0–255 range per cluster" },
});

/** Pydantic's phrasing, said the way a person would. */
const MESSAGE_REWRITES = [
  [/^input should be less than or equal to (\d+)$/i, "must be $1 or less"],
  [/^input should be greater than or equal to (-?\d+)$/i, "must be $1 or more"],
  [/^input should be a valid integer.*$/i, "must be a whole number"],
  [/^field required$/i, "is required"],
  [/^string should have at least (\d+) character/i, "must not be empty"],
];

/**
 * Remove developer jargon ("JSON body", schema class names) so nothing
 * technical leaks into a toast, and turn field paths into plain names.
 */
export function sanitizeMessage(text) {
  let out = String(text ?? "");
  out = out.replace(/matching\s+[A-Za-z]*Request\.?/gi, " ");
  out = out.replace(/\bJSON body\b/gi, "a value");
  out = out.replace(/\bJSON\b/gi, "data");
  // drop JSON punctuation but keep whatever text it wrapped
  out = out.replace(/[{}\[\]]/g, "");
  out = out.replace(/"/g, "");
  out = out.replace(/\s{2,}/g, " ");
  out = out.replace(/\s+([.,;:])/g, "$1");
  return out.trim();
}

/** "window: window must be an odd number" → "window size must be an odd number". */
function humanField(location) {
  if (!location) return "";
  const parts = String(location).split(".").filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];
  return FIELD_NAMES[last] ?? parts.join(" ");
}

function humanMessage(message) {
  const text = String(message ?? "").trim();
  for (const [pattern, replacement] of MESSAGE_REWRITES) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

/** One `{loc, msg}` entry → "value must be 255 or less". */
function entryToText(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return sanitizeMessage(entry);
  if (typeof entry !== "object") return String(entry);
  const path = Array.isArray(entry.loc)
    ? entry.loc.filter((part) => !["body", "query", "path"].includes(part))
    : [];
  const rawField = path.length ? String(path[path.length - 1]) : "";
  const field = humanField(path.join("."));
  const message = humanMessage(entry.msg ?? entry.message ?? "");
  if (!message) return field;
  // "window must be an odd number" already names the field — swap in the
  // human name instead of repeating it as a prefix.
  if (rawField && new RegExp(`^${rawField}\\b`, "i").test(message)) {
    return sanitizeMessage(field ? field + message.slice(rawField.length) : message);
  }
  return sanitizeMessage(field ? `${field} ${message}` : message);
}

/**
 * Friendly text for a 422, naming the field. Handles list details, the API's
 * "requires a value" phrasing, and operations that take no parameters.
 * Never returns raw JSON and never says "JSON".
 */
export function validationToText(detail, { operation = "" } = {}) {
  const spec = OPERATION_PARAMS[operation];
  const label = OPERATION_LABELS[operation]
    ?? (operation ? operation[0].toUpperCase() + operation.slice(1) : "");

  if (Array.isArray(detail)) {
    const parts = detail.map(entryToText).filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  if (detail && typeof detail === "object") {
    const nested = detail.detail ?? detail.message ?? detail.error;
    if (nested != null) return validationToText(nested, { operation });
  }

  const raw = typeof detail === "string" ? detail : "";
  if (raw) {
    if (/takes no parameters/i.test(raw)) {
      return `${label || "That operation"} does not take any parameters.`;
    }
    // "Operation 'brightness' requires a JSON body matching BrightnessRequest."
    if (/requires|expected|missing/i.test(raw) && /body|value|parameter|field/i.test(raw)) {
      if (spec) return `${label} needs ${spec.hint}, but none was sent.`;
      return `${label || "That step"} needs a value before it can run.`;
    }
    const text = sanitizeMessage(raw);
    if (text) return text;
  }
  return spec ? `${label} needs ${spec.hint}.` : "Some of those values are not valid.";
}

export class ApiError extends Error {
  constructor(status, detail, meta = {}) {
    super(`HTTP ${status}`);
    this.name = "ApiError";
    this.status = Number(status);
    /** Raw `detail` value exactly as returned by the API. */
    this.detail = detail;
    this.meta = meta;
  }

  get isNetwork() {
    return this.status === 0;
  }

  /** 404 caused by an unknown/expired session (not a missing image). */
  get isSessionExpired() {
    return this.status === 404 && /session/i.test(detailToText(this.detail));
  }
}

/** Flatten any `detail` shape into one human-readable sentence fragment. */
export function detailToText(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return sanitizeMessage(detail);
  if (Array.isArray(detail)) {
    return detail.map(entryToText).filter(Boolean).join("; ");
  }
  if (typeof detail === "object") {
    if (typeof detail.detail === "string") return detail.detail.trim();
    if (typeof detail.message === "string") return detail.message.trim();
    if (typeof detail.error === "string") return detail.error.trim();
    return "";
  }
  return String(detail);
}

/**
 * Friendly, actionable text for the UI. Never returns raw JSON.
 */
export function humanizeError(error, { apiBase = "", operation = "" } = {}) {
  if (error instanceof ApiError) {
    const detail = detailToText(error.detail);
    switch (error.status) {
      case 0:
        return (
          `Can't reach the API${apiBase ? ` at ${apiBase}` : ""}. ` +
          "Make sure the backend is running (uvicorn main:app --port 8000) and the address matches."
        );
      case 400:
        return detail || "The server rejected that request.";
      case 404:
        return detail || "That item is no longer available (it may have been evicted).";
      case 413:
        return detail || "That file is too large for the server.";
      case 415:
        return detail || "That file isn't a supported image (JPEG, PNG, BMP or TIFF).";
      case 422: {
        const text = validationToText(error.detail, { operation });
        return text || "Some of those values are not valid.";
      }
      case 429:
        return detail || "Too many requests — wait a moment and try again.";
      case 502:
        return detail || "The provider is unavailable right now. Try again shortly.";
      case 503:
        return detail || "That feature isn't configured on the server.";
      case 507:
        return detail || "The server's image memory is full. Try again or restart the API.";
      default:
        return detail || `The request failed (HTTP ${error.status}).`;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
