# Frontend notes (web/)

Operational notes for the GeoCluster web console: how it talks to the API,
what it does when things go wrong, and the known issues we deliberately left
alone. Everything here was verified against the API in this repository.

## UI structure (workstation redesign)

The frontend is a desktop-style workspace, not a dashboard:

| Region | Contents |
| --- | --- |
| Title bar | GeoCluster 2.0, menu bar (File · View · Processing · Analysis · Help), status chips (API, session, AI, satellite, max MP) |
| Toolbar | Open · Satellite · Export · Compress · Undo/Redo · Pan · Pixel · Measure · Sync · dock toggles (single non-wrapping row; labels collapse to icons below 1440 px) |
| Toolbox dock | collapsible sections: Source, Filters, Clusters, Analysis, Files (every control from the previous panels, unchanged in behaviour) |
| Image workspace | up to three viewports — **Original**, **Result** and **Map** (hidden until a classification exists) — each with a header (name + dimensions + active tool) and a footer (Fit/1:1/±/Distance, zoom %, pixel readout); the Map footer also toggles its legend |
| Assistant dock | scrollable conversation, quick-command buttons, compact input; collapsible |
| Status bar | dimensions · channel layout · zoom · cursor X/Y · pixel value · active viewport · session · API · New session |

Viewports are canvases, never cards: fit-to-view preserves the aspect ratio,
there is no `object-fit` anywhere, zoom is cursor-anchored, pixels stay crisp
(nearest-neighbour) at ≥1:1, and small 260×260 satellite tiles are upscaled to
fill the pane rather than being shown as thumbnails.

### Synchronised navigation

View → *Synchronise Original ↔ Result* (toolbar **Sync**, shortcut `Y`) makes
camera changes (zoom and pan) mirror from one viewport to the other. It is a
frontend feature only — both viewports hold their own decoded bitmap, so no
API support is needed. With sync off each viewport navigates independently.
Camera changes are announced on the bus as `viewer:camera`, which is also what
the status bar uses.

### Tool states

`Pan`, `Pixel` and `Measure` are explicit tools with `aria-pressed` state, a
cursor that reflects them, and a badge in the viewport header showing which is
active. Turning the pixel readout off stops the footer/status-bar readout but
never affects zoom or pan. The viewport's own `Distance` button and the toolbar
`Measure` button stay in step through the `viewer:distance-mode` event.

### Undo / redo (implemented client-side)

The API has no operation history (every operation returns a new image id), so
history lives in the browser: `js/history.js` keeps the last **15 displayed
states**. Each state stores a label, the server image id, the image info and —
once the viewer has fetched it — the **Blob** itself, plus a snapshot of both
viewport slots so "Clear result" is undoable too.

* Toolbar **Undo/Redo**, File → Undo/Redo, `Ctrl+Z` and `Ctrl+Y` (`Ctrl+Shift+Z`
  also redoes). Disabled states explain themselves in the tooltip.
* Restoring paints the stored Blob: **no server request** is made.
* Sessions keep only a few images (LRU). If a state's id has been evicted, the
  operation that needs it gets a 404, `SessionManager.withImage()` silently
  re-uploads the stored Blob (`revive()` in `app.js`), re-points every history
  entry that referenced the old id and retries the call once — the user sees
  nothing. Old Blobs are released after 24 images to bound memory.
* Starting a new session clears the history (server ids are gone).

### Map view (implemented)

The classify step returns a recoloured image plus a legend
(`cluster, name, colour, min, max, count, percentage, label`), so the Map
viewport is a real product of the pipeline, not a placeholder:

* `js/map.js` draws the classified image **and** its legend onto one canvas:
  swatch + class name + percentage per row, panel beside the image when it
  fits, underneath when it does not (260×260 satellite tiles with 20 classes,
  letterbox images). Long names are ellipsised, colours are normalised.
* That canvas is what the Map viewport shows, so **Map export** writes a single
  PNG that already contains the legend — the same canvas, `toBlob("image/png")`,
  named `map-<source>.png`.
* Analysis → *Map view* / *Map legend* / *Map export*, the toolbar **Map**
  toggle and View → *Show map viewport* all drive it. The legend toggle
  recomposes the canvas with or without the panel, and the export follows it.
* Classify opens the Map view automatically; with three panes the workspace
  puts the map on a full-width row under the two image panes below 1500 px, and
  undoing past the classification hides it again.
* No new requests: the classified image comes from the session Blob cache and
  everything else is canvas work in the browser.

### Deliberately not implemented

Recent files appears as a **disabled entry with a reason** instead of a fake
button: session images are listed in the Source section instead.

## Serving and CORS

* Serve `web/` on **http://localhost:5173**:
  `python web/serve.py` (or `python -m http.server 5173` from `web/`).
* The browser must reach the API cross-origin, so the API's `ALLOWED_ORIGINS`
  has to include the exact origin the page is served from. The defaults (and
  the values in `api/.env.example`) include:

  ```
  http://localhost:3000, http://localhost:5173, http://localhost:8000,
  http://127.0.0.1:3000, http://127.0.0.1:5173, http://127.0.0.1:8000
  ```

* Verified in this environment: preflight (`OPTIONS` + `Access-Control-
  Request-Method: POST` + `Access-Control-Request-Headers: content-type`) and
  the actual image upload/download responses all return
  `access-control-allow-origin: http://localhost:5173`; a request from an
  unlisted origin (`http://localhost:9999`) gets **no** allow-origin header, so
  the browser blocks it.
* **Nothing was blocked for the documented setup.** Two ways to break it by
  accident: (1) serving the page from a port that is not in
  `ALLOWED_ORIGINS` — add it to `api/.env` and restart the API, or (2) opening
  `index.html` via `file://`, where the browser sends `Origin: null` and CORS
  fails. Always use the dev server.
* If the API runs somewhere else, point the page at it without editing code:
  `http://localhost:5173/?api=http://127.0.0.1:9000` or
  `localStorage.setItem("geocluster.apiBase", "http://127.0.0.1:9000")`.

### Two serving modes (and why CORS is only half the story)

Browsers resolve `localhost` to the **user's** machine, so a page that is not
served from the dev box must never call `http://localhost:8000` — that request
would go to the visitor's own computer. `resolveApiBase` therefore picks:

| Page host | API base | Path |
| --- | --- | --- |
| `localhost` / `127.0.0.1` (the documented dev flow) | `http://localhost:8000` | direct call, needs CORS |
| anything else — hosted preview, LAN, reverse proxy | `/api` | `serve.py` proxies `/api/*` to the backend (same-origin, no CORS) |

`serve.py` has `--api <base>` (proxy target, default `http://127.0.0.1:8000`)
and `--no-proxy`. Verified live: `/api/health`, `POST /api/sessions`, API error
bodies (the 404 `detail` survives), the 405 for POSTs to static paths, a 502
with a friendly `detail` when the backend is down while static files keep
serving, and byte-identical PNG/GCH downloads through the proxy. The boot test
runs in both modes (see the table below).

## Sessions (server memory, 60-minute TTL)

Sessions live in the API process: a server restart or the TTL (60 minutes)
wipes them, and any call can then answer `404` with
`"Unknown or expired session: …"`.

The frontend detects exactly that case (`ApiError.isSessionExpired`), then:

1. starts a new session automatically (`POST /sessions`),
2. drops the local image state and clears both viewers,
3. tells the user: *"Your session expired (the server restarted or the
   60-minute limit passed). A new session was created — please upload your
   image again."*

The attempt is **not** retried, because the image no longer exists server-side.
The `New session` button does the same thing on demand. Per-session image
eviction (default 6 images, least-recently-used) is handled the same way: the
missing image surfaces as a 404 and the user re-uploads.

## Error mapping (never raw JSON)

| HTTP | UI text (abridged) |
| --- | --- |
| transport failure | "Can't reach the API at … Make sure the backend is running (uvicorn main:app --port 8000)…" plus a banner |
| 400 | the server's `detail` |
| 404 | the server's `detail` (e.g. "Unknown image: …") |
| 413 | "That file is too large for the server." |
| 415 | "That file isn't a supported image (JPEG, PNG, BMP or TIFF)." |
| 422 | "Please check these values — value: Input should be less than or equal to 255; window: window must be an odd number" |
| 429 | "Too many requests — wait a moment and try again." |
| 502 | "The provider is unavailable right now. Try again shortly." |
| 503 | "That feature isn't configured on the server." |
| 507 | "The server's image memory is full. Try again or restart the API." |

Error bodies are `{"detail": …}`; for 422 the detail is a list and the UI
flattens it to `field: message` pairs. Non-JSON bodies fall back to a status
message. Raw JSON is never displayed.

## Chat behaviour

* Replies render with `textContent` (no `innerHTML` anywhere in `web/` — the
  smoke test enforces this). LaTeX such as `\[ ... \]` therefore appears as
  plain text; math is intentionally **not** rendered.
* The rule-based router needs no language model, so commands execute even when
  the model is unavailable:
  * `Show me F-8 imagery` → `{"action": "fetch_satellite", "location": "F-8"}`
  * `Run k-means` → `{"action": "run_operation", "operation": "kmeans"}`
  * `Histogram` → `{"action": "open_histogram"}`
  * `Compress this image` → `{"action": "open_compress"}`
  * `Measure the distance` → `{"action": "open_distance"}`
* If the provider fails (`502`) the chat shows a friendly bubble
  ("The AI assistant is unavailable right now…") and still runs any commands
  that came back with the same message. A missing key (`503`) gets its own
  message pointing at the commands that work without the model.
* Operations triggered from the chat carry no numbers, so documented defaults
  are used and announced in the chat log: `kmeans {k: 5, max_iter: 30}`,
  `meanfilter {window: 3}`, `threshold {value: 128}`, `brightness {value: 20}`.
  The panels remain the place to pick other values.
* `open_distance` is **client-side**: the API has no distance endpoint, so the
  viewer measures the Euclidean pixel distance between two clicks (Esc clears).

## Image handling

* Uploads are validated by the server (magic bytes + decode): JPEG, PNG, BMP
  and TIFF only; the UI surfaces 415/413 verbatim through the error mapping.
* Images above `MAX_IMAGE_MEGAPIXELS` (default 4) are downscaled by the
  server; the Source panel shows the original size, the stored size and the
  scale factor so the downscale is never silent.
* Every operation returns a **new** image id; the original is never
  overwritten. "Original" and "Result" are separate viewers, and the result
  becomes the input for the next operation (like the desktop).
* The viewer fits images to the pane (including upscaling the 260×260
  satellite tiles), then disables smoothing at ≥1:1 so zoomed-in pixels are
  crisp nearest-neighbour squares; wheel zooms at the cursor, drag pans, `1:1`
  and `Fit` are buttons, and the footer shows zoom %, cursor position and the
  RGB/gray value under the pointer.
* Satellite dates: `start`/`end` are optional and are **only** sent when the
  user picked them (the date inputs are empty by default → no placeholder text
  is ever sent). Bad values come back as `502` with an `"Invalid date …"`
  message, which maps to a friendly toast. An unknown location is a `404`.

## Verification / tests

| Command | What it does |
| --- | --- |
| `node --test "web/tests/*.test.mjs"` | 28 logic tests: config resolution, error mapping, API client contract (URLs, bodies, multipart, session recovery), chat command mapping/execution. No browser needed. |
| `python web/tests/smoke_test.py` | Serves `web/` on 5173 (reuses a running server for the same root), checks assets + content types, that every relative module import resolves, that no key material exists under `web/`, that no `innerHTML` is used, the workstation layout contract (image workspace owns the flexible track, no `object-fit: cover`, technical corner radii), and that the API's CORS allows the frontend origin. |
| `python web/tests/integration_check.py` | Live contract check against a running API: the exact call sequence the browser makes (session → upload → 6 filters → kmeans k=5 → classify → histogram → stats → GCH2 round trip → satellite error paths → chat commands → 404/415). Requires `uvicorn main:app --port 8000`. |
| `node web/tests/boot_test.mjs --jsdom <dir>` | Boot test: loads `index.html` in jsdom, imports `js/app.js` and drives the UI through DOM events against the live API — 96 assertions covering the shell (menu bar, toolbar, status bar, dock collapse), viewport behaviour (pan, wheel zoom, pixel readout, distance measurement, sync mirroring), upload, the six filters, the rendered K-Means range table, classify, histogram/stats, GCH2 compress → decompress, PNG export, chat router commands, session-expiry recovery, and a clean browser console. jsdom is optional (not a dependency of the app); without it the test skips. |

The boot test runs in both serving modes: the default (page on localhost →
direct API calls) and hosted (`--page-host 5173-demo.e2b.app` → everything
through the `/api` proxy, resolved against `--web http://127.0.0.1:5173`).

The boot test earned its place immediately: it caught a `ReferenceError` in
`Viewer._build()` (the constructor's `title` parameter was referenced outside
its scope) that made the page render nothing at all in a real browser while
every static check still passed. Fixed by storing the title on the instance.

`integration_check.py` asserts the K-Means ranges for `sample.jpg` with `k=5`
are `0–80, 81–117, 118–155, 156–194, 195–255`, matching the desktop result.

## Known issues we did not touch

* **`api/tests/test_memory.py` is Unix-only** — it imports the `resource`
  module, which does not exist on Windows, so the API test suite cannot run
  there without skipping it. Left alone on purpose; on Windows run
  `pytest api/tests -q --ignore=api/tests/test_memory.py` or add a local
  `-k "not memory"` filter. (This is a pre-existing backend issue, recorded
  here as requested.)
* **"FIREWORKS" naming** remains in the assistant code and its log messages
  (`api/geocluster/assistant.py`, `FIREWORKS_API_KEY`). Left as-is.
* The satellite **success** path was not exercised in the build sandbox (no
  Copernicus credentials there) — only the 503/404/502 paths. The 260×260 tile
  behaviour is confirmed by the user's local run.
* The AI **reply** path needs `FIREWORKS_API_KEY`; without it `/ai/chat`
  answers 503 for questions (commands still work). Verified by unit test with
  a stubbed client plus the user's local run.
* No browser automation runs in this environment, so the UI is verified by the
  module tests, the reference/import checks and the live API contract rather
  than by clicking. Serve it locally once to confirm the visuals.
