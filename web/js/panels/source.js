/**
 * Source section: upload an image, or fetch a Sentinel-2 crop.
 *
 * The panel is deliberately short:
 *   - an upload drop zone, and
 *   - one satellite block with two modes: **Place** (sector code, alias or any
 *     place name + a 1/2/5 km size box) and **Coordinates** (two corners pasted
 *     from Google Maps, in any order).
 * Optional dates live under the collapsed "Advanced" fold and are only sent
 * when the user typed them — placeholder text is never sent.
 *
 * The working-image metadata block and the session file table were removed
 * from the UI (they duplicated what the viewports and the status bar already
 * show). The bookkeeping behind them is kept: `renderFiles()` and
 * `useAsOriginal()` still run and still update their hosts, which are simply
 * not attached to the panel any more.
 *
 * The place name is the *only* thing the frontend sends for a lookup: the
 * coordinates are resolved server-side (sector table, else Nominatim), never by
 * the chat model and never in the browser.
 */

import { humanizeError } from "../errors.js";
import { SessionExpiredError } from "../session.js";
import { button, createSection, el, icon, labelled, setChildren, toast, toolGroup } from "../ui.js";

const SIZE_OPTIONS_KM = [1, 2, 5];
const DEFAULT_SIZE_KM = 2;

export function createSourcePanel(ctx) {
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

  // Kept for internal bookkeeping (never attached to the panel): see the
  // module docstring — the UI no longer shows metadata or a file table.
  const infoBox = el("div", {}, el("p", { class: "empty-note", text: "No image loaded yet." }));
  const filesBox = el("div", {}, el("p", { class: "empty-note", text: "No images in this session." }));

  // ------------------------------------------------------------------ upload
  async function uploadFile(file) {
    if (!file) return;
    try {
      setBusy(true);
      const info = await session.uploadImage(file, file.name);
      toast(`Uploaded ${file.name} — ${describeSize(info)}`, "ok");
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

  // -------------------------------------------------------- session bookkeeping
  /** Internal only: the session's image bookkeeping (nothing is rendered). */
  function renderFiles() {
    const images = [...state.images.values()].filter((info) => info?.image_id);
    setChildren(filesBox, images.length
      ? el("p", { class: "empty-note", text: `${images.length} image(s) in this session.` })
      : el("p", { class: "empty-note", text: "No images in this session." }));
  }

  /** Internal only: make an existing session image the working image. */
  async function useAsOriginal(info) {
    try {
      await session.useAsOriginal(info);
      toast(`Working image → ${info.name ?? "the fetched image"}`, "ok");
    } catch (error) {
      reportError(error, "Could not load that image");
    }
  }

  /** "sample.jpg — 1600×1066 px" without pulling in the whole metadata block. */
  function describeSize(info) {
    if (!info) return "image";
    const size = info.width && info.height ? ` ${info.width}×${info.height} px` : "";
    return `(${info.source ?? "image"}${size})`;
  }

  // --------------------------------------------------------------- satellite
  const locationInput = el("input", {
    type: "text",
    list: "location-options",
    placeholder: "F-8, NUST, Karachi…",
    title: "Sector code, alias, or any place name",
  });
  const locationList = el("datalist", { id: "location-options" });
  const sizeSelect = el("select", { class: "select", id: "sat-size", title: "Side of the square to download" },
    SIZE_OPTIONS_KM.map((km) => el("option", { value: String(km), text: `${km} km` })));
  sizeSelect.value = String(DEFAULT_SIZE_KM);

  const corner1Input = el("input", {
    type: "text", id: "sat-corner1", placeholder: "33.6844, 73.0479",
    title: "Paste from Google Maps — any corner",
  });
  const corner2Input = el("input", {
    type: "text", id: "sat-corner2", placeholder: "33.6600, 73.1000",
    title: "The opposite corner; no need to sort them",
  });

  const placeModeRadio = el("input", {
    type: "radio", name: "sat-mode", value: "place", id: "sat-mode-place", checked: true,
  });
  const cornersModeRadio = el("input", {
    type: "radio", name: "sat-mode", value: "bbox", id: "sat-mode-corners",
  });
  const modeRow = el("div", { class: "row center wrap", role: "radiogroup", "aria-label": "Satellite input mode" }, [
    el("label", { class: "checkbox", for: "sat-mode-place" }, [placeModeRadio, "Place"]),
    el("label", { class: "checkbox", for: "sat-mode-corners" }, [cornersModeRadio, "Coordinates"]),
  ]);

  const placeRow = el("div", { class: "sat-row", dataset: { satRow: "place" } }, [
    labelled("Place", locationInput),
    labelled("Size", sizeSelect),
  ]);
  const cornersRow = el("div", { class: "sat-row", dataset: { satRow: "bbox" } }, [
    labelled("Corner 1 (lat, lon)", corner1Input),
    labelled("Corner 2 (lat, lon)", corner2Input),
  ]);

  const startInput = el("input", {
    type: "date",
    title: "Optional start date (YYYY-MM-DD) — leave it empty to use the server's rolling window",
  });
  const endInput = el("input", {
    type: "date",
    title: "Optional end date (YYYY-MM-DD) — leave it empty to use the server's rolling window",
  });
  const advanced = el("details", { class: "advanced" }, [
    el("summary", { text: "Advanced" }),
    el("div", { class: "row", style: { marginTop: "6px" } }, [
      labelled("Start", startInput),
      labelled("End", endInput),
    ]),
  ]);

  const refreshToggle = el("input", { type: "checkbox", id: "sat-refresh" });
  const refreshLabel = el("label", {
    class: "checkbox", for: "sat-refresh",
    title: "Download a fresh crop instead of reusing the cached one",
  }, [refreshToggle, "Refresh (ignore the cache)"]);

  const fetchButton = button("Fetch Sentinel-2 crop", () => fetchSatellite(), { variant: "primary", size: "small" });
  fetchButton.prepend(icon("satellite", { size: 12 }));

  function currentMode() {
    return cornersModeRadio.checked ? "bbox" : "place";
  }

  function syncMode() {
    const mode = currentMode();
    placeRow.hidden = mode !== "place";
    cornersRow.hidden = mode !== "bbox";
    fetchButton.textContent = mode === "bbox" ? "Fetch this area" : "Fetch Sentinel-2 crop";
    fetchButton.prepend(icon("satellite", { size: 12 }));
  }
  placeModeRadio.addEventListener("change", syncMode);
  cornersModeRadio.addEventListener("change", syncMode);
  syncMode();

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

  /** The request body for the current mode; throws nothing, returns null when empty. */
  function buildRequest() {
    const start = startInput.value || null;
    const end = endInput.value || null;
    if (start && end && start > end) {
      toast("The start date must not be after the end date.", "warn");
      return null;
    }
    const refresh = refreshToggle.checked;
    if (currentMode() === "bbox") {
      const corner1 = corner1Input.value.trim();
      const corner2 = corner2Input.value.trim();
      if (!corner1 || !corner2) {
        toast("Paste both corners as 'lat, lon' — for example 33.6844, 73.0479.", "warn");
        (corner1 ? corner2Input : corner1Input).focus();
        return null;
      }
      return { mode: "bbox", corner1, corner2, start, end, refresh };
    }
    const location = locationInput.value.trim();
    if (!location) {
      toast("Type a sector, an alias or a place name first (for example F-8 or Karachi).", "warn");
      locationInput.focus();
      return null;
    }
    return { mode: "place", location, sizeKm: Number(sizeSelect.value), start, end, refresh };
  }

  async function fetchSatellite(requestOverride = null) {
    const request = requestOverride ?? buildRequest();
    if (!request) return { ok: false, reason: "incomplete" };
    try {
      setFetchBusy(true);
      const info = await session.fetchSatellite(request);
      const what = request.mode === "bbox"
        ? `the area around ${request.corner1}`
        : `${request.location} (${request.sizeKm ?? DEFAULT_SIZE_KM} km)`;
      toast(`Loaded satellite imagery for ${what} — ${describeSize(info)}`, "ok");
      renderFiles();
      return { ok: true, info };
    } catch (error) {
      reportError(error, "Satellite fetch failed");
      return { ok: false, reason: "failed", error };
    } finally {
      setFetchBusy(false);
    }
  }

  function setFetchBusy(busy) {
    fetchButton.disabled = busy;
    fetchButton.textContent = busy ? "Fetching…" : (currentMode() === "bbox" ? "Fetch this area" : "Fetch Sentinel-2 crop");
    fetchButton.prepend(icon("satellite", { size: 12 }));
  }

  function reportError(error, prefix) {
    if (error instanceof SessionExpiredError) {
      toast(error.message, "warn", { timeout: 12000 });
      return;
    }
    // 422 details from the satellite endpoint are already plain sentences
    // ("Corner 1 must look like 'lat, lon' …", "The area is too large …").
    toast(`${prefix}: ${humanizeError(error, { apiBase: ctx.api.base })}`, "bad", { timeout: 12000 });
  }

  // --------------------------------------------------------------- rendering
  bus.on("image:loaded", ({ role, info }) => {
    if (role === "original") {
      setChildren(infoBox, el("p", { class: "note", text: `${info?.name ?? "image"} · ${info?.width ?? "?"}×${info?.height ?? "?"}` }));
    }
    renderFiles();
  });

  bus.on("session:reset", () => {
    setChildren(infoBox, el("p", { class: "empty-note", text: "No image loaded yet." }));
    setChildren(filesBox, el("p", { class: "empty-note", text: "No images in this session." }));
    locationInput.value = "";
    corner1Input.value = "";
    corner2Input.value = "";
    startInput.value = "";
    endInput.value = "";
    refreshToggle.checked = false;
  });

  bus.on("session", () => {
    loadLocations();
  });

  // the chat can fetch imagery too — keep this section's input in sync
  bus.on("satellite:fetched", ({ location }) => {
    if (location) {
      placeModeRadio.checked = true;
      cornersModeRadio.checked = false;
      locationInput.value = location;
      syncMode();
    }
    renderFiles();
  });

  // toolbar / menu entry points
  bus.on("open:file-request", () => fileInput.click());
  bus.on("satellite:request", () => {
    const target = currentMode() === "bbox" ? corner1Input : locationInput;
    target.focus();
    target.select?.();
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
      toolGroup("Satellite (Sentinel-2)", [
        modeRow,
        placeRow,
        cornersRow,
        el("div", { class: "row center wrap", style: { marginTop: "6px" } }, [refreshLabel]),
        fetchButton,
        advanced,
        locationList,
      ]),
    ],
  });

  return {
    id: "source",
    label: "Source",
    section,
    actions: { uploadFile, fetchSatellite, renderFiles, useAsOriginal, buildRequest, currentMode },
  };
}
