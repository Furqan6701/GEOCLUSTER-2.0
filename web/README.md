# GeoCluster 2.0: web frontend

> **Setup and first run:** see the [root README](../README.md). This file is the
> technical reference for the frontend: its layout, its features, how it finds the
> API, and its tests.

Static HTML, CSS and JavaScript for the GeoCluster API (`api/`). There is no build
step, no framework and no keys: the browser talks straight to the API.

The UI is laid out like desktop remote-sensing software (QGIS or ENVI style)
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

## Layout and interaction

* **Image workspace first.** The two viewports own the flexible grid track. The
  toolbox and assistant are fixed-width docks that can be collapsed, and their
  width then goes back to the imagery. At narrow widths the viewports stack.
* **Viewports, not cards.** Dark image-processing panes, a framed image,
  fit-to-view with the aspect ratio kept, cursor-anchored wheel zoom, drag
  panning, nearest-neighbour pixels at 1:1 or larger, a pixel readout, distance
  measurement, the image name and dimensions in the header, and the zoom percentage
  in the footer.
* **Sync.** One toggle mirrors zoom and pan between Original and Result. They stay
  independent when it is off. The active viewport is highlighted and named in the
  status bar.
* **Toolbox.** Collapsible sections: Source, Filters, Clusters, Analysis.
* **Toolbar and menus.** Open, Satellite, Export, Compress, Undo and Redo, Pan,
  Pixel, Measure, Sync and dock toggles. Menus for File, Edit (Undo and Redo), View,
  Processing, Analysis and Help. The toolbar is one non-wrapping row: from 1600 px
  the words sit next to the icons, below that they drop to icons only.
* **Help.** Keyboard shortcuts and About are two small modal dialogs with a focus
  trap and Escape to close. About names the product, its version and the
  Copernicus and OpenStreetMap credits.
* **Undo and redo.** The last 15 states are kept in the browser as Blobs, so
  undoing paints instantly without a server call. If the server has evicted that
  image (least recently used), the stored Blob is uploaded again and the step is
  retried silently. The toolbar buttons, the Edit menu and `Ctrl+Z` and `Ctrl+Y` all
  drive it.
* **Zoom.** Lives in one place: the per-viewport footers. The View menu offers the
  same commands.

## Features

* **Source.** Upload an image (drag and drop or the file picker), or fetch a
  Sentinel-2 crop for a sector or alias (F-8, NUST and others) with optional start
  and end dates. A place can also be given as coordinates (two corners).
* **Filters.** Grayscale, negative, Laplacian, brightness, threshold and mean
  filter. Each result is a new image id; the original is never overwritten. The
  brightness and threshold sliders preview in the browser while you drag, and the
  server's result replaces the preview on release.
* **Clusters.** K-Means (K from 2 to 20, with a maximum number of iterations),
  with ranges, centroids and pixel counts. A classify editor (per-cluster min and
  max, land-cover name, colour) returns the recoloured image and legend percentages.
* **Analysis.** Floating histogram windows (one per image, opened from the sidebar,
  each viewport footer or the Analysis menu) with the API's 256 bins, a log scale,
  a 0 to 10 smoothing slider, Counts, Density or Cumulative, a light or dark canvas,
  a Compare overlay and a Channel dropdown (Gray, Red, Green, Blue or RGB overlay).
  Every option is recomputed in the browser with no extra requests. The distance
  tool measures in pixels or in px, mm, cm, m, km, inch, ft and mile units from a
  ground scale that the user enters. For downscaled uploads it also shows the
  distance at the original resolution.
* **Files.** GCH2 Huffman compression to `.gch` (desktop-compatible), decompression
  back into the session, and PNG export of the current image.
* **Map composer.** A large modal (toolbar Map, Analysis, Map composer, or a
  Classify run). It draws the classified image, its legend, a scale bar, a north
  arrow, the title and subtitle, the credit line and optional corner coordinates
  on one canvas. The preview is that canvas, and the PNG export re-renders it at
  1x, 2x or 3x. Legend names and colours are shared with the Clusters table.
  * **Legend placement:** outside right (default), outside left, outside bottom
    left, centre or right (the canvas grows so the legend never covers the image),
    or on the map in one of four corners.
  * **Scale bar:** a label at every division boundary, bottom left, centre or
    right, with 1 to 10 divisions, updated live. It is exact when the image has a
    ground scale, or once you enter the image width on the ground. For an unscaled
    photo it is a plain black and white bar with no numbers and no invented distance.
  * **North arrow:** on the map in one of four corners, or outside in the margin
    above the image (top right, top left or top centre). It never covers the title,
    the legend or the scale bar.
  * **Typing is safe.** The sidebar updates the model and repaints the canvas without
    rebuilding the field being typed in, so no keystroke is lost.
* **Assistant.** Chat with the API's AI assistant. Router commands such as
  `Show me F-8 imagery`, `Run k-means`, `Histogram` and `Compress this image` work
  even when the model is unavailable. The model can also run a tool for you with
  the value you asked for (for example, `Smooth this image with a 5 by 5 mean
  filter`). Every action is one of the app's own controls and runs through the same
  code path as that control, so the undo history, the result viewport and the toasts
  behave identically. The parameter is validated on the server first. Replies are
  shown as plain text, never as HTML.
* **Shortcuts.** `Ctrl+O` open, `Ctrl+S` export PNG, `Ctrl+Z` and `Ctrl+Y`
  undo and redo, `+` and `-` zoom, `0` fit, `1` actual size, `M` measure, `P` pixel
  readout, `Y` sync viewers.
* **No stub entries.** Every menu entry does something real. Entries that are
  unavailable right now (Export before an image, Clear result) are disabled, and
  their tooltip says why. File, Export raw label map, appears only once K-Means has
  run. File, New session asks for confirmation before it discards the session.
* **Manual checks.** [`docs/frontend-manual-checklist.md`](../docs/frontend-manual-checklist.md)
  lists what to confirm by hand in Chrome at 1366 px and 1920 px (rendering,
  downloads, gestures).

## Where the API request goes

The frontend picks its API base in this order:

1. `?api=...` on the page URL.
2. `localStorage.geocluster.apiBase`.
3. The page's hostname. **localhost** pages call `http://localhost:8010` directly
   (the normal local flow, allowed by the API's CORS list). Any other host uses the
   same-origin **`/api`** path.

`serve.py` forwards `/api/*` to the backend, so the page also works when the browser
is not on the machine running the API (a hosted preview, another device on the
network, a reverse proxy). A browser must never be told to call `localhost` for a
service that runs on the server, because that would mean the visitor's own machine.

`serve.py` is the fastest loop when you are only editing the frontend:

```bash
python web/serve.py                                  # /api/* -> http://127.0.0.1:8010, page on :5173
python web/serve.py --api http://127.0.0.1:9000      # proxy another backend
python web/serve.py --no-proxy                       # static files only
```

On Windows, run the same commands with `python web\serve.py`. Open
<http://localhost:5173/> for this mode. The API must be running on port 8010.

## Configuration

| Setting | How |
| --- | --- |
| API address | `http://localhost:8010/?api=http://127.0.0.1:8010`, `?api=/api` (force the proxy), or `localStorage.geocluster.apiBase` |
| API port and credentials | `api/.env` (see `api/.env.example` and [`api/README.md`](../api/README.md)) |
| CORS | Only needed for the direct flow: serve the page from an origin listed in the API's `ALLOWED_ORIGINS`. Pages served through `/api` are same-origin, so CORS does not apply |
| Frontend port (`serve.py`) | `python web/serve.py --port 5174` (or `WEB_PORT`). Add that origin to `ALLOWED_ORIGINS` if the page calls the API directly |

Never put keys in `web/`: everything here is served to the browser verbatim. The
frontend only ever calls the API.

## Tests

Run these from the repository root. On Windows, use the venv Python from the
[root README](../README.md#step-1-create-the-virtual-environment-and-install-the-requirements).

**Logic tests** (Node 18 or newer; no browser and no API needed):

```bash
node --test web/tests/logic.test.mjs
```

**Static checks** (assets, imports, no keys, no `innerHTML`, CORS; the API is optional):

```bash
python web/tests/smoke_test.py
```

**Live contract check** (the API must be running on port 8010):

```bash
python web/tests/integration_check.py
```

The two live suites exercise `/api/satellite/fetch` validation more often than the
default limit of `SATELLITE_RATE_LIMIT_PER_MINUTE=5`. When you run them back to
back, start the API with a higher limit for that session (the limiter itself is
covered by `api/tests/test_rate_limit.py`), or wait a minute between runs.

**Boot test** (the real UI in jsdom against the live API). jsdom is not a dependency
of the app. Install it in a folder of your choice, outside the repository:

macOS and Linux:

```bash
npm install --prefix ~/geocluster-jsdom jsdom
node web/tests/boot_test.mjs --jsdom ~/geocluster-jsdom/node_modules
```

Windows PowerShell:

```powershell
npm install --prefix "$env:USERPROFILE\geocluster-jsdom" jsdom
node web\tests\boot_test.mjs --jsdom "$env:USERPROFILE\geocluster-jsdom\node_modules"
```

The boot test also looks for `GEOCLUSTER_JSDOM` (the `node_modules` folder) and for
a global `jsdom` install. Without jsdom it skips itself and exits with code 0.

It loads `index.html`, boots `js/app.js`, uploads the fixture image
(`api/tests/fixtures/sample.jpg`) through the file input, and then clicks through the
filters, K-Means, the Clusters editor table, classify and the Map composer modal (aria,
focus trap, one-canvas export), histogram and stats, GCH2 compress and decompress,
the chat (router commands, the app state sent with each message, a model-chosen
action run through the panel's own action, and the plain-text refusal when nothing
is loaded), and the session-expired recovery path.

Run it twice to cover both ways the page is served. The first run is the local flow
(the page on localhost, calls go straight to the API). The second run is the hosted
flow, where the page is on a non-local host and every call goes through `/api`. It
needs `python web/serve.py` running on port 5173, which forwards `/api` to the API:

macOS and Linux:

```bash
node web/tests/boot_test.mjs --jsdom ~/geocluster-jsdom/node_modules --page-host app.example.com --web http://127.0.0.1:5173
```

Windows PowerShell:

```powershell
node web\tests\boot_test.mjs --jsdom "$env:USERPROFILE\geocluster-jsdom\node_modules" --page-host app.example.com --web http://127.0.0.1:5173
```

`app.example.com` is a placeholder. Any hostname that is not `localhost` works.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Banner "Can't reach the API..." | Start the API (see the root README, step 4) and check the base URL. |
| Banner mentions `/api` and the server could not reach the API | The proxy target is down. Start the API, or point `serve.py --api http://host:port` at the right one. |
| Browser console shows a CORS error | The page's origin is missing from `ALLOWED_ORIGINS`, or you opened `file://`. Add the origin and restart the API. |
| "Your session expired..." toast | Expected after an API restart or 60 minutes of inactivity. Upload the image again. |
| AI chip says "not configured" | `GROQ_API_KEY` is missing in `api/.env`. Commands still work. |
| Satellite chip says "not configured" | `COPERNICUS_CLIENT_ID` or `COPERNICUS_CLIENT_SECRET` is missing in `api/.env`. |
| Chat answers 502 | The AI provider errored. Commands still run. |

Error handling, chat rules and viewer behaviour are described in the sections
above.
