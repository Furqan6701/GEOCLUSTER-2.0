/**
 * Image file actions (item 12): Export current image (PNG), Export raw label
 * map (PNG), Compress to .gch and Open .gch file (decompress).
 *
 * These four used to be a "Files" sidebar section. The section is gone, so the
 * File menu and the two toolbar buttons (Export / Compress) drive the same code
 * through the bus — one owner, one implementation, one busy rule:
 *
 *   * the File menu asks the central action gate whether an action may run
 *     (`gate.canRun()` / `gate.isBusy()`), so the entries can never disagree
 *     with the toolbar or the panels;
 *   * every request books itself with the gate (`gate.setBusy(true, "image-actions")`)
 *     and finishes through the same `finally`.
 *
 * Compress sends the CURRENT image (downloaded as PNG) to /huffman/compress and
 * saves the .gch; decompress uploads a .gch, gets a PNG back and loads it into
 * the session as the working image; export saves the current image as a PNG
 * without touching the API; the label map comes from the Clusters panel's
 * K-Means response (bus `labelmap:request`), never from a second request.
 */

import { humanizeError } from "./errors.js";
import { SessionExpiredError } from "./session.js";
import { activeImage } from "./state.js";
import { downloadBlob, el, fmtBytes, toast } from "./ui.js";

/** Owner name the gate counts this module's in-flight requests under. */
export const IMAGE_ACTION_OWNER = "image-actions";

/** What the hidden file picker accepts; shared with the tests. */
export const GCH_ACCEPT = ".gch,application/octet-stream";

export function createImageActions(ctx) {
  const { api, session, bus, state, gate } = ctx;

  // One hidden picker owns the .gch flow; the File menu's "Open .gch file"
  // entry (and the chat command, and the decompress bus event) all click it.
  const fileInput = el("input", {
    type: "file",
    accept: GCH_ACCEPT,
    class: "visually-hidden",
    tabindex: -1,
    "aria-hidden": "true",
  });
  fileInput.id = "gch-file-input";
  document.body.append(fileInput);

  function baseName() {
    const active = activeImage(state);
    return String(active?.info?.name ?? active?.id ?? "image").replace(/\.[^.]+$/, "");
  }

  function setBusy(busy) {
    gate?.setBusy(busy, IMAGE_ACTION_OWNER);
  }

  async function compress() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return { ok: false };
    }
    setBusy(true);
    try {
      const png = await session.imageBlob(active.id);
      const gch = await api.huffmanCompress(png, `${active.id}.png`);
      const name = `${baseName()}.gch`;
      downloadBlob(gch, name);
      toast(`Saved ${name} (${fmtBytes(gch.size)}).`, "ok");
      bus.emit("status", { message: `Compressed ${name} — ${fmtBytes(gch.size)}` });
      return { ok: true, blob: gch, name };
    } catch (error) {
      report(error, "Compression failed");
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }

  async function exportPng() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return { ok: false };
    }
    setBusy(true);
    try {
      const png = await session.imageBlob(active.id);
      const name = `${baseName()}.png`;
      downloadBlob(png, name);
      toast(`Exported ${name} (${fmtBytes(png.size)}).`, "ok");
      bus.emit("status", { message: `Exported ${name}` });
      return { ok: true, blob: png, name };
    } catch (error) {
      report(error, "Export failed");
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }

  async function decompress(file) {
    if (!file) return { ok: false };
    setBusy(true);
    try {
      const png = await api.huffmanDecompress(file, file.name);
      const info = await session.uploadImage(png, `${file.name.replace(/\.[^.]+$/, "")}.png`);
      toast(`Decompressed ${file.name} → ${info.width}×${info.height} loaded as the working image.`, "ok");
      bus.emit("status", { message: `Decompressed ${file.name} (${fmtBytes(file.size)})` });
      return { ok: true, info };
    } catch (error) {
      report(error, "Decompression failed");
      return { ok: false, error };
    } finally {
      setBusy(false);
    }
  }

  /** Open the OS file picker (the File menu entry and the chat command use it). */
  function chooseFile() {
    fileInput.click();
  }

  function report(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: api.base })}`, "bad", { timeout: 12000 });
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    void decompress(file);
  });

  // the toolbar's Export/Compress buttons and the chat's compress command
  bus.on("huffman:compress-request", () => void compress());
  bus.on("huffman:decompress-request", () => chooseFile());
  bus.on("export:request", () => void exportPng());

  return {
    id: "image-actions",
    fileInput,
    actions: { compress, decompress, exportPng, chooseFile },
  };
}
