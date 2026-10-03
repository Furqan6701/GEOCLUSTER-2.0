/**
 * Action gate: ONE rule for every operation button.
 *
 *   enabled  ⇔  a working image exists  AND  no request is in flight
 *
 * The bug this replaces: the Filters buttons were disabled at startup (no image
 * yet) and their state was only recomputed inside `setBusy()`, i.e. while some
 * *other* request happened to run. Uploading an image, fetching a satellite
 * tile, running K-Means, classifying, undoing or restoring an image therefore
 * left Grayscale/Negative/Laplacian greyed out ("not-allowed" cursor) until an
 * unrelated operation finished and refreshed them as a side effect.
 *
 * Now every operation button registers itself here, the gate re-evaluates all
 * of them after EVERY state change (image loaded/cleared, session reset,
 * operation applied, history changed, request started or finished), and no
 * panel decides a button's enabled state on its own.
 *
 * Requests are counted per owner, so one finished request can never clear the
 * "in flight" state of another one that is still running.
 */

import { activeImage } from "./state.js";

/** State changes after which every registered button must be re-evaluated. */
export const GATE_STATE_EVENTS = Object.freeze([
  "image:loaded",       // upload, satellite fetch, K-Means/classify result, revive
  "image:cleared",      // Clear result
  "operation:applied",  // any filter finished successfully
  "history:changed",    // undo · redo · drop
  "session:reset",      // every server-side id is gone
]);

export function createActionGate({ state, bus } = {}) {
  /** @type {Set<{node: HTMLElement, requiresImage: boolean, label: string}>} */
  const entries = new Set();
  /** Owners of in-flight requests ("filters", "kmeans", "files", …). */
  const owners = new Set();

  const hasImage = () => Boolean(activeImage(state));
  const bus_ = bus ?? null;
  const isBusy = () => owners.size > 0;

  /** The rule, in one place. */
  function canRun(entry) {
    if (isBusy()) return false;
    return entry.requiresImage ? hasImage() : true;
  }

  /** Re-evaluate every registered button. */
  function refresh() {
    for (const entry of entries) {
      const enabled = canRun(entry);
      if (entry.node.disabled === !enabled) continue; // no needless DOM writes
      entry.node.disabled = !enabled;
    }
    if (state) state.busy = isBusy();
    return entries.size;
  }

  /**
   * Track a button. `requiresImage: false` is for actions that bring an image
   * (upload/decompress) or clear one; they only follow the in-flight rule.
   */
  function register(node, { requiresImage = true, label = "" } = {}) {
    if (!node) return node;
    const entry = { node, requiresImage: Boolean(requiresImage), label };
    entries.add(entry);
    node.disabled = !canRun(entry);
    return node;
  }

  /** One request starts (`true`) or finishes (`false`) for `owner`. */
  function setBusy(value, owner = "app") {
    if (value) owners.add(owner);
    else owners.delete(owner);
    refresh();
    bus_?.emit?.("busy", isBusy());
    return isBusy();
  }

  for (const type of GATE_STATE_EVENTS) bus_?.on?.(type, () => refresh());

  return {
    register,
    setBusy,
    refresh,
    isBusy,
    hasImage,
    canRun: () => !isBusy() && hasImage(),
    size: () => entries.size,
    owners: () => [...owners],
  };
}
