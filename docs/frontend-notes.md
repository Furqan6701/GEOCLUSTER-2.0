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

### No internal ids in user-facing text

Toasts and status messages name the image, the operation and its size — never
the server's `image_id`: "Result — sample.jpg#negative (1600×1066)", not
"new image EkEkL0bUvBYg". A boot assertion collects every `/images/<id>` id the
session used and fails if any of them appears in a toast.

### Clusters editor layout and class names

* Each cluster is a **two-line grid row** (`grid-template-areas` on the table
  rows): the swatch and the land-cover name on the first line, Min / Max / %
  on the second. The number spinners are hidden (`appearance: textfield`) so a
  3-digit bound fits its column. At the default 272 px sidebar (238 px on small
  screens) the whole table fits without a horizontal scroller — the `.table-wrap`
  was removed from this section.
* Class names follow K: the API's land-cover presets at **K=5** only
  (`Shadows`, `Dark Trees / Forest`, …); every other K gets `Class 1` … `Class K`
  (`defaultClassNames()` / `defaultNameFor()` in `panels/clusters.js`).
* "Reset ranges" now resets **only the min/max values** — names and colours the
  user typed are carried into the re-render.

### The action gate (bug fix)

* Root cause of the "not-allowed" point-operation buttons: the Filters panel
  computed `disabled` inside its own `setBusy()`, which was called once at
  construction (no image yet → disabled) and afterwards only while *its own*
  requests ran. Arriving images (upload, satellite fetch, K-Means, classify,
  undo/redo, restored/revived image) never re-evaluated it, so the buttons only
  came back as a side effect of some unrelated request finishing.
* Fix: `js/gate.js` owns the single rule — a registered action is enabled iff a
  working image exists and no request is in flight — and re-evaluates every
  button after every state change (`image:loaded`, `image:cleared`,
  `operation:applied`, `history:changed`, `session:reset`) and whenever a
  request starts or ends. In-flight requests are counted per owner, so a
  finished request cannot clear another one's busy state.
* Filters (Grayscale/Negative/Laplacian/Clear result), Run K-Means and the
  Files image actions register with the gate; no panel sets `disabled` on them
  any more.

### Ground scale (item 5)

* `ImageOut` gained `bbox` and `meters_per_pixel`. `POST /satellite/fetch`
  fills them: the bbox the provider was asked for, and the metres one *stored*
  pixel covers (`resolution_m / scale`, so a downscale is included). Uploads
  report `null` — the API never invents a scale.
* Filters, K-Means and classify carry them (`derive_ground_metadata()`), with
  `meters_per_pixel` multiplied by the size change, so a derived image is
  measured as accurately as its source.
* The frontend keeps that metadata with every history state and re-applies it
  when an evicted image is re-uploaded (`carryGroundMetadata()`), so the Map
  composer's scale bar stays exact after a restore. Without metadata the
  composer says “not to scale” and offers “image width = X unit”.

### Map composer (implemented)

* **One canvas, one renderer.** `js/mapstudio.js` draws everything — image,
  legend, scale bar, north arrow, title/subtitle, credit and corner
  coordinates — into a single canvas. The modal shows that canvas and the PNG
  export re-renders it at 1x/2x/3x, so the file can never disagree with the
  preview. `js/map.js` keeps only `mapCanvasToBlob`, `mapFileName` and
  `formatPercentage`; the old second composer is gone.
* **The modal** (`js/mapstudio_ui.js`, markup appended to `<body>`): live
  preview centre, properties sidebar right, `role="dialog"` + `aria-modal` +
  `aria-labelledby/-describedby`, Escape closes, Tab is trapped, focus returns
  to the opener, and the backdrop closes on click. The toolbar **Map** button,
  **Analysis → Map composer…**, **View → Map composer…** and a Classify run
  all open it; **Analysis → Map legend** toggles the legend without opening it.
* **Defaults:** title = the image name without its extension, subtitle blank,
  credit “Contains modified Copernicus Sentinel data” for satellite images
  (blank for uploads), legend on with percentages and the "Legend" title,
  scale bar on with 4 alternating black/white divisions, north arrow on
  (classic style, 0°, top right), background `#0d1115`, border on, corner
  coordinates off. Settings persist for the session inside `MapStudio`.
* **Scale:** the length defaults to a 1/2/5 round number for about a quarter
  of the ground width, in m/km/ft/mi (auto-picking km above a kilometre when
  the user has not chosen). With `meters_per_pixel`/`bbox` (item 5) the bar is
  exact; without them it is labelled **not to scale** until the user types
  “image width = X unit”. Satellite crops are north-up, so the arrow defaults
  to 0°.
* **Legend sync:** the composer's class names/colours and the Clusters table
  are two views of the same rows — edits in either one are pushed to the other
  over the bus (`map:legend-rows` / `clusters:changed`).

### Histogram options and distance units (STEP 5)

* `js/histogram.js` owns every display option: **log scale**, **smoothing**
  (moving average over 3/5/9 bins), **cumulative**, **density** (share of
  pixels) and a **light/dark canvas**. They are applied in that fixed order to
  the same 256 integer bins the API returned, so switching one costs no
  request — the module has no `fetch`, no `await` and no API import at all.
* *Export PNG* repaints the chart as it is shown now, on a 2× canvas
  (1040×340), with a title line naming the image and the active options, so the
  PNG is self-describing.
* Distance: the viewer measures image pixels; the Analysis ▸ Distance controls
  pick a unit (**px / mm / cm / inches**) and, for real units, the calibration
  the user types in (*pixels per unit*, e.g. 200 px/cm). Both numbers are
  labelled: the value *on screen* and — when the upload was downscaled — the
  value *at the original resolution*, which is `pixels / scale` using the
  `scale` from the upload response. Without a calibration number the UI asks
  for it instead of inventing one.

### Menu honesty (STEP 6)

Every entry in File / View / Processing / Analysis / Help does something real.
The never-implemented *Recent files* entry was removed and replaced by
*Session images…*, which reveals the Source section (the list it was standing in
for). Nothing in the menus says "not implemented", "planned" or "coming soon".

Entries that are unavailable **right now** are disabled and carry the reason in
their tooltip — e.g. Export without an image ("load, fetch or decompress an
image first"), Clear result with no result ("there is no result yet — run a
filter or K-Means first"), and the map entries before a classification ("run
Classify in the Clusters section first — the map is its output"). The toolbar
buttons explain themselves the same way, and a boot test asserts that no
disabled entry anywhere is missing its reason.

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
* The Clusters panel is one editor table (Color / Land cover / Min / Max /
  % of pixels) with **Classify** and **Reset ranges**; the Last run table, the
  centroid line, the separate legend block and every hint line are gone.
  K-Means always displays the clustered image — there is no image/label toggle
  — and the raw label map (which the API already stores as `kmeans:labels`) is
  downloaded from the Files panel's "Download raw label map (PNG)…". Max
  iterations is not user-facing: the panel always sends `max_iter=100` and K is
  limited to 2..10.
* Operations triggered from the chat carry no numbers, so documented defaults
  are used and announced in the chat log: `kmeans {k: 5, max_iter: 100}`,
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
  user picked them (the date inputs live under the collapsed **Advanced** fold
  and are empty by default → no placeholder text is ever sent). Bad values come
  back as `502` with an `"Invalid date …"` message, which maps to a friendly
  toast. An unknown location is a `404` — but only when the server has
  Copernicus credentials; an unconfigured server answers `503` *before* any
  place lookup, so it never calls Nominatim for nothing.
* The Source panel offers **Place** (sector code, alias or any place name, plus
  a 1/2/5 km size box, default 2) and **Coordinates** (two `lat, lon` corners
  pasted from Google Maps, sorted server-side) modes. A place that is not a
  known sector/alias is geocoded by the API through Nominatim — the **center
  point only**; its bbox is never used. Requests are throttled to 1/s, carry a
  proper User-Agent, are cached on disk, and the cache key includes the bbox,
  the size and the date window (so Refresh is meaningful).
* Satellite crops are requested at 10 m per pixel, so a 5 km tile is 500×500 px
  (0.25 MP) — far below the 4 MP downscale limit, i.e. satellite images are
  never silently downscaled. A test asserts this.
* The old "Working image" metadata block and "Session files" list are gone from
  the Source panel; the logic behind them (`renderFiles`, `useAsOriginal`) is
  still there for the rest of the app, it is simply not rendered any more.

## Filters panel (Step 3 of the redesign)

* Grey hint lines under the controls are gone. There are **five** small
  **"?"** buttons: one on the Filters section head (how filters combine), one
  next to the **POINT OPERATIONS** label, and one each for Brightness,
  Threshold and Mean filter. Each opens a popover above its heading (flipping
  below when there is no room), with `aria-expanded` / `aria-controls`, focus
  moved into the popover, and Escape (or a second click, or an outside click)
  closing it and returning focus. The popover is portaled to `<body>` with
  fixed coordinates so the scrolling toolbox cannot clip it.
* The POINT OPERATIONS popover lists the four entries together, one per line
  with the name in bold — Grayscale, Negative, Laplacian and Clear result —
  built from DOM nodes by `ui.helpList` (a `<ul>` of `<li><strong>name:</strong>
  text</li>`); no markup is ever parsed. Grayscale, Negative, Laplacian and
  Clear result are therefore a clean 2 × 2 button grid at full width again,
  with no individual "?" beside them.
* Brightness (−255…255), Threshold (0…255) and Mean filter (labelled **Kernel
  size**, odd 3…31, shown as "5 x 5") are sliders with a synced number field —
  no Apply button. Dragging paints a **browser-side preview** of the operation
  in the Result viewport (`js/preview.js`, downscaled to 512 px for big images)
  using the already-cached Blob: **no requests, no history entries**. On release
  exactly one request is sent and exactly one undo step is recorded. Releasing
  at the starting value does nothing. Arrow keys preview while held and commit
  after a short pause; the number field commits on Enter or blur; Escape during
  a drag cancels and restores the previous value.
* Re-releasing the same slider **replaces** its step instead of stacking: every
  release re-runs the operation against the image as it was before the first
  touch (`baseId`), and the previous step of that adjustment is dropped from the
  history before the new one is recorded, so the slider session leaves exactly
  one entry. Any other action (another operation, K-Means, undo/redo, a new
  image) ends the adjustment and puts the sliders back to their defaults.
  Docked sliders never run at the same time: touching another one ends the first.
* The preview is a downscaled approximation: OpenCV's 8-bit mean filter uses a
  fixed-point reciprocal per pass, so smoothing can differ from the committed
  result by one grey level. The committed pixels always come from the server.
* **Help-text check (resolved):** the Threshold text matches the implementation
  (`cv2.threshold(…, 255, THRESH_BINARY)` per BGR channel, alpha preserved,
  strictly `> value`). The Clear-result wording mismatch recorded in the Step 3
  report is **fixed**: the text is now "Clears the result viewport. The original
  image and the undo history are not affected.", which is exactly what
  `clearResult()` does (it empties the Result viewport; the working image and
  the undo history are untouched).

## Verification / tests

| Command | What it does |
| --- | --- |
| `node --test "web/tests/*.test.mjs"` | 72 logic tests: config resolution, error mapping, API client contract (URLs, bodies, multipart, session recovery), chat command mapping/execution, the satellite request shapes, the filter preview maths (reflect-101 box average, threshold/brightness clipping, the 512 px preview cap), the slider snapping/help texts, the grouped point-operation help list and the history `dropEntry` replacement rule. No browser needed. |
| `python web/tests/smoke_test.py` | Serves `web/` on 5173 (reuses a running server for the same root), checks assets + content types, that every relative module import resolves, that no key material exists under `web/`, that no `innerHTML` is used, the workstation layout contract (image workspace owns the flexible track, no `object-fit: cover`, technical corner radii), and that the API's CORS allows the frontend origin. |
| `python web/tests/integration_check.py` | Live contract check against a running API: the exact call sequence the browser makes (session → upload → 6 filters → kmeans k=5 → classify → histogram → stats → GCH2 round trip → satellite validation and error paths → chat commands → 404/415). The three checks that need real Copernicus credentials report SKIP when the server has no `api/.env` instead of failing. Requires `uvicorn main:app --port 8000`. |
| `node web/tests/boot_test.mjs --jsdom <dir>` | Boot test: loads `index.html` in jsdom, imports `js/app.js` and drives the UI through DOM events against the live API — 378 assertions covering the shell (menu bar, toolbar, status bar, dock collapse), viewport behaviour (pan, wheel zoom, pixel readout, distance measurement, sync mirroring), upload, the six filters, the Source panel's place/corner modes, the Filters panel's popovers and slider sessions (preview without requests, one request per release, replace-not-stack, Escape, arrow-key commits, one slider at a time), the rendered K-Means range table, classify, histogram/stats, GCH2 compress → decompress, PNG export, chat router commands, session-expiry recovery, and a clean browser console. jsdom is optional (not a dependency of the app); without it the test skips. |

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
