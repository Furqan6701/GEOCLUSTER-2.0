# Manual test checklist — Chrome @ 1366 px and 1920 px

Companion to `web/README.md`. Everything below was verified automatically where
possible (see `docs/frontend-notes.md` and the task report); this list is for the
things only a real browser can confirm — pixel rendering, downloads, wheel and
pointer behaviour, and layout at the two widths the user asked about.

## 0. Setup

1. Start the API: `uvicorn main:app --host 0.0.0.0 --port 8000` (from `api/`,
   with `.env` in place).
2. Serve the frontend **from `web/`**: `python web/serve.py --port 5173`.
   The API's CORS allow-list only accepts `http://localhost:5173`.
3. Open `http://localhost:5173` in Chrome. Press `F12` → **Console**; keep it
   visible for the whole run. There must be **0 errors** at every step.
4. Have `api/tests/fixtures/sample.jpg` handy (or any JPEG/PNG).
5. Set the window to **1366 px** wide (F12 → device toolbar → Responsive →
   1366×768 is fine) and work through section A. Repeat the marked items at
   **1920 px**. Items marked **[1920]** are width-specific; **[both]** means run
   it at each width.

## A. STEP 1 — filter operations from every entry point

6. **[both]** Toolbox → **Source** → *Upload image…* → `sample.jpg`. A toast
   names the file and its size; the Original viewport shows it; the status bar
   fills in dimensions/channels/session.
7. **[both]** Toolbox → **Filters** (already expanded) → set *Brightness* to
   `40` → click **Brightness**. Expect a toast "Brightness +40 applied → …",
   the Result viewport to update, and the status bar to show
   `Last: Brightness +40`.
8. **[both]** **Processing → Brightness…**. The Filters section must come
   forward with the brightness input focused/flashed, then the same toast and
   status line as (7) — this is the path that used to send no body.
9. **[both]** **Processing → Threshold…** and **Processing → Mean filter…**
   produce the same visible result (toast + Result update + status line).
10. **[both]** **Processing → Grayscale / Negative / Laplacian** run with no
    extra clicks.
11. **[both]** In the Processing menu, every entry shows a hint of what it will
    send (`uses value: 40`, `no parameters`).
12. **[both]** Make the API reject a value: set *Brightness* to `300` and click
    **Brightness**. The toast names the field ("value must be 255 or less") and
    contains **no** `{`, `}` or the word "JSON".
13. **[both]** Stop the API (Ctrl+C) and click **Grayscale**: the toast/banner
    says the API is unreachable and names the address. Restart the API.

## B. STEP 2 — layout

14. **[both]** The workspace fills the whole window: no black band under the
    status bar, and the status bar touches the bottom edge, at both widths.
    Resize the window slowly — the status bar stays pinned.
15. **[both]** Nothing is cut off without explanation: hover the viewport
    header details, and hover each status-bar cell (size, mode, zoom, session,
    API). Each shows the full text in a tooltip. The session cell reads
    `Session <6 chars>…` and its tooltip has the full id, TTL and max images.
16. **[both]** The toolbar is one row and never wraps or overlaps: buttons stay
    in a single line; at 1366 px the labels collapse to icons, at 1920 px they
    stay. Toolbox/Assistant toggles remain reachable at both widths.
17. **[both]** Zoom exists in exactly one place: there are **no** zoom buttons
    in the toolbar; each viewport footer has `− Fit 1:1 +`. The **View** menu
    still has Fit / Actual size / Zoom in / Zoom out / 25 / 50 %.
18. **[both]** Toolbox at startup: **Source** and **Filters** are expanded;
    **Clusters** and **Analysis** are collapsed (click to expand). There is no
    **Files** section any more.
19. **[both]** Before running anything, the Result viewport says
    "Run a filter or K-Means to see the result here" (not "No image loaded").

## C. STEP 3 — undo / redo

20. **[both]** Run three operations, then click **Undo** three times: each step
    restores the previous image instantly (no network request: F12 → Network
    stays quiet). Toolbar tooltips name the state ("Undo … (Ctrl+Z) — n/15
    states kept").
21. **[both]** `Ctrl+Y` (and `Ctrl+Shift+Z`) redo them; **Redo** becomes
    disabled at the newest state, **Undo** at the oldest of the 15.
22. **[both]** Run 20 quick Grayscale ops: the status bar shows at most
    `History 15/15`, and the oldest steps are dropped from the history.
23. **[both]** Undo back past a *Clear result* step: the Result viewport empties
    and returns with its placeholder.
24. **[both]** Close Chrome, reopen the page: the history is empty (it lives in
    the tab, by design) and both buttons are disabled with a reason.
25. **[both]** Click **New session**: the history cell clears and the history
    buttons disable (server-side ids are gone).
26. **[both]** **File → Undo / Redo** do the same as the toolbar buttons.
27. **[both]** (Eviction, harder to force) Run many operations with a small
    `max_images`, then undo to an old state and run an operation. It must
    succeed silently; the status bar reports the restored image was re-uploaded.

## C2. STEP 2/3 — Clusters, the classification editor and Files (items 1, 2, 11, 12)

27b. **[both]** Run K-Means: the **Clustered image** is shown on its own — there
    is no "Clustered image / Label map" toggle. The raw label map is downloadable
    from **File → Export raw label map (PNG)…** (disabled with the reason "run
    K-Means first…" until a run exists), and the toast names the file it saved
    (never an internal id).
27c. **[both]** The Clusters table shows **Color, Land cover, Min, Max, % of
    pixels** for every cluster without scrolling the sidebar sideways (each row
    is two lines). The word **COLOR** is spelled out in full — it is not clipped
    to "C…". Long class names stay readable via their tooltips.
27d. **[both]** With **K = 3** the default names are **Class 1 … Class 3**; run
    **k = 5** again and the land-cover names (Shadows, Grass / Lawn, …) come
    back. **Reset ranges** puts the min/max back but keeps names and colours you
    typed.

## C3. STEP 2/3 — the live linked ranges (item 11)

27e. **[both]** The first row's **Min** and the last row's **Max** are locked:
    clicking them shows **0** and **255** and typing does nothing (they look
    dimmed, and their tooltips say the ends are fixed).
27f. **[both]** Type a new **Max** in row 1 (e.g. `120`): the row below's **Min**
    becomes **121** as you type — no Apply button anywhere. Type a **Min** in a
    later row (e.g. `140`) and the row above's **Max** becomes **139**.
27g. **[both]** Type `250` into the first row's **Max** and press **Tab** (or
    Enter): the field snaps back to the largest legal value (one below the next
    class's Max), the next row's Min follows, and no class ever becomes empty.
    `0`, `999` and letters behave the same way (letters fall back to the low
    bound).
27h. **[both]** The **%** column changes as the ranges move (a class that takes
    over a bright range grows) and still adds up to 100 %. Watch F12 → Network:
    **no request** is made while editing, and the Undo button's label does not
    change.
27i. **[both]** The **Result viewport recolours as you type**: the badge reads
    `preview · classification`, the change appears immediately, and moving a
    colour swatch also repaints it. Nothing is committed, so F12 → Network
    stays quiet.
27j. **[both]** Drag a handle on the 0..255 bar above the table (or focus it and
    press ←/→): the boundary moves, the table fields follow, and the segment
    widths/colours track the classes.
27k. **[both]** Click **Generate map**: ONE request is sent, ONE undo step
    appears (Ctrl+Z puts the previous result back), the composer opens, and the
    preview badge disappears (the committed image replaces it).

## C4. STEP 2/3 — the File menu (item 12)

27l. **[both]** There is **no Files section** in the toolbox any more (only
    Source, Filters, Clusters, Analysis). The four actions are in the **File**
    menu, above Undo/Redo: **Export current image (PNG)…** (Ctrl+S), **Export
    raw label map (PNG)…**, **Compress to .gch (GCH2)…**, **Open .gch file
    (decompress)…**. The old "Decompress a .gch…" entry is gone.
27m. **[both]** Hover **Compress to .gch (GCH2)…**: the tooltip reads exactly
    *"Lossless .gch compression (Huffman coding); files also open in the desktop
    app."* No hint line or hint paragraph sits in any sidebar section — Source
    included: the place/corner fields and the Advanced dates explain themselves
    on hover (tooltips) instead of printing text under the field.
27n. **[both]** With no image loaded, the Export and Compress entries are greyed
    out with the reason "load, fetch or decompress an image first"; **Open .gch
    file** stays clickable (it brings an image), and the toolbar's Export /
    Compress icons are still there and still toast "Load or fetch an image
    first."
27o. **[both]** Compress from the File menu and from the toolbar icon give the
    same `.gch` (open it again with **Open .gch file (decompress)…**: the picker
    appears and the restored PNG becomes the working image). While a request is
    running, the menu entries are disabled ("a request is in flight").

## C3. STEP 1/4 — the editor shell (item 3)

27e. **[both]** Open the Map composer and look at the page behind it: the
    toolbar and status bar are visible but nothing shows THROUGH the dialog or
    its properties sidebar (no see-through panels), and the composer's own
    header sits below the page toolbar — never on top of it.

## D. STEP 4 — the Map composer

28. **[both]** Type **k=5** in Clusters → **Run K-Means** → **Classify**. The
    Map composer modal opens: live preview centre, properties sidebar right.
29. **[both]** **Escape** closes it and focus jumps back to the toolbar **Map**
    button; clicking **Map** reopens it with the settings you left (they persist
    for the session). Tabbing from the last control wraps to the first.
30. **[both]** The legend lists every class with its swatch, name and
    percentage, and matches the Clusters table — rename a class or change its
    colour in either place and the other follows.
31. **[both]** Title defaults to the image name without its extension; edit the
    title, add a subtitle and change the credit line — the preview updates as
    you type.
32. **[both]** Toggle the legend off/on and switch percentages off/on. The
    **Placement** dropdown defaults to **Outside right**: the preview gets WIDER
    so the legend sits beside the image. **Outside left** grows to the other
    side (same width), the three **Outside bottom …** spots trade that width for
    height and line the legend up with the image's left edge, centre or right
    edge; the four **On map — …** corners draw it over the image. Nothing
    outside the image is ever covered, and no class name is ever cut off —
    rename a class to something long and the legend box grows to fit it (no
    “…” anywhere).
32b. **[both]** The default sizes follow the image: the title is the biggest
    text, the legend text and the scale labels are about half the title's size
    and the north arrow is about 6 % of the image height. Edit any size (title,
    subtitle, legend, scale label, credit, arrow) — the number stays where you
    put it, within the field's limits, and every change repaints the preview.
33. **[both]** The scale bar is on with alternating black/white segments and a
    label at **every division boundary**: `0`, each tick, and the total with its
    unit — numbers without trailing zeros (0.5, not 0.50). Edit the total
    length, the divisions (1–10), the label size, the unit (m, km, ft, mi) and
    the **Position** (Bottom left — the default, Center, Right): the preview
    follows every keystroke.
33b. **[both]** **Satellite fetch (or any image with ground metadata):** the bar
    is exact from the start: its default length is a round number near a fifth
    of the image width, and it never says “not to scale”.
33c. **[both]** **Drone photo / plain upload (no ground scale):** the bar is a
    plain black/white bar with **no numbers, no unit and no note at all** — no
    invented distance. Type a value into **“Image width on the ground = […]
    [unit]”** (or a total length) and the numbers appear; with the width entered
    the bar is exact for that value.
34. **[both]** The north arrow is **on for a satellite crop and off for an
    upload**; try the three styles, its **Size (px)** and another corner. There
    is no Rotation control any more (the arrow is drawn north-up).
34b. **[both]** The **Font** dropdown (Arial, Times New Roman, Georgia,
    Verdana, Courier New, Trebuchet MS) changes EVERY text on the canvas —
    title, subtitle, legend, scale bar, credit, corner coordinates. Title size
    is the largest value on the panel by default; each of subtitle, legend,
    scale-bar label and credit has its own size field. The **Bold title** toggle
    and the **Title alignment** (left / center / right) work, and the title sits
    **centred at the top** by default.
34c. **[both]** The credit line is EMPTY for an uploaded image and reads
    "Contains modified Copernicus Sentinel data" for a satellite crop (or a
    result derived from one). Type your own credit — it survives opening
    another image; tick/untick the arrow and check that choice survives too.
35. **[both]** Click **PNG 2x** / **PNG 3x**: Chrome downloads
    `<title>-map@2x.png` and the file is exactly the preview at that scale
    (open it and compare the legend text and the bar).
36. **[both]** Analysis → *Map legend* toggles the legend without opening the
    modal; Analysis → *Map export (PNG)…* opens the modal so the scale can be
    chosen first.
## E. STEP 5 — histogram windows and distance

35. **[both]** Analysis holds **one "Histogram" button** and the Distance
    controls; there is no inline chart, no Statistics block and no hint lines.
    Press **Histogram**: a floating window opens over the page (the page behind
    stays visible and usable — it is NOT modal).
36. **[both]** Drag it by its title bar, press **Escape** (closes it), reopen
    and press the **✕**, and move it with the arrow keys while the title bar is
    focused. Tab cycles inside the window.
37. **[both]** Open **four** windows: each new one appears beside the previous
    one without covering it; a fifth press says to close one first. Each window
    is titled `Histogram: sample.jpg#…` for its own image.
38. **[both]** Switch **Scale** (Linear/Log), the **Smoothing slider** (0 = off
    … 10; it is labelled only "Smoothing" and prints no number), **Display**
    (Counts/Density/Cumulative) and **Theme** (Dark/Light) in one window: the
    chart redraws while you drag, the five statistics (Min, Max, Mean, Std dev,
    Pixels) stay beside it, and the Network tab shows **no new request**. A
    second window keeps its own options.
38a. **[both]** Colour image open (a JPEG/PNG upload or a K-Means display):
    the **Channel** dropdown offers **Gray (default) · Red · Green · Blue · RGB
    overlay**. Pick **Red** — the outline is red immediately, still with no
    request (the counts are computed here, from the decoded image). Pick **RGB
    overlay**: three coloured outlines with a three-row legend. Open a grayscale
    image (e.g. after **Grayscale**, or a label map) and **Gray is the only
    entry** in the dropdown.
39. **[both]** Change the **Image** dropdown to Result and then to an earlier
    undo state: the window redraws for that image and its title follows.
40. **[both]** Optional **Compare**: pick another image and a second outline is
    drawn in orange with a two-row legend; switch it off again.
41. **[both]** **Export PNG**: the downloaded `histogram-<image>.png` is
    1120×520 (2× the window), keeps the options and the title line.
41a. **[both]** The **active viewport is marked**: click the Original pane, then
    the Result pane — the **Active** badge sits on whichever you touched last,
    and the sidebar **Histogram** button follows it. Press that button twice:
    the first press shows the active viewport's image, the second shows the
    other viewport's image (so both are two clicks).
41b. **[both]** Each viewport footer carries its own small **Histogram** button
    next to **Distance**: the Result footer's button opens a window for the
    Result image even while the Original pane is the active one. Both footer
    buttons are greyed out while their own viewport is empty.
41c. **[both]** Drag the window's bottom-right **grip** to resize it (the chart
    redraws at the new size), and grow it towards every edge — the window never
    runs past the bottom or the sides of the page. Shrink the browser window:
    the open histogram windows are pulled back inside the page with it.
41d. **[both]** At a browser width of **1600 px or more** the toolbar's
    **Export** (download arrow) and **Compress** (archive box) buttons show
    their words next to the icons; narrow the window and the words go, leaving
    the two clearly different icons with their tooltips.
41e. **[both]** The footer **Distance** button looks pressed **only while
    measuring** (its label gains a ● and its tooltip changes); Esc or a second
    press clears the highlight. Check this on a **fresh page before uploading
    anything**: with both viewports empty, Distance and Histogram are greyed out
    and neither shows any active/pressed styling.
42. **[both]** Distance: with a plain upload the unit is **pixels** and the
    pixel-size field is hidden. Measure on a viewport (toolbar **Measure** or
    the viewport's **Distance** button, two clicks): the panel shows ONE line
    like `Distance: 450.20 px`, and **Clear** (or Esc) empties it.
43. **[both]** Switch the unit to **cm** and type a pixel size of `0.5`:
    the line converts (`500 px → 250.00 cm`). Switch to **km** and the number
    converts with it (the ground size a pixel spans never changes by itself).
44. **[both]** Fetch a satellite crop (or classify one) and measure: the unit
    comes up **m** with the pixel size already filled from
    `meters_per_pixel` (e.g. `10`), and the line reads e.g.
    `Distance: 5,000.00 m`.
45. **[both]** Upload a large image (bigger than the API's max megapixels so it
    is downscaled) and measure: the line adds
    `(… px at the original resolution)`. A normal upload shows no such note.
46. **[both]** Choose a ground unit with an EMPTY pixel size: the line asks for
    the pixel size instead of printing a made-up number.

## F. STEP 6 — the menus (item 14)

47. **[both]** The bar reads **File · Edit · View · Processing · Analysis ·
    Help** in that order, and every entry is real: none says "not implemented",
    "planned" or "coming soon".
47a. **[both]** **File**: Open image… (Ctrl+O), Fetch Sentinel-2 tile…, a
    separator, Export current image (PNG)… (Ctrl+S), Compress to .gch (GCH2)…,
    Open .gch file (decompress)…, a separator, **New session**. There is **no
    "Export raw label map" entry yet** — run K-Means (Analysis → Run K-Means…)
    and reopen the File menu: the entry appears (and is enabled). Load or fetch
    a different image and it is gone again.
47b. **[both]** **File → New session** asks first ("The current session ends…").
    **Cancel** keeps everything exactly as it was (same session, same image,
    same undo history); confirming starts a fresh session and says so in the
    bottom-right toast. The status-bar **New session** button asks the same
    question.
47c. **[both]** **Edit** holds exactly **Undo** and **Redo** (with Ctrl+Z /
    Ctrl+Y next to them). With nothing to undo, Undo is greyed out and hovering
    it says "nothing to undo — run an operation first"; hover text never wraps
    onto a second line in any menu.
47d. **[both]** **View** holds Fit to view, Actual size, Zoom in, Zoom out, a
    separator, Show toolbox, Show assistant, Show result viewport — and nothing
    else. Zoom 25 %/50 %, Pixel readout, Pan tool, Measure distance,
    Synchronise and Map composer are gone from this menu, yet the toolbar still
    has Pixel, Measure, Sync and Map with their shortcuts working.
47e. **[both]** **Processing** lists Grayscale, Negative, Laplacian, a
    separator, Brightness, Threshold, Mean filter, a separator, Clear result —
    with **no notes on the right**. Clicking **Brightness** (or Threshold / Mean
    filter) opens the Filters panel, flashes that row and puts the cursor on its
    slider; it sends no request. Move the slider (or press Enter) and the
    operation applies as usual. Grayscale/Negative/Laplacian still run straight
    away.
47f. **[both]** **Analysis** lists Run K-Means…, **Histogram**, a separator and
    Map composer… . **Classification editor**, **Map legend** and **Map export**
    are gone from the menu (the composer's own panel and footer do those jobs).
    **Histogram** opens a floating histogram window immediately.
47g. **[both]** Disabled entries explain themselves **only** in a tooltip
    (Export with no image, Clear result with no result): no entry shows wrapped
    inline text. Disabled toolbar buttons (Undo/Redo when empty) also explain
    themselves on hover.
47h. **[both]** **Help → Keyboard shortcuts** opens a small dialog with a
    two-column list (key on the left, what it does on the right) and a Close
    button. Tab from the last control wraps to the first, Shift+Tab from the
    first wraps to the last, Escape closes it, and focus returns to where you
    were.
47i. **[both]** **Help → About** opens a small dialog with the product name, the
    version, one line about what the app is, and the credits "Contains modified
    Copernicus Sentinel data." / "Place search by OpenStreetMap contributors."
    There is **no hostname, port or developer wording** in either dialog.

## G. AI-based help (item 15)

48. **[both]** The Filters panel has **no "?" buttons and no popovers** — not on
    the section head, not beside POINT OPERATIONS, not on the three sliders.
    Hover each control instead: Grayscale, Negative, Laplacian and Clear result
    each show **one line** with the exact description; the Brightness,
    Threshold and Mean filter labels (and their number fields) do too; the
    **Filters** section header shows the "each filter is applied to the latest
    result…" line. Nothing wraps to two lines, nothing is cut off.
49. **[chat]** Ask the assistant **"What is the mean filter?"** (or "What does
    Grayscale do?", "How do I use threshold?"). The answer repeats the same
    sentence as the tooltip, in the chat bubble, with **no LaTeX and no
    markdown** (`**`, `#`, backticks). It must answer even with **no API key**
    configured in `api/.env`, and while the provider is rate-limited — those
    answers never touch the model.
49a. **[chat]** Ask **"What is NDVI?"**: that one **does** need the model
    (works with a key, friendly "assistant is unavailable" bubble without).
    Type **`histogram`** or **`run k-means`**: those still run as commands, not
    as questions.
49b. **[both]** The chat welcome bubble mentions **"Ask me what any tool
    does"**, and the first suggested hint is a question ("What does the Mean
    filter do?") that answers offline.

## H. Wrap-up

51. **[both]** Walk the Console log: **0 errors** and no `[bus] listener … failed`
    warnings after all of the above.
52. **[both]** `Ctrl+O` opens the file picker, `Ctrl+S` exports a PNG, `+`/`-`/`0`/`1`
    drive the active viewport, `M` measures, `P` toggles the pixel readout, `Y`
    toggles viewer sync — and none of them throw.
53. **[both]** Optional: run the automated layers yourself —
    `node --test "web/tests/*.test.mjs"`, `python web/tests/smoke_test.py`,
    `python web/tests/integration_check.py`,
    `node web/tests/boot_test.mjs --jsdom <path>/node_modules`,
    `python -m pytest api/tests -q`.

## What automation could not cover

* Real rasterisation: crisp nearest-neighbour pixels when zoomed past 1:1,
  font rendering, and the exact ellipsis behaviour of the status bar/headers.
* The actual bytes of a downloaded PNG (the export path is asserted, the
  encoder is the browser's).
* Wheel/pointer gestures and `ResizeObserver` reflows (jsdom gets synthetic
  events only).
* Cross-origin behaviour from a hosted preview (the `/api` proxy path is tested,
  but a real browser's CORS decision is not).
* Long-run memory behaviour of the 15-state / 24-Blob history under large images.
* The real canvas font metrics behind the legend placement maths: jsdom measures
  every glyph as one width, so the exact legend box size (and therefore the
  exact exported canvas width) must be eyeballed once in a browser.
* Dragging a floating histogram window with a real pointer (mousemove/mouseup
  are synthesised in the boot test), and window stacking with several open.
* The colour channels of the histogram on a REAL image: jsdom has no drawable
  pixels (its `createImageBitmap` stub has none), so the browser-side decode
  behind Red/Green/Blue/RGB overlay was verified by the pure-function tests and
  by the boot test's DOM contract, not by counting real pixels.
* The pixel-level look of the resized histogram window (grip drag) and the
  toolbar's labels at an actual 1600 px window width (jsdom has no layout, so
  those numbers were stubbed).
* Scrollbars/overflow of the histogram window body when a desktop font renders
  wider than jsdom's stub.
