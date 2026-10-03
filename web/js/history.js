/**
 * Client-side undo/redo history.
 *
 * The API keeps only a handful of images per session (LRU eviction) and offers
 * no "revert" endpoint, so history is kept entirely in the browser: the last
 * `HISTORY_LIMIT` states, each with the Blob of the image it displayed plus
 * the metadata needed to put it back (label, server image id, info).
 *
 * A state is a snapshot of both viewports as they were *after* that step, so
 * undoing restores the whole workspace — including "Clear result", which has
 * no image of its own.
 *
 * Restoring normally needs no server call at all (the Blob is local). When an
 * image id has been evicted server-side, the caller re-uploads the stored Blob
 * and `adopt()` re-points every entry at the new id, so history keeps working.
 */

export const HISTORY_LIMIT = 15;
/** Blobs are bigger than metadata; keep a few more than the states need. */
export const BLOB_LIMIT = 24;

export class ImageHistory {
  constructor({ limit = HISTORY_LIMIT, blobLimit = BLOB_LIMIT, onReplaced = null } = {}) {
    this.limit = limit;
    this.blobLimit = blobLimit;
    /** Oldest → newest. `pointer` indexes the state currently displayed. */
    this.entries = [];
    this.pointer = -1;
    /** image id → Blob (insertion order, oldest evicted first). */
    this.blobs = new Map();
    this.onReplaced = onReplaced;
  }

  get size() {
    return this.entries.length;
  }

  get canUndo() {
    return this.pointer > 0;
  }

  get canRedo() {
    return this.pointer >= 0 && this.pointer < this.entries.length - 1;
  }

  get current() {
    return this.entries[this.pointer] ?? null;
  }

  /** "7/15"-style summary for the status bar. */
  /** How many Blobs are currently held in memory. */
  get blobCount() {
    return this.blobs.size;
  }

  get summary() {
    if (!this.entries.length) return "";
    return `${this.pointer + 1}/${this.entries.length}`;
  }

  /**
   * Append a state. `entry` = { label, role, imageId, info, blob, snapshot }
   * where snapshot = { original: {id, info}|null, result: {id, info}|null }.
   * Recording after an undo discards the redo tail, like any editor.
   */
  record(entry) {
    if (!entry) return null;
    this.entries = this.entries.slice(0, Math.max(this.pointer + 1, 0));
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(this.entries.length - this.limit);
    }
    this.pointer = this.entries.length - 1;
    if (entry.imageId && entry.blob) this.rememberBlob(entry.imageId, entry.blob);
    return entry;
  }

  rememberBlob(imageId, blob) {
    if (!imageId || !blob) return;
    if (this.blobs.has(imageId)) this.blobs.delete(imageId);
    this.blobs.set(imageId, blob);
    while (this.blobs.size > this.blobLimit) {
      const oldest = this.blobs.keys().next().value;
      this.blobs.delete(oldest);
    }
  }

  blobFor(imageId) {
    return this.blobs.get(imageId) ?? null;
  }

  /** Step back one state; returns it (the caller applies the snapshot). */
  undo() {
    if (!this.canUndo) return null;
    this.pointer -= 1;
    return this.current;
  }

  /** Step forward one state; returns it. */
  redo() {
    if (!this.canRedo) return null;
    this.pointer += 1;
    return this.current;
  }

  /**
   * Remove one step by the image id it displayed.
   *
   * A slider adjustment replaces its own previous step instead of stacking a
   * new one, so before the new state is recorded the old one is dropped. The
   * pointer keeps pointing at the same entry it did before.
   */
  dropEntry(imageId) {
    const index = this.entries.findIndex((entry) => entry.imageId === imageId);
    if (index < 0) return false;
    const wasApplied = index <= this.pointer;
    this.entries.splice(index, 1);
    if (wasApplied) this.pointer -= 1;
    if (this.pointer >= this.entries.length) this.pointer = this.entries.length - 1;
    return true;
  }

  /**
   * A state's Blob was re-uploaded under a new id (the old one was evicted):
   * move the blob across and re-point every entry that referenced the old id.
   */
  adopt(oldId, info, blob = null) {
    const stored = blob ?? this.blobs.get(oldId) ?? null;
    if (stored) {
      this.blobs.delete(oldId);
      this.rememberBlob(info.image_id, stored);
    }
    for (const entry of this.entries) {
      if (entry.imageId === oldId) {
        entry.imageId = info.image_id;
        entry.info = info;
      }
      for (const slot of [entry.snapshot?.original, entry.snapshot?.result]) {
        if (slot && slot.id === oldId) {
          slot.id = info.image_id;
          slot.info = info;
        }
      }
    }
    this.onReplaced?.(oldId, info);
  }

  reset() {
    this.entries = [];
    this.pointer = -1;
    this.blobs.clear();
  }
}

/** Snapshot of the two viewports, used for the "Clear result" step. */
export function snapshotOf(state) {
  const slot = (value) => (value ? { id: value.id, info: value.info ?? null } : null);
  return { original: slot(state.original), result: slot(state.result) };
}
