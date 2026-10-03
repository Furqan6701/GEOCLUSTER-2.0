/**
 * Error handling: turn anything the API (or the network) throws into text a
 * human can act on. Raw JSON is never shown in the UI.
 *
 * Error bodies from the API look like {"detail": "..."}. For 422 responses the
 * detail is usually a list of {loc, msg, type} entries.
 */

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

function entryToText(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object") return String(entry);
  const location = Array.isArray(entry.loc)
    ? entry.loc.filter((part) => !["body", "query", "path"].includes(part)).join(".")
    : "";
  const message = entry.msg ?? entry.message ?? "";
  return location ? `${location}: ${message}` : String(message);
}

/** Flatten any `detail` shape into one human-readable sentence fragment. */
export function detailToText(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail.trim();
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
export function humanizeError(error, { apiBase = "" } = {}) {
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
      case 422:
        return detail ? `Please check these values — ${detail}` : "Some of those values are not valid.";
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
