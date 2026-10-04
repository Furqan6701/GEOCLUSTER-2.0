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
| Toolbox dock | collapsible sections: Source, Filters, Clusters, Analysis (every control from the previous panels, unchanged in behaviour; the Files section became File-menu entries — item 12) |
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

### Distance (item 10)

The footer **Distance** button is a real toggle: `aria-pressed` is the single
source of its active look (the `.primary` class is gone, so nothing can leave it
highlighted), the label gains a ● and the tooltip changes while measuring, and
`_syncFooterState()` disables it (and the footer **Histogram** button) whenever
the viewport has no image — an "active looking" tool on an empty pane was the
reported bug.

* The sidebar's "Measure on the active viewport" button is gone (the toolbar
  Measure button and each viewport's own Distance button remain), together with
  every explanatory line — no "Client-only", no "the API has no distance
  endpoint", no "image was not downscaled".
* Controls: **Unit** (`UNIT_ORDER`: pixels, mm, cm, m, km, inches, ft, mi) and
  **Pixel size** — the ground length of ONE image pixel in the chosen unit.
  Satellite imagery pre-fills both from `meters_per_pixel` (metres, or
  kilometres for a coarse mosaic); an upload starts in pixels with the pixel
  size field hidden. Changing the unit CONVERTS the pixel size, so the ground
  size a pixel spans never changes behind the user's back. Both are re-filled
  when another image loads, because the pixel size describes that image.
* The latest measurement is **one line** — `Distance: 450.20 px` — with a
  **Clear** button. A ground unit without a pixel size asks for it in that same
  line rather than inventing a number, and the original-resolution pixel count
  is appended **only when the upload was actually downscaled**
  (`describeDistance`), e.g.
  `Distance: 500.00 px (1,000.00 px at the original resolution)`.
* Measuring is unchanged: two clicks in the active viewport, Esc clears (the
  viewer reports `viewer:distance-cleared`, so the panel's line empties too).

### Histogram windows (item 9)

The Analysis panel is now **one "Histogram" button plus the Distance controls**:
the inline canvas, the option row, the panel's Export button, the Statistics
block and every hint/status line are gone.

Pressing the button opens a **floating, non-modal, opaque window**
(`js/histowindow.js`, `.histo-layer` → `.histo-window`):

* draggable by its title bar, **✕** closes it, **Escape closes the focused
  window**, arrow keys move it (Shift = 64 px), Tab cycles inside, and focus
  lands on the title bar when it opens (`role="dialog"`, `aria-modal="false"`);
* **up to 4** at once (`MAX_WINDOWS`); a new one is tiled into the first free
  slot of a 560×420 grid so it never covers an open window (it cascades only
  when the screen has no free slot left), and the user can drag it anywhere;
* titled with its image, e.g. `Histogram: sample.jpg#negative`. The API already
  chains the step into derived names, so the suffix is only added when the name
  does not carry it (`targetTitle`), and very long chains are clipped to
  `head#…tail` (`clipTitle`);
* an **Image** dropdown: Original, Result and **every state in the undo
  history** (deduped by id, labelled the way the history labels them);
* a **large chart** (560×260) with clearly labelled controls — Image, Scale
  (Linear/Log), Smoothing (Off/Low/High), Display (Counts/Density/Cumulative),
  Theme (Dark/Light), **Export PNG** (2×) — plus the five statistics beside it
  (min, max, mean, std dev, pixel count) computed in the browser from the bins
  (`binStats`);
* a **Compare** dropdown that overlays a second image's bins as an outline in
  `#ffb454` with a two-row legend naming both images.

Bins are fetched **once per image** and cached in the manager, so changing any
option (or reopening a window for the same image) makes no request at all —
asserted in the boot test.

### North arrow and credit follow the image source (items 6 & 7)

`sourceDefaults(source, info)` decides: an image is "satellite imagery" when the
composer was opened with `source === "satellite"` **or** the image carries
ground metadata (`bbox` / `meters_per_pixel`) — so a classify/operation result
of a satellite crop keeps them, while a plain upload does not.

| source | north arrow | credit line |
| --- | --- | --- |
| satellite (or derived from one) | ON | "Contains modified Copernicus Sentinel data" |
| upload | OFF | empty |

A choice the user makes in the composer always wins and sticks for the session:
the checkbox handler sets `northArrowTouched`, the credit field sets
`creditTouched`, and `normalizeSettings` only re-applies the source default
while the matching flag is false. (A caller that passes `visible`/`credit`
without ever recording a choice counts as that choice.) The arrow keeps Style,
Size (px) and Position, and is drawn north-up — the Rotation control and
`northArrow.rotation` setting are gone.

### Legend placement (items 5 and 16)

* `legend.placement` replaces the old `legend.corner`. `LEGEND_PLACEMENTS` now
  holds **nine** entries — **Outside right (default)**, Outside left, Outside
  bottom left / center / right, and On map — top left / top right / bottom left
  / bottom right. Out-of-image placements carry `edge` (`left`/`right`/`bottom`)
  and, for the bottom band, `align` (`left`/`center`/`right`);
  `legendPlacementOf()` normalizes anything unknown back to the default, and the
  old `outside-bottom` key still resolves (to `outside-bottom-left`).
* The five outside placements **enlarge the composed canvas** instead of drawing
  over the image: `studioLayout()` measures the legend box at 1x, `frameMetrics()`
  adds a band (width for left/right, height for bottom) plus a 12 px gap, and
  exposes `legendArea` for the drawing code. All numbers stay integral at 1x and
  are multiplied by the export scale, so 2x/3x remain **exact** multiples and the
  legend can never cover a pixel of the map. Bottom-area offsets are computed at
  1x and then multiplied (rounding twice would drift a pixel at 3x).
* The band is `legendBox + 2 px` of slack, but `legendArea` is exactly the drawn
  box, so centre/right alignment lands where the box really is.
* **No class name is ever truncated:** `legendBoxSize()` measures the longest
  name with the very font the box is drawn with (the title and percentage column
  too) and `drawLegendBox()` draws the strings unclipped — the ellipsis path is
  gone from the legend.
  A legend that is hidden (or has no rows) reserves no space at all.
* The measurement is text-metric based (the same `legendBoxSize()` used for
  drawing, with the chosen font), plus 2 px of slack so rounding cannot clip
  the box border.

### Composer typography (item 4)

* **One font for every text on the canvas.** `MAP_FONTS` = Arial (default),
  Times New Roman, Georgia, Verdana, Courier New, Trebuchet MS. Every draw
  call goes through `fontSpec(size, { font, weight })`, which builds a valid
  CSS shorthand — `700 26px "Georgia", system-ui, sans-serif`. The comma
  matters: `"Georgia" system-ui sans-serif` is invalid CSS, and canvas
  silently keeps the PREVIOUS font instead of erroring. `mapFont()` maps an
  unknown family back to Arial.
* **A size per text** (all clamped by `normalizeSettings` to 8…96 px, the
  arrow to 12…160): title 26, subtitle 14, legend 14 (`legend.fontSize`),
  scale-bar label 12 (`scaleBar.fontSize`), credit 12. `frameMetrics()` takes
  those sizes so the title strip and the footer grow with the text — the frame
  can never clip a bigger title, and 2x/3x exports stay exact multiples.
* **Title options**: a bold toggle (`titleBold`, on by default) and
  left/center/right alignment (`titleAlign`, **center** by default, drawn at
  the top of the map). The subtitle follows the same alignment.
* The north arrow lost its Rotation control and setting; it now has a
  **Size** field (36 px default) instead, and is always drawn north-up.

### Map composer modal: opaque, and clear of the toolbar

* The dialog and its sidebar were **transparent**: `.map-modal-dialog`,
  `.map-modal-head`/`-foot`, `.map-modal-body` and `.map-props` asked for
  `var(--panel)` / `var(--panel-2)`, which were never defined — a typo for
  `--bg-panel` / `--bg-panel-2`. A missing custom property makes the whole
  declaration invalid, so the modal fell back to `background: transparent`
  and the workspace showed through. Every `var()` in `styles.css` is now
  defined (a smoke test fails on any undefined one) and the opaque surfaces
  also carry literal `background-color` fallbacks.
* The dialog used to start at `3vh` from the viewport top, i.e. **over** the
  page header/toolbar. `.map-modal` is now a fixed overlay with
  `padding-top: var(--map-modal-top, 104px)`, and `MapStudio._fitToViewport()`
  measures the real `.app-header` height (on open and on window resize) and
  writes `--map-modal-top`, so the composer's own header always starts below
  the toolbar.

### Classification editor — live linked ranges (item 11)

* **Ranges are always contiguous over 0..255.** `web/js/clusterranges.js` is the
  pure, unit-tested module that owns that rule: no gaps, no overlaps, at least
  one value per class, first class starts at 0 and last one ends at 255. The
  first Min and the last Max are rendered `readOnly` (and styled `.locked`) —
  the panel never lets them be edited. The API does not enforce contiguity;
  the client module is the only authority, and `normalizeEntries()` repairs
  anything the server or a kept editor hands back.
* **Editing moves exactly one neighbour, live.** `editMax(entries, i, v)` sets
  `max(i) = v` and `min(i+1) = v + 1`; `editMin` mirrors it onto `max(i−1)`.
  The table fields listen to `input`, so the link follows every keystroke —
  there is no Apply step. A keystroke whose value would empty a class or cross
  another one is **not** applied (the text stays in the field so typing can
  continue); Enter or blur **clamps** it into the valid window
  (`min(i) … max(i+1) − 1`, `min(i−1) + 1 … max(i)`) and writes the clamped
  number back.
* **The % column is computed, never fetched while editing.** The editor asks
  `GET …/histogram` **once per classified image** (`ensureBins()`), then
  `countsFromBins()` sums the 256 bins inside each range on every edit. Before
  the histogram arrives the K-Means counts are the fallback (identical numbers:
  K-Means counts its final ranges with the same inclusive masks).
* **The Result viewport recolours in the browser.** `buildLut()` makes a
  256-entry RGB table from the ranges and colours, `recolorPixels()` applies it
  to the preview-sized copy of the **classified source** image (OpenCV's
  `BGR2GRAY` weights are reproduced in `toGray()`), and the canvas goes out as
  the existing `preview:show` event — the same path the filter sliders use, so
  the badge reads `preview · classification`. The source bitmap comes from the
  viewport that already holds it (`ctx.viewers`), otherwise from the session's
  Blob cache; typing itself makes **no request and no history entry** (both
  asserted in the boot test).
* **"Generate map"** (renamed from "Classify") commits with ONE `POST
  …/classify`, which is ONE undo step, then opens the map composer. "Reset
  ranges" is unchanged (K-Means values back, names and colours kept).
* **Boundary bar.** Above the table, a 0..255 bar shows one segment per class
  (width = share of the axis, colour = the class colour) and one handle per
  boundary. Handles are `role="slider"` buttons: arrow keys move them by one
  intensity (works without layout, so the boot test can drive them) and a
  pointer drag maps `clientX` onto the axis.
* **First column header fixed.** The swatch column was 22 px, so the uppercase
  `COLOR` header was ellipsised to `C…`; it is now 40 px
  (`grid-template-columns: 40px repeat(4, minmax(0, 1fr))`).
* User-facing "Classify" wording was updated everywhere it named the button:
  the map composer's empty note, the Image menu's composer note, the composer's
  "nothing to draw" toast and the `errors.js` operation label.

### Files section removed — File-menu image actions (item 12)

* The **Files** toolbox section is gone (`js/panels/files.js` deleted,
  `panels/index.js` no longer creates it, no `focusSection("files")` remains).
  Its four actions are now File-menu entries, in this order:
  **Export current image (PNG)…** (Ctrl+S), **Export raw label map (PNG)…**,
  **Compress to .gch (GCH2)…** and **Open .gch file (decompress)…**.
* The two toolbar icons (**Export**, **Compress**) stay where they were and
  drive the same code through the bus events `export:request` /
  `huffman:compress-request` / `huffman:decompress-request` (the chat's
  `compress this image` command uses the same event).
* All four live in `js/imageactions.js`, which also owns the hidden
  `#gch-file-input` picker (the old picker lived inside the section body, so
  the boot test used to find it under `#toolbox-sections`). Behaviour is
  unchanged: the same requests, the same toasts, the same `status` messages,
  and the same gate — the menu computes `disabled`/`reason` from
  `gate.canRun()` / `gate.isBusy()`, the requests book themselves with
  `gate.setBusy(true, "image-actions")`.
* **Every hint line is gone**, app-wide, not just from the Files section:
  * the two Files paragraphs ("GCH2 files are compatible with the desktop app.",
    "Compression is lossless and stateless; the file can be opened in the
    desktop app.") died with the section — the compress entry's tooltip carries
    the wording instead: *"Lossless .gch compression (Huffman coding); files
    also open in the desktop app."* (`ui.js` menu items now accept an explicit
    `title`, used in preference to the note/shortcut tooltip);
  * `labelled()` in `ui.js` **lost its `hint` parameter**, so no field can
    render a hint line any more, and the `.hint-line` CSS rule was deleted;
  * the Source panel's field hints moved into `title` tooltips ("Sector code,
    alias, or any place name", "Paste from Google Maps — any corner", "The
    opposite corner; no need to sort them", and the dates' "leave it empty to
    use the server's rolling window"), and its date paragraph was removed.
  The boot test now asserts `.note`/`.hint-line` count 0 in the Source and
  Clusters sections, and the smoke test asserts `hint-line` appears in no panel
  module, not in `ui.js` and not in the stylesheet.
* The raw label map is the last remnant of the item-1 image/label toggle: it
  is still one download of the API's stored `kmeans:labels` image, but it is
  no longer a sidebar button. The entry is disabled with the reason "run
  K-Means first — the label map is one of its outputs" until a K-Means run
  exists, instead of toasting after the click.

### Histogram windows: viewport targeting, channels, resizing (item 13)

The sidebar **Histogram** button opens the window for the **active viewport's**
image (`state.activeRole`, mirroring the `viewer:active` event) and falls back
to the other viewport when that image already has a window — so Original and
Result are two presses, not a dropdown hunt. `hasWindowFor(id)` is the one
predicate behind that rule; the `Image` dropdown stays for the finer states.
The active viewport is marked by an **Active** badge in its header.

Each viewport footer has its own **Histogram** button (after **Distance**),
disabled until that viewport holds an image, which opens a window for *its*
image regardless of which pane is active.

* **Smoothing** is a slider 0…10 (`SMOOTHING_RANGE`, `SMOOTHING_STEPS[i]` = the
  moving-average window: 0, 3, 5 … 21). Its label is the single word
  "Smoothing"; no value text is printed. The old Off/Low/High dropdown and its
  raw-window mapping are gone — `smoothingLevel(v)` is a plain round+clamp.
* **Channel** (Gray/Red/Green/Blue/RGB overlay) is computed **in the browser**
  from the decoded image, so there is no API change and switching channel never
  sends a request: `session.imageBlob` → `createImageBitmap` → one canvas pass
  at up to `CHANNEL_SAMPLE_MAX` (2048) px → `channelHistograms()` counts all four
  series in one RGBA pass, skipping fully transparent pixels so an alpha image
  agrees with the API. Gray is the API's own 256-bin series;
  `channelKeysFor(info)` trusts the API's `info.channels`, so a grayscale image
  offers Gray only. The shared `toGray()` lives in `js/color.js` (the OpenCV
  weights the API uses) — there is exactly one copy.
* Windows are **resizable** (bottom-right grip, pointer drag or arrow keys,
  Shift = big step) and always **clamped inside the page**: `sizeBounds()` caps
  the size to the viewport, `fitSize()`/`reclamp()`/`reclampAll()` re-fit on a
  window resize, and `_move()` keeps the whole window inside all four edges.
* The toolbar's **Export** (download) and **Compress** (archive) icons stay
  distinct, and from **1600 px** (`WIDE_TOOLBAR_MIN`) the words come back next to
  them: `fitToolbar()` sets `.tb-wide`/`.tb-compact`/`.tb-tight`, where
  `.tb-wide:not(.tb-tight) .tb-label { display: inline }` outranks the compact
  rule (higher specificity, so no order dependency). `.tb-tight` is the escape
  hatch for a row that still cannot fit, so the toolbar never wraps.

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
* Filters (Grayscale/Negative/Laplacian/Clear result) and Run K-Means register
  buttons with the gate; the four file actions (`js/imageactions.js`, item 12)
  book their requests with the same gate and the File menu asks it for its
  enabled state (`gate.canRun()` / `gate.isBusy()`). No panel sets `disabled`
  on an operation button any more.

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
  composer offers “Image width on the ground = [value] [unit]” instead of
  inventing anything (item 16).

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
* **Scale (item 16):** `scaleBarLayout()` is a pure function — no canvas, no
  settings object — and it is what both the drawing code and the tests use:
    * **ground scale known** (`meters_per_pixel`/`bbox` from item 5, or the
      user's “Image width on the ground”): the bar is **exact**. The default
      total length is a 1/2/5 round number near **a fifth** of the ground width
      (`roundScaleLength`, auto-picking km above a kilometre until the user
      chooses a unit); a **label sits at every division boundary** — `0`, each
      tick, and the total with its unit — numbers formatted with at most two
      decimals and no trailing zeros (`formatNumber`);
    * **photo with no ground scale** (e.g. a drone shot): a **plain**
      alternating black/white bar at 40 % of the image width with **no numbers,
      no unit and no note** — never an invented distance;
    * **a typed total length** turns the labels on; once a ground width exists
      the pixel length is exact for it. A length longer than the image is capped
      at the ground width so the bar cannot claim a distance the image does not
      cover.
  Position: **Bottom left (default), Center, Right** (`SCALE_POSITIONS`), which
  only moves the bar along the footer — the labels travel with it. Divisions are
  clamped to 1…10, and total length / divisions / unit / label size update the
  preview live.
* **Default sizes (item 16):** `defaultSizes(width, height)` derives the title
  (3.2 % of the image width, 14…96), the subtitle (55 % of the title), the
  credit (45 %), the legend text and the scale labels (**half** the title) and
  the north arrow (**6 %** of the image height, 12…160). `MapStudio.open()`
  applies them to the fields until the user edits any size (`sizesTouched`), so
  the sidebar always starts from a sensible value for the image in front of it
  and every field keeps its own min/max.
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

### The menus, item by item (item 14)

Every entry in File / Edit / View / Processing / Analysis / Help does something
real. Nothing says "not implemented", "planned" or "coming soon", and the old
*Recent files* / *Session images…* placeholders are gone entirely (the session
image list they pointed at no longer exists).

* **File** — Open image… (Ctrl+O) · Fetch Sentinel-2 tile… · — · Export current
  image (PNG)… (Ctrl+S) · *Export raw label map (PNG)…* · Compress to .gch
  (GCH2)… · Open .gch file (decompress)… · — · New session.
  The label-map entry is not a greyed-out promise: it **appears** once
  `state.kmeans` exists (the label map is one of K-Means' outputs) and disappears
  again when a new image takes over the Original viewport. **New session asks
  first** (`confirmDialog`): the dialog says the current session, its images and
  the undo history are discarded, and cancelling keeps everything. The status-bar
  *New session* button goes through the same `startNewSession()`.
* **Edit** (between File and View) — Undo (Ctrl+Z) · Redo (Ctrl+Y). They were
  taken out of the File menu; the toolbar buttons and the shortcuts are unchanged.
* **View** — Fit to view · Actual size · Zoom in · Zoom out · — · Show toolbox ·
  Show assistant · Show result viewport. Zoom 25 %/50 %, Pixel readout, Pan tool,
  Measure distance, Synchronise and Map composer were removed from the menu; the
  **toolbar keeps those buttons and the shortcuts still work**.
* **Processing** — Grayscale · Negative · Laplacian · — · Brightness · Threshold ·
  Mean filter · — · Clear result. The right-hand notes ("uses {value: 40}") are
  gone. Grayscale/Negative/Laplacian run immediately (they take no parameters);
  **Brightness/Threshold/Mean filter open the Filters panel and put the cursor on
  their slider** (`focusOperation` → `focusSection("filters")` +
  `revealParams()`), so a menu click can never apply a value the user has not
  seen. The slider itself is the readout now.
* **Analysis** — Run K-Means… · Histogram · — · Map composer… . *Histogram* (the
  renamed "Histogram & statistics") emits `histogram:request`, which opens a
  histogram **window**, not a section. Classification editor, Map legend and Map
  export were removed — the legend and the export scale live in the composer
  itself.
* **Help** — Keyboard shortcuts · — · About. Both open a small **modal dialog**
  (`js/dialogs.js`): `role="dialog"`, `aria-modal="true"`, labelled by its own
  heading, focus moved inside on open and returned to whatever had it on close,
  Tab/Shift+Tab trapped, Escape closes. Shortcuts is a two-column list built from
  the `SHORTCUTS` table (keys in `<kbd>`, action beside it); About names the
  product, shows `APP_VERSION` and carries the two required credits
  (`CREDITS`): "Contains modified Copernicus Sentinel data." and "Place search by
  OpenStreetMap contributors." Neither dialog mentions a host, a port or any
  developer wording — the old About toast printed the API base and the page
  origin, which is exactly what the user asked to have removed.

Entries that are unavailable **right now** are disabled and carry the reason in
their **tooltip only** — the `.menu-item-note` span and its CSS rule are gone, so
no row can grow to two lines or print a wrapped sentence beside its label. The
toolbar buttons explain themselves the same way, and boot tests assert both (no
inline notes anywhere in `#menubar`, and every disabled entry has a title).

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
  % of pixels) with **Generate map** (item 11; it was "Classify") and
  **Reset ranges**; the Last run table, the centroid line, the separate legend
  block and every hint line are gone. K-Means always displays the clustered
  image — there is no image/label toggle — and the raw label map (which the API
  already stores as `kmeans:labels`) is downloaded from the File menu's
  **Export raw label map (PNG)…** entry. Max iterations is not user-facing: the
  panel always sends `max_iter=100` and K is limited to 2..10.
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

* Grey hint lines under the controls are gone, and so are the "?" buttons:
  **item 15 removed every help popover** from the Filters panel (and from
  `js/ui.js`, where `helpPopover`/`helpList` no longer exist). Each control
  instead carries **one native tooltip line** (`title`): the four
  point-operation buttons, the section header, the Brightness / Threshold /
  Mean filter labels and their number fields, and the Clear-result button all
  use the exact sentences from the brief — the same strings the assistant's
  glossary ships in `api/geocluster/data/app_help.json`, so the tooltip and the
  AI's offline answer can never drift apart (asserted on both sides).
* Grayscale, Negative, Laplacian and Clear result are a clean 2 × 2 button grid
  at full width, with no help control beside them.
* **Ask the assistant instead:** the chat welcome prompt says "Ask me what any
  tool does" and the first suggested hint is "What does the Mean filter do?".
  The rule-based router answers those questions from the glossary with **no
  LLM call**, so they work with no API key, while the provider is rate-limited
  or down — see the assistant notes.
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
* **Tooltip check (item 15):** the Brightness sentence now uses the brief's
  semicolons ("…from -255 to 255; positive values brighten…; results are
  limited…"), and the six filter sentences are byte-identical to the glossary.
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
| `node --test "web/tests/*.test.mjs"` | 160 logic tests: config resolution, error mapping, API client contract (URLs, bodies, multipart, session recovery), chat command mapping/execution, the satellite request shapes, the filter preview maths (reflect-101 box average, threshold/brightness clipping, the 512 px preview cap), the slider snapping/help texts, the item-15 rule that no help popover survives
  anywhere and that the tooltip sentences equal the shipped assistant glossary, the history `dropEntry` replacement rule, the linked classification ranges (item 11) and the histogram maths of item 13 (the OpenCV gray weights, channel counting with alpha, the 0…10 smoothing slider, the channel→series mapping), the product copy and the required credits (item 14), and the item-16 composer maths (the nine legend placements, `scaleBarLayout` for satellite/drone/typed lengths, boundary labels and number formatting, the legend box sized to the longest class name, the image-derived default sizes). No browser needed. |
| `python web/tests/smoke_test.py` | Serves `web/` on 5173 (reuses a running server for the same root), checks assets + content types, that every relative module import resolves, that no key material exists under `web/`, that no `innerHTML` is used, the workstation layout contract (image workspace owns the flexible track, no `object-fit: cover`, technical corner radii), and that the API's CORS allows the frontend origin. |
| `python web/tests/integration_check.py` | Live contract check against a running API: the exact call sequence the browser makes (session → upload → 6 filters → kmeans k=5 → classify → histogram → stats → GCH2 round trip → satellite validation and error paths → chat commands → 404/415). The three checks that need real Copernicus credentials report SKIP when the server has no `api/.env` instead of failing. Requires `uvicorn main:app --port 8000`. |
| `node web/tests/boot_test.mjs --jsdom <dir>` | Boot test: loads `index.html` in jsdom, imports `js/app.js` and drives the UI through DOM events against the live API — 849 assertions covering the shell (menu bar, toolbar, status bar, dock collapse), viewport behaviour (pan, wheel zoom, pixel readout, distance measurement, sync mirroring), upload, the six filters, the Source panel's place/corner modes, the Filters panel's tooltips (item 15: no popovers, one-line titles) and slider sessions (preview without requests, one request per release, replace-not-stack, Escape, arrow-key commits, one slider at a time), the rendered K-Means range table (item 11: live linked ranges, clamped commits, locked ends, the browser-side preview with zero requests/history entries, the boundary bar, "Generate map" = one undo step), the File menu's four image actions (item 12: exact compress tooltip, label-map entry, GCH2 compress → decompress through the menu and the toolbar), histogram windows (item 13: the active-viewport rule with its Active badge, the per-footer Histogram buttons, the smoothing slider, the Channel dropdown's per-image option list, the resize/min/max clamps on all four edges), the composer's item-16 placements/scale bar/derived sizes, the menus (item 14: the exact File/Edit/View/Processing/Analysis/Help contents, the conditional label-map entry, the New-session confirmation and its cancel path, the Help dialogs with their focus trap, Escape and credits, disabled reasons as tooltips and no inline notes anywhere), chat router commands, session-expiry recovery, and a clean browser console. jsdom is optional (not a dependency of the app); without it the test skips. |

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
* **Item 15 — the assistant answers "what is …?" itself, with no LLM call.**
  `api/geocluster/data/app_help.json` ships one entry per tool (id, name,
  aliases, short description; the six filter sentences are exactly the brief's
  wording) and two things read it: the system prompt embeds the whole glossary
  (plus the plain-text/no-LaTeX/short-answers/"never claim to see the user's
  image"/"say when unsure" rules), and `CommandRouter` matches "what is / what
  does / how do I use <tool>" against the names and aliases and returns
  `{"intent": "help", "tool": …, "answer": "Name - description."}` **before**
  any provider check. The endpoint therefore returns 200 with the answer when
  no key is configured or the provider is down or rate-limited — verified for
  both cases. Bare commands (`histogram`, `run k-means`, `show me F-8`) stay
  commands, and questions the glossary does not cover (`what is NDVI?`) still
  reach the model; `show histogram` keeps its desktop-era `fetch_satellite`
  quirk. The router matches whole words only, longest alias first, so "what is
  the kernel size" finds the mean filter and "what is invert colors" finds
  Negative.
* **"FIREWORKS" naming** (second note): the provider settings are the owner's
  Groq endpoint/model — base URL `https://api.groq.com/openai/v1`, model
  `openai/gpt-oss-20b`, `max_tokens` 600, `extra_body` `{"reasoning_effort":
  "low"}` — kept exactly as configured; the `FIREWORKS_*` identifiers are
  unchanged and only the environment key name stays that way.
* No browser automation runs in this environment, so the UI is verified by the
  module tests, the reference/import checks and the live API contract rather
  than by clicking. Serve it locally once to confirm the visuals.
