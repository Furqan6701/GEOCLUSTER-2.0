/**
 * Source panel: upload an image, or fetch a Sentinel-2 tile from the API.
 *
 * Satellite notes:
 *   - start/end are optional and are only sent when the user picked dates;
 *     placeholder text is never sent (the API answers 502 "Invalid date").
 *   - the fetched tile is small (260×260 in the current setup) and becomes
 *     the working image, exactly like the desktop's "load satellite image".
 */

import { button, describeImage, el, fmtMegapixels, kv, labelled, setChildren, toast } from "../ui.js";
import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";

export function createSourcePanel(ctx) {
  const { session, bus } = ctx;

  const fileInput = el("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/bmp,image/tiff,.jpg,.jpeg,.png,.bmp,.tif,.tiff",
    class: "visually-hidden",
    tabindex: -1,
    "aria-hidden": "true",
  });
  const dropzone = el("div", { class: "dropzone", text: "Drop an image here or click to choose (JPEG, PNG, BMP, TIFF)" });
  const uploadButton = button("Upload image…", () => fileInput.click(), { variant: "primary", size: "small" });
  const infoBox = el("div", { class: "card" }, el("p", { class: "muted", text: "No image loaded yet." }));

  // ------------------------------------------------------------------ upload
  async function uploadFile(file) {
    if (!file) return;
    try {
      setBusy(true);
      const info = await session.uploadImage(file, file.name);
      toast(`Uploaded ${file.name} — ${describeImage(info)}`, "ok");
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

  // --------------------------------------------------------------- satellite
  const locationInput = el("input", { type: "text", list: "location-options", placeholder: "F-8, NUST, Centaurus…" });
  const locationList = el("datalist", { id: "location-options" });
  const startInput = el("input", { type: "date", title: "Optional start date" });
  const endInput = el("input", { type: "date", title: "Optional end date" });
  const fetchButton = button("Fetch Sentinel-2 tile", () => fetchSatellite(), { variant: "primary", size: "small" });
  const locationHint = el("p", { class: "muted", text: "Dates are optional; leave them empty to use the server's rolling window." });

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
    } catch (error) {
      reportError(error, "Satellite fetch failed");
    } finally {
      setFetchBusy(false);
    }
  }

  function setFetchBusy(busy) {
    fetchButton.disabled = busy;
    fetchButton.textContent = busy ? "Fetching…" : "Fetch Sentinel-2 tile";
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
    if (role !== "original") return;
    const rows = [
      ["id", info.image_id],
      ["name", info.name],
      ["source", info.source],
      ["size", `${info.width}×${info.height}`],
      ["megapixels", fmtMegapixels(info.megapixels)],
      ["channels", info.channels],
      ["bytes", info.bytes],
    ];
    if (info.downscaled) {
      rows.push(["downscaled", `yes — ${info.original_width}×${info.original_height} (${fmtMegapixels(info.original_megapixels)}) at ${Number(info.scale).toFixed(3)}×`]);
    }
    setChildren(infoBox, [
      el("h3", { text: "Working image" }),
      kv(rows),
      info.downscaled
        ? el("p", { class: "hint", text: "The server downscaled this image to stay under MAX_IMAGE_MEGAPIXELS." })
        : null,
    ]);
  });

  bus.on("session:reset", () => {
    setChildren(infoBox, el("p", { class: "muted", text: "No image loaded yet." }));
    locationInput.value = "";
    startInput.value = "";
    endInput.value = "";
  });

  bus.on("session", () => {
    loadLocations();
  });

  return el("div", { class: "panel", id: "panel-source" }, [
    el("div", { class: "card" }, [
      el("h3", { text: "Image source" }),
      dropzone,
      el("div", { class: "row", style: { marginTop: "8px" } }, [uploadButton, fileInput]),
    ]),
    infoBox,
    el("div", { class: "card" }, [
      el("h3", { text: "Sentinel-2 (Copernicus)" }),
      labelled("Location", locationInput, "Sector code or alias (see /locations)"),
      el("div", { class: "row" }, [
        labelled("Start (optional)", startInput),
        labelled("End (optional)", endInput),
      ]),
      locationHint,
      fetchButton,
      locationList,
    ]),
  ]);
}
