/**
 * Tiny event bus + shared application state.
 *
 * Modules never reach into each other: they publish on the bus and read the
 * state object passed to them at construction time.
 */

import { DEFAULT_API_BASE } from "./config.js";

export function createBus() {
  const listeners = new Map();
  return {
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    emit(type, payload) {
      for (const handler of listeners.get(type) ?? []) {
        try {
          handler(payload);
        } catch (error) {
          // A failing listener must never break the publisher.
          console.error(`[bus] listener for "${type}" failed`, error);
        }
      }
    },
  };
}

export function createAppState() {
  return {
    /** API base URL the client was built with. */
    apiBase: DEFAULT_API_BASE,
    /** Session info from POST /sessions (null until created). */
    sessionId: null,
    ttlMinutes: null,
    maxImages: null,
    /** GET /health payload (null until fetched). */
    health: null,
    /** {id, info} of the uploaded image. */
    original: null,
    /** {id, info} of the most recent operation result. */
    result: null,
    /** id -> image info object (everything the server returned). */
    images: new Map(),
    /** Last K-Means response (ranges, assignments, ids). */
    kmeans: null,
    /** Classification used by the Map view: {legend, imageId, name, canvas}. */
    map: null,
    /** Distance settings: {unit: "px"|"mm"|"cm"|"in", pxPerUnit: number|null}. */
    measure: { unit: "px", pxPerUnit: null },
    /** True while a request the UI initiated is in flight. */
    busy: false,
  };
}

/** The image an operation should act on: the newest result, else the original. */
export function activeImage(state) {
  return state.result ?? state.original ?? null;
}

export function rememberImage(state, info) {
  if (info && info.image_id) state.images.set(info.image_id, info);
  return info;
}

export function resetImages(state) {
  state.original = null;
  state.result = null;
  state.images.clear();
  state.kmeans = null;
}
