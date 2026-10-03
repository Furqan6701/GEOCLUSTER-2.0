/**
 * Session + image bookkeeping.
 *
 * The API keeps sessions in memory: they disappear when the server restarts
 * or after the TTL (default 60 minutes). Whenever a call fails because the
 * session is gone, this manager starts a fresh session, clears the local
 * image state and tells the user (via `SessionExpiredError`) that the working
 * image has to be uploaded again.
 */

import { ApiError } from "./errors.js";
import { rememberImage, resetImages } from "./state.js";

/**
 * Keep ground-scale metadata across a re-upload (item 5).
 *
 * The server knows a satellite image's `bbox` / `meters_per_pixel`, but an
 * evicted image is restored by uploading its Blob again — and an upload can
 * never know the scale. The values the UI already holds are therefore carried
 * over, so the Map composer's scale bar stays exact. Nothing is invented: an
 * image that never had metadata keeps none.
 */
export function carryGroundMetadata(info, previous) {
  if (!info) return info;
  const from = previous ?? {};
  return {
    ...info,
    bbox: info.bbox ?? from.bbox ?? null,
    meters_per_pixel: info.meters_per_pixel ?? from.meters_per_pixel ?? null,
  };
}

export class SessionExpiredError extends Error {
  constructor(message = "Your session expired (the server restarted or the 60-minute limit passed). A new session was created — please upload your image again.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class SessionManager {
  constructor({ api, state, bus }) {
    this.api = api;
    this.state = state;
    this.bus = bus;
    /** image_id -> Blob, so re-displaying an image costs no extra request. */
    this.blobCache = new Map();
    /** image_id -> in-flight download, so two callers share one request. */
    this.pendingBlobs = new Map();
    /** Set by the app: async (imageId) => new info, re-uploading a Blob. */
    this.reviver = null;
  }

  get sessionId() {
    return this.state.sessionId;
  }

  /** Create a session if we do not have one yet. */
  async ensure() {
    if (this.state.sessionId) return this.state.sessionId;
    return this.start();
  }

  async start() {
    const session = await this.api.createSession();
    this.state.sessionId = session.session_id;
    this.state.ttlMinutes = session.ttl_minutes;
    this.state.maxImages = session.max_images;
    this.bus.emit("session", session);
    return session.session_id;
  }

  /** Drop everything and start over (used by the "New session" button). */
  async restart() {
    this.state.sessionId = null;
    this.blobCache.clear();
    resetImages(this.state);
    const sessionId = await this.start();
    this.bus.emit("session:reset", { sessionId });
    return sessionId;
  }

  async refreshHealth() {
    const health = await this.api.health();
    this.state.health = health;
    this.bus.emit("health", health);
    return health;
  }

  /**
   * Run `fn(sessionId)` with a valid session. If the session vanished
   * mid-flight the manager recovers once and raises SessionExpiredError so
   * the caller can tell the user to re-upload.
   */
  async withSession(fn) {
    const sessionId = await this.ensure();
    try {
      return await fn(sessionId);
    } catch (error) {
      if (error instanceof ApiError && error.isSessionExpired) {
        this.state.sessionId = null;
        this.blobCache.clear();
        resetImages(this.state);
        await this.start();
        throw new SessionExpiredError();
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ images

  remember(info) {
    return rememberImage(this.state, info);
  }

  /** Register the callback that re-uploads an evicted image (see withImage). */
  setReviver(reviver) {
    this.reviver = reviver;
  }

  async imageBlob(imageId) {
    if (this.blobCache.has(imageId)) return this.blobCache.get(imageId);
    if (this.pendingBlobs.has(imageId)) return this.pendingBlobs.get(imageId);
    const request = this.withSession((sid) => this.api.downloadImage(sid, imageId, "png"))
      .then((blob) => {
        this.blobCache.set(imageId, blob);
        return blob;
      })
      .finally(() => this.pendingBlobs.delete(imageId));
    this.pendingBlobs.set(imageId, request);
    return request;
  }

  /**
   * Run `fn(sessionId, imageId)` for an image the server may have evicted.
   *
   * The API keeps only `max_images` images per session (LRU), so an id from
   * the undo history can 404 even though the session is alive. When that
   * happens the registered reviver re-uploads the state's Blob and the call is
   * retried exactly once with the replacement id — the user sees nothing.
   */
  async withImage(imageId, fn) {
    return this.withSession(async (sid) => {
      try {
        return await fn(sid, imageId);
      } catch (error) {
        const evicted = error instanceof ApiError && error.status === 404 && !error.isSessionExpired;
        if (!evicted || !this.reviver) throw error;
        const info = await this.reviver(imageId);
        if (!info?.image_id) throw error;
        return await fn(sid, info.image_id);
      }
    });
  }

  /** Upload a File/Blob as the new working ("original") image. */
  async uploadImage(file, filename = file?.name ?? "upload.png") {
    const info = await this.withSession((sid) => this.api.uploadImage(sid, file, filename));
    this.remember(info);
    this.state.original = { id: info.image_id, info };
    this.state.result = null;
    this.bus.emit("image:loaded", { role: "original", info });
    return info;
  }

  /** Make an existing image id the working image (e.g. decompressed uploads). */
  async useAsOriginal(info) {
    this.remember(info);
    this.state.original = { id: info.image_id, info };
    this.state.result = null;
    this.bus.emit("image:loaded", { role: "original", info });
    return info;
  }

  /** Record a newly produced image as the current result. */
  useAsResult(info) {
    this.remember(info);
    this.state.result = { id: info.image_id, info };
    this.bus.emit("image:loaded", { role: "result", info });
    return info;
  }

  /**
   * Record a derived image id (classify, K-Means display/labels) as the
   * result. The API's responses for those steps return only an `image_id`,
   * so `template` supplies the dimensions of the image they came from.
   */
  useAsResultId(imageId, template = {}) {
    const width = Number(template.width ?? 0);
    const height = Number(template.height ?? 0);
    const megapixels = template.megapixels ?? (width * height) / 1_000_000;
    const info = {
      image_id: imageId,
      session_id: this.state.sessionId,
      name: template.name ?? imageId,
      source: template.source ?? "derived",
      width,
      height,
      channels: template.channels ?? 3,
      megapixels,
      bytes: null,
      original_width: template.original_width ?? width,
      original_height: template.original_height ?? height,
      original_megapixels: template.original_megapixels ?? megapixels,
      scale: template.scale ?? 1,
      downscaled: false,
    };
    return this.useAsResult(info);
  }

  async fetchSatellite(request) {
    const info = await this.withSession((sid) =>
      this.api.satelliteFetch({ ...request, sessionId: sid }),
    );
    this.remember(info);
    this.state.original = { id: info.image_id, info };
    this.state.result = null;
    this.bus.emit("image:loaded", { role: "original", info });
    return info;
  }
}
