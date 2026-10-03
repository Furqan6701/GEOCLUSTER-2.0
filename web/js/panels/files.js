/**
 * Files section: GCH2 Huffman compression plus PNG export.
 *
 * Compress sends the CURRENT image (downloaded as PNG) to /huffman/compress
 * and saves the .gch; decompress uploads a .gch, gets a PNG back and loads it
 * into the session as the working image. Export saves the current image as a
 * PNG without touching the API.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, createSection, downloadBlob, el, fmtBytes, icon, toast, toolGroup } from "../ui.js";

export function createFilesPanel(ctx) {
  const { session, bus, state } = ctx;

  const compressButton = button("Compress current image → .gch", compress, { variant: "primary", size: "small" });
  const fileInput = el("input", {
    type: "file",
    accept: ".gch,application/octet-stream",
    class: "visually-hidden",
    tabindex: -1,
    "aria-hidden": "true",
  });
  const decompressButton = button("Decompress a .gch file…", () => fileInput.click(), { size: "small" });
  const exportButton = button("Export current image (PNG)…", exportPng, { size: "small" });
  const status = el("p", { class: "note", text: "GCH2 files are compatible with the desktop app." });

  function baseName() {
    const active = activeImage(state);
    return String(active?.info?.name ?? active?.id ?? "image").replace(/\.[^.]+$/, "");
  }

  async function compress() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return;
    }
    setBusy(true);
    try {
      const png = await session.imageBlob(active.id);
      const gch = await ctx.api.huffmanCompress(png, `${active.id}.png`);
      const name = `${baseName()}.gch`;
      downloadBlob(gch, name);
      status.textContent = `Compressed ${fmtBytes(png.size)} → ${fmtBytes(gch.size)} (${name}).`;
      toast(`Saved ${name} (${fmtBytes(gch.size)}).`, "ok");
      bus.emit("status", { message: `Compressed ${name} — ${fmtBytes(gch.size)}` });
    } catch (error) {
      report(error, "Compression failed");
    } finally {
      setBusy(false);
    }
  }

  async function exportPng() {
    const active = activeImage(state);
    if (!active) {
      toast("Load or fetch an image first.", "warn");
      return;
    }
    setBusy(true);
    try {
      const png = await session.imageBlob(active.id);
      const name = `${baseName()}.png`;
      downloadBlob(png, name);
      status.textContent = `Exported ${name} (${fmtBytes(png.size)}).`;
      toast(`Exported ${name} (${fmtBytes(png.size)}).`, "ok");
      bus.emit("status", { message: `Exported ${name}` });
    } catch (error) {
      report(error, "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function decompress(file) {
    if (!file) return;
    setBusy(true);
    try {
      const png = await ctx.api.huffmanDecompress(file, file.name);
      const info = await session.uploadImage(png, `${file.name.replace(/\.[^.]+$/, "")}.png`);
      status.textContent = `Decompressed ${file.name} (${fmtBytes(file.size)}) → ${info.width}×${info.height} PNG, loaded as the working image.`;
      toast("Decompressed image loaded — run any operation on it.", "ok");
    } catch (error) {
      report(error, "Decompression failed");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    compressButton.disabled = busy;
    decompressButton.disabled = busy;
    exportButton.disabled = busy;
    compressButton.textContent = busy ? "Working…" : "Compress current image → .gch";
    if (busy) compressButton.prepend(icon("archive", { size: 12 }));
  }

  function report(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    decompress(file);
  });

  // Chat command "compress" and the toolbar/menu entry points trigger these.
  bus.on("huffman:compress-request", () => compress());
  bus.on("huffman:decompress-request", () => fileInput.click());
  bus.on("export:request", () => exportPng());

  const section = createSection({
    id: "files",
    title: "Files",
    iconName: "archive",
    collapsed: true,
    body: [
      toolGroup("Huffman (GCH2)", [
        compressButton,
        el("div", { style: { height: "5px" } }),
        decompressButton,
        fileInput,
        status,
        el("p", { class: "note", text: "Compression is lossless and stateless; the file can be opened in the desktop app." }),
      ]),
      toolGroup("Export", [exportButton]),
    ],
  });

  return { id: "files", label: "Files", section, actions: { compress, decompress, exportPng } };
}
