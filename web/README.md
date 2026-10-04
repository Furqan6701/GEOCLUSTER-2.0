# GeoCluster 2.0 — web workstation

Static HTML/CSS/JavaScript frontend for the GeoCluster API (`api/`). No build
step, no framework, no keys: the browser talks straight to the API.

The UI is laid out like desktop remote-sensing software (QGIS / ENVI style)
rather than a dashboard:

```
┌──────────────────────────────────────────────────────────────────┐
│ GeoCluster 2.0 │ File View Processing Analysis Help │  status    │
├──────────────────────────────────────────────────────────────────┤
│ Open │ Satellite │ Export │ Compress │ ⇄ Undo/Redo │ tools │ docks│
├──────────────┬────────────────────────────────────┬──────────────┤
│ TOOLBOX      │        IMAGE WORKSPACE             │ ASSISTANT    │
│  Source      │  ┌──────────────┬──────────────┐   │  conversation│
│  Filters     │  │  ORIGINAL    │    RESULT    │   │  …           │
│  Clusters    │  │  (viewport)  │  (viewport)  │   │  quick cmds  │
│  Analysis    │  └──────────────┴──────────────┘   │  [ask…] [send]│
│  Files       │  · Map (classified + legend)       │              │
├──────────────┴────────────────────────────────────┴──────────────┤
│ 2449 × 1632 px │ RGB │ Zoom 100% │ X Y │ RGB: … │ session │ API ● │
└──────────────────────────────────────────────────────────────────┘
```

* **Image workspace first** — the two viewports own the flexible grid track;
  the toolbox and assistant are fixed-width docks that can be collapsed (their
  width goes back to the imagery). At narrow widths the viewports stack.
* **Viewports, not cards** — dark image-processing panes, framed image,
  fit-to-view with the aspect ratio preserved, cursor-anchored wheel zoom,
  drag panning, nearest-neighbour pixels at ≥1:1, pixel readout, distance
  measurement, image name + dimensions in the header, zoom % in the footer.
* **Sync** — one toggle mirrors zoom and pan between Original and Result
  (they stay independent when it is off). The active viewport is highlighted
  and named in the status bar.
* **Toolbox** — collapsible sections: Source, Filters, Clusters, Analysis.
* **Toolbar / menus** — Open, Satellite, Export, Compress, Undo/Redo, Pan,
  Pixel, Measure, Sync, dock toggles; menus for File, **Edit** (Undo/Redo),
  View, Processing, Analysis, Help. One non-wrapping row: from 1600 px the
  words sit next to the icons, below that they drop to icons only, and a row
  that would still overflow compacts further rather than wrapping.
* **Help → Keyboard shortcuts / About** — two small modal dialogs (focus trap
  and Escape; no hostnames or developer notes in either). About names the
  product, its version and the Copernicus/OpenStreetMap credits.
* **Undo/redo** — the last 15 states are kept in the browser as Blobs, so
  undoing paints instantly without a server call; if the server has evicted
  that image (LRU), the stored Blob is re-uploaded and the step retried
  silently. Toolbar buttons, the **Edit** menu and `Ctrl+Z`/`Ctrl+Y` all drive it.
* **Zoom** — lives in exactly one place, the per-viewport footers (the toolbar
  duplicate was removed); the View menu keeps the same commands.
* **Map composer** — a large modal (toolbar **Map**, Analysis → *Map composer…*
  or a Classify run) that draws the classified image, its legend, a scale bar,
  a north arrow, the title/subtitle, the credit line and optional corner
  coordinates **on one canvas** — the preview *is* that canvas and the PNG
  export re-renders it at 1x/2x/3x. Legend names/colours are shared with the
  Clusters table.
  * **Legend placement**: Outside right (default), Outside left, Outside bottom
    left / center / right — every outside spot grows the canvas so the legend
    never covers the image — or on the map in one of the four corners. The box
    is measured for the longest class name, so nothing is ever truncated.
  * **Scale bar**: a label at every division boundary (0 … total with its unit),
    bottom left / center / right, 1–10 divisions, live. Exact when the image has
    a ground scale (the default length is a round number near a fifth of the
    width) or once you enter **Image width on the ground = …**; for an unscaled
    photo it is a plain black/white bar with no numbers, no unit and no
    invented distance.
  * **Sizes** start from the image (title largest, legend/scale labels about
    half the title, north arrow about 6 % of the image height) and every field
    stays editable inside its own limits.
  * **North arrow placement**: on the map in one of the four corners (top right
    by default) or outside — top right / top left / top center in the margin
    above the image, beside the title, which grows the export canvas. It never
    covers the title, the legend or the scale bar.
  * **Border**: always drawn; only its colour is a setting.
  * **Typing is safe**: the sidebar updates the model and repaints the canvas
    without rebuilding the field being typed in, so no keystroke is lost — in
    the composer's fields and in the Clusters table's class names alike.
* **Manual checks** — `docs/frontend-manual-checklist.md` lists what to confirm
  by hand in Chrome at 1366 px and 1920 px (rendering, downloads, gestures).
* **Shortcuts** — `Ctrl+O` open, `Ctrl+S` export PNG, `Ctrl+Z`/`Ctrl+Y`
  undo/redo, `+`/`−` zoom, `0` fit, `1` actual size, `M` measure, `P` pixel
  readout, `Y` sync viewers.
* **No stub entries** — every menu entry does something real. Entries that are
  unavailable *right now* (Export before an image, Clear result) are disabled
  and say why in their **tooltip** — never in wrapped text beside the label —
  and File → *Export raw label map* only appears once K-Means has run.
  File → *New session* asks for confirmation before discarding the session.
  The old "Recent files" / "Session images…" placeholders are gone.

## What it does

* **Source** — upload an image (drag & drop or file picker; JPEG/PNG/BMP/TIFF)
  or fetch a Sentinel-2 tile for an Islamabad sector/alias (F-8, NUST, …) with
  optional start/end dates.
* **Filters** — grayscale, negative, laplacian, brightness, threshold and mean
  filter. Each result is a new image id; the original is never overwritten.
* **Clusters** — K-Means (K 2–20, max iterations) with ranges, centroids and
  pixel counts, then a classify editor (per-cluster min/max, land-cover name,
  colour) that returns the recoloured image and legend percentages.
* **Analysis** — floating histogram windows (one per image, opened from the
  sidebar, each viewport footer or the Analysis menu) with the API's 256 bins,
  log scale, a 0…10 smoothing slider, Counts/Density/Cumulative, light/dark
  canvas, a Compare overlay and a browser-computed Channel dropdown
  (Gray/Red/Green/Blue/RGB overlay) — every option recomputed in the browser,
  no extra requests. Plus the distance tool for the active viewport, with
  px/mm/cm/m/km/inch/ft/mile units from a user-entered ground scale — and, for
  downscaled uploads, the distance at the original resolution as well.
* **Files** — GCH2 Huffman compress to `.gch` (desktop-compatible), decompress
  back into the session, and PNG export of the current image.
* **Assistant** — chat with the API's AI assistant; router commands such as
  `Show me F-8 imagery`, `Run k-means`, `Histogram` and `Compress this image`
  work even when the model is unavailable. Replies are shown as plain text.

## Run it (Windows PowerShell)

```powershell
# 1) API (separate terminal)
cd api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env      # paste FIREWORKS_API_KEY / COPERNICUS_* if you have them
uvicorn main:app --reload --port 8000

# 2) Frontend (this terminal)
cd web
python serve.py                  # http://localhost:5173
```

Open <http://localhost:5173>: the right side of the title bar shows the API
address, the session and whether the AI/satellite credentials are configured
on the server; the status bar at the bottom shows the image dimensions, the
channel layout, zoom, cursor position, pixel value and the active viewport.

## Run it (macOS / Linux)

```bash
cd api && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && cp .env.example .env
uvicorn main:app --reload --port 8000     # terminal 1
cd web && python3 serve.py                # terminal 2 -> http://localhost:5173
```

## Where the API request goes

The frontend picks its API base in this order:

1. `?api=…` on the page URL,
2. `localStorage.geocluster.apiBase`,
3. the page's hostname — **localhost** pages call `http://localhost:8000`
   directly (the normal dev flow, allowed by the API's CORS list); any other
   host uses the same-origin **`/api`** path.

`serve.py` forwards `/api/*` to the backend, so the page works when the
browser is not on the machine running the API (hosted preview, another device
on the LAN, a reverse proxy). Browsers must never be told to call `localhost`
for a service that runs on the server — that would mean *their* machine.

```powershell
python serve.py                                   # /api/* → http://127.0.0.1:8000
python serve.py --api http://127.0.0.1:9000       # proxy another backend
python serve.py --no-proxy                        # static files only
```

## Configuration

| Setting | How |
| --- | --- |
| API address | `http://localhost:5173/?api=http://127.0.0.1:8000`, `?api=/api` (force the proxy), or `localStorage.geocluster.apiBase` |
| API port / credentials | `api/.env` (see `api/.env.example`) |
| CORS | only needed for the direct flow: serve the page from an origin listed in the API's `ALLOWED_ORIGINS` (defaults include localhost:5173). Hosted pages go through `/api`, which is same-origin — no CORS involved |
| Frontend port | `python serve.py --port 5174` — remember to add that origin to `ALLOWED_ORIGINS` |

Never put keys in `web/`: everything here is served to the browser verbatim.
The frontend only ever calls the API.

## Tests

```powershell
# logic tests (Node 18+; no browser, no API needed)
node --test "web/tests/*.test.mjs"

# static checks: assets, imports, no keys, no innerHTML, CORS (API optional)
python web/tests/smoke_test.py

# live contract check (API must be running on :8000)
python web/tests/integration_check.py

# boot test: runs the real UI in jsdom against the live API (needs jsdom)
npm install --prefix /tmp/geocluster-jsdom jsdom
node web/tests/boot_test.mjs --jsdom /tmp/geocluster-jsdom/node_modules
```

The boot test is optional but the strongest signal short of a real browser: it
loads `index.html`, boots `js/app.js`, uploads the fixture image through the
file input and then clicks through the filters, K-Means, the Clusters editor
table, classify → the Map composer modal (aria, focus trap, one-canvas export),
histogram/stats, GCH2 compress → decompress, the chat router commands and the
session-expired recovery path. It skips itself (exit 0) when jsdom or the API is
missing.

The two live suites exercise `/satellite/fetch` validation more often than the
default `SATELLITE_RATE_LIMIT_PER_MINUTE=5`, so when you run them back to back
start the API with a raised limit for that session (the limiter itself is
covered by `api/tests/test_rate_limit.py`): `SATELLITE_RATE_LIMIT_PER_MINUTE=60
python -m uvicorn main:app` — or wait a minute between runs.

Run it twice to cover both ways the page is served:

```powershell
node web/tests/boot_test.mjs --jsdom /tmp/geocluster-jsdom/node_modules
# hosted mode: the page is not on localhost, so every call goes through /api
node web/tests/boot_test.mjs --jsdom /tmp/geocluster-jsdom/node_modules `
     --page-host 5173-demo.e2b.app --web http://127.0.0.1:5173
```

`node --test` also works from inside `web/`: `node --test "tests/*.test.mjs"`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Banner "Can't reach the API…" | start the API (`uvicorn main:app --port 8000`) and confirm the base URL |
| Banner mentions `/api` and the server could not reach the API | the proxy target is down — start the API, or point `serve.py --api http://host:port` at the right one |
| Browser console shows a CORS error | the page's origin is missing from `ALLOWED_ORIGINS` (or you opened `file://`) — add the origin and restart the API |
| "Your session expired…" toast | expected after an API restart or 60 minutes idle — the image must be uploaded again |
| AI chip says "not configured" | `FIREWORKS_API_KEY` is missing in `api/.env`; commands still work |
| Satellite chip says "not configured" | `COPERNICUS_CLIENT_ID`/`SECRET` missing in `api/.env` |
| Chat answers 502 | the AI provider errored; commands still run — see `docs/frontend-notes.md` |

More detail (error mapping, chat rules, viewer behaviour, known issues) is in
[`docs/frontend-notes.md`](../docs/frontend-notes.md).
