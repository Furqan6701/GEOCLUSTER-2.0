/**
 * Files panel: the GCH2 Huffman endpoints (stateless, no session needed).
 *
 * Compress sends the CURRENT image (downloaded as PNG) to /huffman/compress
 * and saves the .gch; decompress uploads a .gch, gets a PNG back and loads it
 * into the session as the working image.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { activeImage } from "../state.js";
import { button, downloadBlob, el, fmtBytes, setChildren, toast } from "../ui.js";

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
  const status = el("p", { class: "muted", text: "GCH2 files are compatible with the desktop app." });

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
      const name = `${(active.info?.name ?? active.id).replace(/\.[^.]+$/, "")}.gch`;
      downloadBlob(gch, name);
      status.textContent = `Compressed ${fmtBytes(png.size)} → ${fmtBytes(gch.size)} (${name}).`;
      toast(`Saved ${name} (${fmtBytes(gch.size)}).`, "ok");
    } catch (error) {
      report(error, "Compression failed");
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
    compressButton.textContent = busy ? "Working…" : "Compress current image → .gch";
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

  // Chat command "compress" triggers this panel.
  bus.on("huffman:compress-request", () => compress());

  const panel = el("div", { class: "panel", id: "panel-files", hidden: true }, [
    el("div", { class: "card" }, [
      el("h3", { text: "Huffman (GCH2)" }),
      compressButton,
      el("div", { style: { height: "8px" } }),
      decompressButton,
      fileInput,
      status,
      el("p", { class: "hint", text: "Compression is lossless and stateless; the file can be opened in the desktop app." }),
    ]),
  ]);

  return { id: "files", label: "Files", node: panel };
}
