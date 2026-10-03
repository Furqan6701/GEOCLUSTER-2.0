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

  async imageBlob(imageId) {
    if (this.blobCache.has(imageId)) return this.blobCache.get(imageId);
    const blob = await this.withSession((sid) => this.api.downloadImage(sid, imageId, "png"));
    this.blobCache.set(imageId, blob);
    return blob;
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

  async fetchSatellite({ location, start = null, end = null }) {
    const info = await this.withSession((sid) =>
      this.api.satelliteFetch({ sessionId: sid, location, start, end }),
    );
    this.remember(info);
    this.state.original = { id: info.image_id, info };
    this.state.result = null;
    this.bus.emit("image:loaded", { role: "original", info });
    return info;
  }
}
