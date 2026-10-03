/**
 * Source section: upload an image, fetch a Sentinel-2 tile, list session files.
 *
 * Satellite notes:
 *   - start/end are optional and are only sent when the user picked dates;
 *     placeholder text is never sent (the API answers 502 "Invalid date").
 *   - the fetched tile is small (260×260 in the current setup) and becomes
 *     the working image, exactly like the desktop's "load satellite image".
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { button, createSection, describeImage, el, fmtBytes, icon, kv, labelled, setChildren, table, toast, toolGroup } from "../ui.js";

export function createSourcePanel(ctx) {
  // File > "Session images…" reveals this section and re-renders this list.
  const { session, bus, state } = ctx;

  const fileInput = el("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/bmp,image/tiff,.jpg,.jpeg,.png,.bmp,.tif,.tiff",
    class: "visually-hidden",
    tabindex: -1,
    "aria-hidden": "true",
  });
  const dropzone = el("div", { class: "dropzone", text: "Drop an image here or click to choose (JPEG, PNG, BMP, TIFF)" });
  const uploadButton = button("Upload image…", () => fileInput.click(), { variant: "primary", size: "small" });
  uploadButton.prepend(icon("upload", { size: 12 }));
  const infoBox = el("div", {}, el("p", { class: "empty-note", text: "No image loaded yet." }));
  const filesBox = el("div", {}, el("p", { class: "empty-note", text: "No images in this session." }));

  // ------------------------------------------------------------------ upload
  async function uploadFile(file) {
    if (!file) return;
    try {
      setBusy(true);
      const info = await session.uploadImage(file, file.name);
      toast(`Uploaded ${file.name} — ${describeImage(info)}`, "ok");
      renderFiles();
    } catch (error) {
      reportError(error, "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(busy) {
    uploadButton.disabled = busy;
    dropzone.textContent = busy
      ? "Uploading…"
      : "Drop an image here or click to choose (JPEG, PNG, BMP, TIFF)";
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    uploadFile(file);
  });
  dropzone.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("drag");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag");
    }),
  );
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    uploadFile(file);
  });

  // -------------------------------------------------------- session file list
  function renderFiles() {
    const images = [...state.images.values()].filter((info) => info?.image_id);
    if (!images.length) {
      setChildren(filesBox, el("p", { class: "empty-note", text: "No images in this session." }));
      return;
    }
    const rows = images.slice(-12).reverse().map((info) => [
      info.image_id === state.original?.id
        ? el("span", { class: "badge ok", text: "working" })
        : info.image_id === state.result?.id
          ? el("span", { class: "badge", text: "result" })
          : el("span", { class: "badge", text: String(info.source ?? "image").slice(0, 7) }),
      el("span", { title: info.image_id }, [
        el("div", { text: String(info.name ?? info.image_id).slice(0, 26) }),
        el("div", { class: "muted", text: `${info.width}×${info.height}` }),
      ]),
      button("Show", () => useAsOriginal(info), { size: "small", variant: "ghost", title: "Display this image as the working image" }),
    ]);
    setChildren(filesBox, table(["", "Image", ""], rows));
  }

  async function useAsOriginal(info) {
    try {
      await session.useAsOriginal(info);
      bus.emit("status", { message: `Working image → ${info.name ?? info.image_id}` });
      toast(`Showing ${info.name ?? info.image_id} as the working image.`, "ok");
    } catch (error) {
      reportError(error, "Could not load that image");
    }
  }

  // --------------------------------------------------------------- satellite
  const locationInput = el("input", { type: "text", list: "location-options", placeholder: "F-8, NUST, Centaurus…" });
  const locationList = el("datalist", { id: "location-options" });
  const startInput = el("input", { type: "date", title: "Optional start date" });
  const endInput = el("input", { type: "date", title: "Optional end date" });
  const fetchButton = button("Fetch Sentinel-2 tile", () => fetchSatellite(), { variant: "primary", size: "small" });
  fetchButton.prepend(icon("satellite", { size: 12 }));
  const locationHint = el("p", { class: "note", text: "Dates are optional; leave them empty to use the server's rolling window." });

  async function loadLocations() {
    try {
      const catalog = await ctx.api.locations();
      const options = [];
      for (const alias of Object.keys(catalog.aliases ?? {})) options.push(alias);
      for (const sector of Object.keys(catalog.sectors ?? {})) options.push(sector);
      setChildren(locationList, [...new Set(options)].sort().map((value) => el("option", { value })));
    } catch {
      /* the list is a convenience; fetching still works without it */
    }
  }

  async function fetchSatellite() {
    const location = locationInput.value.trim();
    if (!location) {
      toast("Type a sector or alias first (for example F-8 or NUST).", "warn");
      locationInput.focus();
      return;
    }
    const start = startInput.value || null;
    const end = endInput.value || null;
    if (start && end && start > end) {
      toast("The start date must not be after the end date.", "warn");
      return;
    }
    try {
      setFetchBusy(true);
      const info = await session.fetchSatellite({ location, start, end });
      toast(`Loaded satellite imagery for ${location} — ${describeImage(info)}`, "ok");
      renderFiles();
    } catch (error) {
      reportError(error, "Satellite fetch failed");
    } finally {
      setFetchBusy(false);
    }
  }

  function setFetchBusy(busy) {
    fetchButton.disabled = busy;
    fetchButton.textContent = busy ? "Fetching…" : "Fetch Sentinel-2 tile";
    fetchButton.prepend(icon("satellite", { size: 12 }));
  }

  function reportError(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  // --------------------------------------------------------------- rendering
  bus.on("image:loaded", ({ role, info }) => {
    if (role === "original") {
      const rows = [
        ["id", info.image_id],
        ["name", info.name],
        ["source", info.source],
        ["size", `${info.width}×${info.height}`],
        ["megapixels", info.megapixels == null ? "—" : Number(info.megapixels).toFixed(2)],
        ["channels", info.channels],
        ["bytes", info.bytes == null ? "—" : fmtBytes(info.bytes)],
      ];
      if (info.downscaled) {
        rows.push(["downscaled", `yes — ${info.original_width}×${info.original_height} at ${Number(info.scale).toFixed(3)}×`]);
      }
      setChildren(infoBox, [
        kv(rows),
        info.downscaled
          ? el("p", { class: "note warn", text: "The server downscaled this image to stay under MAX_IMAGE_MEGAPIXELS." })
          : null,
      ]);
    }
    renderFiles();
  });

  bus.on("session:reset", () => {
    setChildren(infoBox, el("p", { class: "empty-note", text: "No image loaded yet." }));
    setChildren(filesBox, el("p", { class: "empty-note", text: "No images in this session." }));
    locationInput.value = "";
    startInput.value = "";
    endInput.value = "";
  });

  bus.on("session", () => {
    loadLocations();
  });

  // the chat can fetch imagery too — keep this section's input in sync
  bus.on("satellite:fetched", ({ location }) => {
    locationInput.value = location;
    renderFiles();
  });

  // toolbar / menu entry points
  bus.on("open:file-request", () => fileInput.click());
  bus.on("satellite:request", () => {
    locationInput.focus();
    locationInput.select?.();
  });

  const section = createSection({
    id: "source",
    title: "Source",
    iconName: "open",
    body: [
      toolGroup("Image", [
        dropzone,
        el("div", { class: "row center", style: { marginTop: "6px" } }, [uploadButton, fileInput]),
      ]),
      editorGroup("Working image", infoBox),
      toolGroup("Session files", [filesBox]),
      toolGroup("Satellite (Sentinel-2)", [
        labelled("Location", locationInput, "Sector code or alias (see /locations)"),
        el("div", { class: "row" }, [
          labelled("Start", startInput, "optional"),
          labelled("End", endInput, "optional"),
        ]),
        locationHint,
        fetchButton,
        locationList,
      ]),
    ],
  });

  return { id: "source", label: "Source", section, actions: { uploadFile, fetchSatellite, renderFiles } };
}

function editorGroup(title, body) {
  return toolGroup(title, [body]);
}
