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
    Clusters, Analysis and Files are collapsed (click to expand).
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

## D. STEP 4 — map view

28. **[both]** Type **k=5** in Clusters → **Run K-Means** → **Classify**. The
    Map viewport opens automatically, showing the recoloured image with a
    legend panel beside/below it.
29. **[both]** The legend lists every class with its colour swatch, name and
    percentage, and those match the Clusters legend table.
30. **[both]** Zoom/pan the Map viewport (`+`, fit, wheel, drag): it behaves
    like the other two viewports; the status bar names it `Viewport: Map`.
31. **[both]** **Analysis → Map export (PNG)…**: Chrome downloads
    `map-<image>.png`. Open it: the legend is **inside** the PNG, next to the
    classified image.
32. **[both]** **Analysis → Map legend** (or the Legend button in the Map footer)
    hides the legend in the viewport; export again — the new PNG has no legend
    and is exactly the image size.
33. **[both]** **Analysis → Map view**, **View → Show map viewport** and the
    toolbar **Map** button each show/hide the Map pane. With three panes the map
    takes a full-width row under the other two at 1366 px, and a third column
    at 1920 px.
34. **[both]** Before classifying (new session, no K-Means): the map entries are
    disabled and their tooltip says "run Classify in the Clusters section
    first", and clicking the toolbar **Map** button explains it in a toast.

## E. STEP 5 — histogram and distance

35. **[both]** Analysis → **Histogram & stats**. Switch **Log scale**,
    **Smooth** (3/5/9), **Cumulative**, **Density** and **Light theme** one at a
    time: the chart redraws instantly, the caption lists the active options,
    and the Network tab shows **no new request**.
36. **[both]** Cumulative changes the y-axis label to "pixels ≤ intensity";
    density to "share of pixels"; the light theme repaints the canvas pale.
37. **[both]** **Export PNG**: the downloaded `histogram-<image>.png` is 1040×340
    (2× the panel), keeps the options you had selected, and carries the title
    line ("Histogram — … · log scale · smoothed 5").
38. **[both]** Distance → set unit **centimetres**, pixels-per-unit `100`, then
    use the Measure tool (two clicks on the Original viewport). The panel and
    the toast both show `… cm on screen (100 px/cm)`.
39. **[both]** Upload a large image (bigger than the API's max megapixels so it
    is downscaled) and repeat (38): the panel additionally shows
    `… cm at the original W×H px (upload downscaled ×N)` — two labelled values.
40. **[both]** Set the unit back to **pixels**: the measurement shows plain
    pixels and says the image was not downscaled (when that is the case).
41. **[both]** Choose **mm** with an empty pixels-per-unit box: the UI asks for
    the calibration instead of printing a made-up number.

## F. STEP 6 — menus

42. **[both]** Open File / View / Processing / Analysis / Help: every entry is
    real; none says "not implemented", "planned" or "coming soon".
43. **[both]** **Recent files** is gone. Instead **File → Session images…**
    opens the Source section and lists the session's images.
44. **[both]** Every greyed-out entry has a tooltip saying what to do first
    (Export with no image, Clear result with no result, map entries with no
    classification). Hover each one to confirm.
45. **[both]** Disabled toolbar buttons (Undo/Redo when empty) also explain
    themselves on hover.

## G. Wrap-up

46. **[both]** Walk the Console log: **0 errors** and no `[bus] listener … failed`
    warnings after all of the above.
47. **[both]** `Ctrl+O` opens the file picker, `Ctrl+S` exports a PNG, `+`/`-`/`0`/`1`
    drive the active viewport, `M` measures, `P` toggles the pixel readout, `Y`
    toggles viewer sync — and none of them throw.
48. **[both]** Optional: run the automated layers yourself —
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
