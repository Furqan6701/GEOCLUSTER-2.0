#!/usr/bin/env python3
"""Offline smoke test for the GeoCluster web frontend.

Checks, without needing a browser or the API:

  1. web/serve.py serves index.html, the stylesheet and the modules on
     http://localhost:5173 with sane content types (an already-running server
     for the same web root is reused);
  2. every file index.html references exists, and every ES-module import in
     web/js/** resolves (broken imports would blank the page);
  3. no key material is present anywhere under web/;
  4. no `.innerHTML` usage (chat replies must render through textContent);
  5. if the API is running on :8000, its CORS headers allow the frontend origin
     — reported as SKIP when the API is down.

Usage:
    python web/tests/smoke_test.py
Exit code 0 = all good.
"""

from __future__ import annotations

import contextlib
import functools
import http.server
import pathlib
import re
import socket
import threading
import json
import urllib.error
import urllib.request

WEB = pathlib.Path(__file__).resolve().parents[1]
PORT = 5173
API = "http://localhost:8000"
ORIGIN = f"http://localhost:{PORT}"

FAILURES: list[str] = []
SKIPS: list[str] = []


def check(condition: bool, label: str, detail: str = "") -> bool:
    if condition:
        print(f"PASS  {label}")
        return True
    FAILURES.append(label + (f" — {detail}" if detail else ""))
    print(f"FAIL  {label}{f' — {detail}' if detail else ''}")
    return False


def skip(label: str, why: str) -> None:
    SKIPS.append(label)
    print(f"SKIP  {label} — {why}")


def port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    with contextlib.closing(socket.socket()) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


def fetch(url: str, headers: dict | None = None):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, response.headers.get("Content-Type", ""), response.read()


@contextlib.contextmanager
def serving(directory: pathlib.Path, port: int):
    """Serve `directory` on `port`; reuse an existing server for the same root."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    try:
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        try:
            _, _, body = fetch(f"http://127.0.0.1:{port}/")
            ours = body == (directory / "index.html").read_bytes()
        except Exception:  # noqa: BLE001
            ours = False
        if not ours:
            raise RuntimeError(f"port {port} is in use by a different server; free it and retry") from None
        print(f"note  port {port} already serves this web/ — reusing the running server")
        yield
        return

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(f"note  serving {directory} on http://localhost:{port}")
    try:
        yield
    finally:
        httpd.shutdown()
        httpd.server_close()


# --------------------------------------------------------------------- checks

def check_serving() -> None:
    try:
        with serving(WEB, PORT):
            for path, expect_type in [
                ("/", "text/html"),
                ("/css/styles.css", "text/css"),
                ("/js/app.js", "text/javascript"),
                ("/js/viewer.js", "text/javascript"),
                ("/js/panels/chat.js", "text/javascript"),
            ]:
                try:
                    status, content_type, body = fetch(f"{ORIGIN}{path}")
                    check(status == 200, f"GET {path} → 200", f"got {status}")
                    check(expect_type in content_type, f"GET {path} content-type contains {expect_type}", content_type)
                    check(len(body) > 0, f"GET {path} is not empty")
                except Exception as error:  # noqa: BLE001
                    check(False, f"GET {path}", str(error))

            try:
                fetch(f"{ORIGIN}/js/does-not-exist.js")
                check(False, "GET /js/does-not-exist.js → 404", "expected HTTPError")
            except urllib.error.HTTPError as error:
                check(error.code == 404, "GET /js/does-not-exist.js → 404", str(error.code))
    except RuntimeError as error:
        check(False, f"serve web/ on port {PORT}", str(error))


LOCAL_REF = re.compile(r'(?:href|src)\s*=\s*"([^"]+)"')
IMPORT_RE = re.compile(r'from\s+"(\.[^"]+)"')


def check_references() -> None:
    index = (WEB / "index.html").read_text(encoding="utf-8")
    referenced = [
        ref for ref in LOCAL_REF.findall(index)
        if not ref.startswith(("http://", "https://", "data:", "#"))
    ]
    check(bool(referenced), "index.html references local assets")
    for ref in referenced:
        check((WEB / ref.lstrip("/")).exists(), f"index.html reference exists: {ref}")

    broken = []
    checked = 0
    for module in list((WEB / "js").rglob("*.js")) + list((WEB / "tests").rglob("*.mjs")):
        text = module.read_text(encoding="utf-8")
        for target in IMPORT_RE.findall(text):
            checked += 1
            resolved = (module.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{module.relative_to(WEB)} → {target}")
    check(not broken, f"all {checked} relative ES-module imports resolve", "; ".join(broken))


def check_no_secrets() -> None:
    patterns = {
        "Fireworks-style key": re.compile(r"(?:sk|gsk)_[A-Za-z0-9]{10,}"),
        "assigned FIREWORKS_API_KEY": re.compile(r"FIREWORKS_API_KEY\s*=\s*['\"]?[A-Za-z0-9]"),
        "assigned COPERNICUS secret": re.compile(r"COPERNICUS_CLIENT_(?:ID|SECRET)\s*=\s*['\"]?[A-Za-z0-9]"),
        "bearer token literal": re.compile(r"Bearer\s+[A-Za-z0-9._-]{12,}"),
    }
    hits = []
    for path in WEB.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".js", ".mjs", ".html", ".css", ".py", ".json", ".md"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for label, pattern in patterns.items():
            if pattern.search(text):
                hits.append(f"{path.relative_to(WEB)}: {label}")
    check(not hits, "no key material anywhere under web/", "; ".join(hits))


def check_no_innerhtml() -> None:
    hits = []
    for path in list(WEB.rglob("*.js")) + list(WEB.rglob("*.html")) + list(WEB.rglob("*.mjs")):
        text = path.read_text(encoding="utf-8")
        if re.search(r"\.innerHTML|insertAdjacentHTML|document\.write\(", text):
            hits.append(str(path.relative_to(WEB)))
    check(not hits, "no innerHTML/insertAdjacentHTML/document.write usage", ", ".join(hits))


def _js_text(relative: str) -> str:
    return (WEB / relative).read_text(encoding="utf-8")


def check_workstation_layout() -> None:
    """The layout contract of the redesign: image workspace first."""
    index = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "css" / "styles.css").read_text(encoding="utf-8")

    check("css/styles.css" in index, "index.html loads the workstation stylesheet")
    check(not (WEB / "css" / "workstation.css").exists(),
          "the old dashboard stylesheet is gone (one consolidated stylesheet)")
    for element_id in ["menubar", "toolbar", "toolbox", "viewer-area", "assistant-dock", "statusbar"]:
        check(f'id="{element_id}"' in index, f"shell element #{element_id} exists in index.html")
    for stale in ["tabpanels", 'id="tabs"']:
        check(stale not in index, f"old dashboard markup ({stale}) is gone")

    workspace = re.search(r"\.workspace\s*\{([^}]*)\}", css)
    check(workspace is not None, "the workstation layout rule exists")
    if workspace:
        body = workspace.group(1)
        check("grid-template-columns" in body and "minmax(0, 1fr)" in body,
              "the workspace grid gives the image column the flexible track")
        check("var(--toolbox-w)" in body and "var(--assistant-w)" in body,
              "the docks are fixed-width so the imagery keeps priority")

    image_ws = re.search(r"\.image-workspace\s*\{([^}]*)\}", css)
    check(image_ws is not None and "grid-template-columns" in (image_ws.group(1) if image_ws else ""),
          "the image workspace is a grid of viewports")

    canvas_wrap = re.search(r"\.viewer-canvas-wrap\s*\{([^}]*)\}", css)
    check(canvas_wrap is not None and "var(--bg-canvas)" in canvas_wrap.group(1),
          "the viewport uses the dark image-processing background")

    # no cropping anywhere: object-fit must never be cover
    check("object-fit: cover" not in css and "object-fit:cover" not in css,
          "no object-fit: cover (images are never cropped)")

    # dashboard look: no giant rounded corners
    # 999px pills (chips/badges) are fine; panel containers must stay square-ish
    radii = [int(value) for value in re.findall(r"border-radius:\s*(\d+)px", css)]
    containers = [value for value in radii if value < 900]
    check(all(value <= 12 for value in containers),
          "panel corner radii stay technical (no giant dashboard cards)",
          f"max container radius {max(containers) if containers else 0}px")

    # density: the toolbox must not be styled as a stack of big cards
    check("--fs-md: 12px" in css and "--status-h: 26px" in css,
          "compact typography and status bar are configured")

    # STEP 2.1: the shell fills the dynamic viewport height, status bar last
    body_rule = re.search(r"\nbody \{([^}]*)\}", css)
    check(body_rule is not None, "the body rule exists")
    if body_rule:
        body = body_rule.group(1)
        check("100dvh" in body, "the shell uses the dynamic viewport height (dvh)")
        check("100vh" in body, "100vh remains as the fallback for older browsers")
        check("position: fixed" in body and "inset: 0" in body,
              "the shell is pinned to the viewport so nothing can push it up")
        check("overflow: hidden" in body, "the page itself never scrolls")
    rows = re.search(r"grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto", css)
    check(rows is not None, "header/banner/workspace/status bar are grid rows (status bar last)")

    # STEP 2.4: the toolbar never wraps or overlaps
    toolbar_rule = re.search(r"\.toolbar \{([^}]*)\}", css)
    check(toolbar_rule is not None and "flex-wrap: nowrap" in toolbar_rule.group(1),
          "the toolbar is a single non-wrapping row")
    check(".toolbar.tb-compact .tb-label { display: none; }" in css,
          "the toolbar can drop to icons when space runs out")
    check("@media (max-width: 1440px)" in css, "narrow desktops get the compact toolbar CSS")

    # STEP 2.2: truncated text keeps a tooltip
    check("text-overflow: ellipsis" in css, "long strings are ellipsised")
    check(".viewer-head .meta" in css and ".sb-item" in css,
          "both the viewport header and the status bar participate in truncation")

    # the Map composer (redesign): a modal, not a third docked viewport
    check('id="viewer-map"' not in index,
          "index.html has no docked Map viewport any more (the composer replaced it)")
    check('id="tb-map"' in index, "the toolbar has a Map button")
    viewer_js = _js_text("js/viewer.js")
    check("footerExtras" in viewer_js, "viewers accept extra footer controls")
    check("node instanceof Node" in viewer_js,
          "viewer footer extras are DOM nodes only (the [object Object] guard)")
    map_js = _js_text("js/map.js")
    for token in ["mapCanvasToBlob", "formatPercentage", "mapFileName"]:
        check(f"export function {token}" in map_js or f"export async function {token}" in map_js,
              f"map.js exports {token}")
    check("composeMap" not in map_js and "drawLegend" not in map_js,
          "map.js holds no second composer — one canvas, one renderer")
    studio_js = _js_text("js/mapstudio.js")
    for token in ["drawStudioMap", "composeStudioMap", "drawScaleBar", "drawNorthArrow",
                  "drawLegendBox", "groundWidthMeters", "cornerLabels", "roundScaleLength",
                  "SCALE_UNITS", "NORTH_STYLES", "EXPORT_SCALES",
                  "MAP_FONTS", "fontSpec", "TITLE_ALIGNS", "TEXT_SIZE_RANGE",
                  "LEGEND_PLACEMENTS", "DEFAULT_LEGEND_PLACEMENT", "legendPlacementOf", "studioLayout"]:
        check(token in studio_js, f"mapstudio.js provides {token}")
    check('createElement("canvas")' in studio_js,
          "the whole map (image + legend + bar + arrow) is composited on one canvas")
    # the ONLY family literal left is fontSpec's own fallback list
    check(len(re.findall(r"system-ui", studio_js)) == 1,
          "no text is drawn with a hard-coded font family any more",
          str(len(re.findall(r"system-ui", studio_js))))
    check(studio_js.count("fontSpec(") >= 6,
          "title, subtitle, corner labels, legend, scale bar and credit all use fontSpec")
    ui_js = _js_text("js/mapstudio_ui.js")
    for token in ['role="dialog"', 'aria-modal', "Escape", "FOCUSABLE", "MapStudio"]:
        check(token in ui_js, f"mapstudio_ui.js implements {token}")
    check("MAP_FONTS" in ui_js and "titleBold" in ui_js and "titleAlign" in ui_js and "arrowSize" in ui_js,
          "the composer offers the Font dropdown, the bold toggle, the alignment and the arrow size")
    check("arrowRotation" not in ui_js and "arrowSize" in ui_js,
          "the north arrow has a Size control and NO rotation control")
    check("outsideLegend" in studio_js and "legendArea" in studio_js,
          "frameMetrics reserves a band for an outside legend")
    check('DEFAULT_LEGEND_PLACEMENT = "outside-right"' in studio_js,
          "the default legend placement is outside right")
    check("legendPlacement" in ui_js and "legendCorner" not in ui_js,
          "the composer offers the placement dropdown, not the old corner one")
    check("drawImage" in studio_js and "not to scale" in studio_js,
          "the image is drawn in and unknown scales are labelled honestly")
    # ---- item 3: the composer is opaque and clears the page toolbar
    # every var() the stylesheet uses has to be defined: `var(--panel)` was a
    # typo for --bg-panel, which made the dialog and its sidebar transparent
    defined = set(re.findall(r"^\s*(--[a-z0-9-]+)\s*:", css, re.M))
    used = set(re.findall(r"var\((--[a-z0-9-]+)", css))
    missing = sorted(used - defined)
    check(not missing, "every CSS custom property is defined", ", ".join(missing))
    check("var(--panel" not in css and "var(--panel-2" not in css,
          "the transparent --panel typo is gone")
    check("background: var(--bg-panel-2)" in css and "background-color: #141824" in css,
          "the modal header and footer are opaque, with a fallback colour")
    check("background-color: #10131a" in css,
          "the properties sidebar is opaque even if the var is missing")
    check("background-color: #141a1f" in css,
          "the preview host behind the checkerboard is opaque")
    check("--map-modal-top" in css and "padding: var(--map-modal-top" in css,
          "the overlay starts below the app header")
    check("--map-modal-top" in ui_js and "_fitToViewport" in ui_js,
          "the composer measures the page header and sets that inset")
    check(re.search(r"\.map-modal\b[^{]*\{[^}]*position: fixed", css) is not None,
          "the overlay itself is fixed")

    check("map-modal-dialog" in css and ".cluster-actions" in css,
          "the composer and the cluster editor are styled")

    # the action gate: one rule for every operation button (bug fix)
    gate_js = _js_text("js/gate.js")
    check("export function createActionGate" in gate_js and "GATE_STATE_EVENTS" in gate_js,
          "gate.js exports the action gate and the state-change list")
    for event in ("image:loaded", "image:cleared", "operation:applied", "history:changed", "session:reset"):
        check(event in gate_js, f"the gate re-evaluates after {event}")
    operations_js = _js_text("js/panels/operations.js")
    check("ctx.gate.register(" in operations_js and "node.disabled = busy" not in operations_js,
          "the Filters buttons ask the gate instead of deciding for themselves")
    check("ctx.gate.setBusy(" in operations_js,
          "the Filters panel books its requests with the gate")
    clusters_js_source = _js_text("js/panels/clusters.js")
    check("ctx.gate.register(" in clusters_js_source and "runButton.disabled" not in clusters_js_source,
          "Run K-Means follows the same rule")
    files_js_source = _js_text("js/panels/files.js")
    check(files_js_source.count("ctx.gate.register(") >= 2,
          "the Files image actions follow the same rule",
          str(files_js_source.count("ctx.gate.register(")))
    app_js_text = _js_text("js/app.js")
    check("createActionGate({ state, bus })" in app_js_text and "gate," in app_js_text,
          "app.js creates the single gate and shares it with every panel")

    # item 5: ground-scale metadata travels from the provider to the composer
    api_root = WEB.parent / "api"
    api_schemas = (api_root / "schemas.py").read_text(encoding="utf-8")
    api_sessions = (api_root / "sessions.py").read_text(encoding="utf-8")
    api_operations = (api_root / "routers" / "operations.py").read_text(encoding="utf-8")
    api_satellite = (api_root / "routers" / "satellite.py").read_text(encoding="utf-8")
    for field in ("bbox", "meters_per_pixel"):
        check(field in api_schemas, f"ImageOut exposes {field}")
        check(field in api_sessions, f"the store carries {field}")
    check("def derive_ground_metadata" in api_sessions,
          "one helper derives the metadata for derived images")
    check(api_operations.count("derive_ground_metadata(") >= 4,
          "operations, K-Means (labels + display) and classify all carry it",
          str(api_operations.count("derive_ground_metadata(")))
    check("bbox=" in api_satellite and "meters_per_pixel=" in api_satellite,
          "the satellite fetch stores the box and the pixel size")
    check("resolution_m" in api_satellite and "/ scale" in api_satellite,
          "meters per pixel accounts for the downscale")
    session_js = _js_text("js/session.js")
    check("carryGroundMetadata" in session_js, "the frontend carries metadata across a re-upload")
    check("carryGroundMetadata" in _js_text("js/app.js"), "the revive path uses it")
    check("meters_per_pixel" in studio_js and "bbox" in studio_js,
          "the composer reads the ground scale from the image info")

    # STEP 6: nothing is left advertising an unimplemented feature
    app_js = _js_text("js/app.js")
    check("Recent files" not in app_js and "Recent files" not in index,
          "the never-implemented Recent files entry is removed")
    check("not implemented" not in app_js.lower(),
          "no menu entry claims a feature is 'not implemented'")
    check("disabled-stub" not in css and "disabled-stub" not in index,
          "the disabled-stub placeholder styling is gone with the last stub")
    # STEP 2 of the redesign removed the session-file list from the Source
    # panel, so no menu entry may promise it any more.
    check("Session images" not in app_js,
          "no File menu entry promises a session image list (the list is gone)")
    check(re.search(r'label: "Fetch Sentinel-2 tile…"', app_js) is not None,
          "the File menu still offers the satellite fetch")
    check(re.search(r'label: "Map export \(PNG\)…"', app_js) is not None,
          "Map export is a real menu action")
    check(re.search(r'label: "Map composer…"', app_js) is not None and
          "openMapStudio" in app_js,
          "the composer is reachable from the View/Analysis menus")
    check("mapViewer" not in app_js and "setMapVisible" not in app_js,
          "the docked map viewport wiring is gone from app.js")
    check(re.search(r'if \(!mapStudio\.isOpen\(\)\)', app_js) is not None,
          "an export from the menu opens the composer first (so the scale can be chosen)")
    check(re.search(r'reason: "there is no result yet', app_js) is not None,
          "Clear result explains when it is unavailable")

    # STEP 3 of the redesign: the Filters panel has help popovers instead of
    # hint lines, and sliders instead of Apply buttons
    filters_js = _js_text("js/panels/operations.js")
    ui_js = _js_text("js/ui.js")
    preview_js = _js_text("js/preview.js")
    for text in [
        "Each filter is applied to the latest result, so filters can be combined. Use Undo to step back.",
        "Converts the image to a single-band grayscale image using a luminance-weighted combination of the color channels.",
        "Inverts pixel values to produce a photographic negative.",
        "Edge detection filter that highlights areas of rapid intensity change, such as boundaries and fine detail.",
        "Shifts all pixel values by a constant amount from -255 to 255. Positive values brighten the image and negative values darken it. Results are limited to the valid 0 to 255 range.",
        "Each color value (red, green, blue) above the threshold is set to its maximum, and all others are set to zero.",
        "Smooths the image by averaging neighboring pixels.",
        "Clears the result viewport. The original image and the undo history are not affected.",
    ]:
        check(text in filters_js, f"the help text is present verbatim: {text[:46]}…")
    check("Resets the result viewport to the original image" not in filters_js,
          "the old Clear-result wording is gone (the mismatch is resolved)")
    for hint in ["Adds a constant, clipped to 0…255.", "Pixels above the value become white.",
                 "OpenCV blur with a square kernel."]:
        check(hint not in filters_js, f"the old hint line is gone: {hint[:40]}")
    check("hint-line" not in filters_js, "the Filters panel renders no hint lines")
    check("paramRow" not in filters_js and '"Apply"' not in filters_js,
          "the parameterised filters have no Apply button any more")
    for token in ["helpPopover", "aria-expanded", "aria-controls", "below"]:
        check(token in ui_js, f"ui.js popovers handle {token}")
    for token in [".help-btn", ".help-popover", ".help-popover.below", ".slider-row", ".slider-choice",
                  ".help-list", ".help-entry", ".help-entry strong"]:
        check(token in css, f"the STEP 3 styling exists: {token}")
    check("export function helpPopover" in ui_js, "helpPopover is a reusable component")
    check("export function helpList" in ui_js, "helpList builds the grouped popover from DOM nodes")
    check("op-cell" not in filters_js and "op-cell" not in css,
          "the per-button help cells are gone")
    # three factories (the point-operations group, sliderGroup for the 3
    # sliders, the section head) render the five "?" buttons the boot test counts
    check(filters_js.count("helpPopover(") == 3 and "helpList(POINT_OPERATION_HELP)" in filters_js
          and "HELP_TEXTS[key]" in filters_js and "HELP_TEXTS.filters" in filters_js,
          "one grouped popover for the point operations plus one per slider and the section head",
          str(filters_js.count("helpPopover(")))
    check(filters_js.count("makeButton(\"Grayscale\"") == 1 and "helpCell" not in filters_js,
          "the point-operation buttons carry no individual \"?\" any more")
    check("grid-template-columns: 1fr 1fr" in css,
          "the 2 x 2 grid rule still lays the four buttons out at full width")
    check("Kernel size" in filters_js and "choice: (value) => `${value} x ${value}`" in filters_js,
          "the mean filter slider is labelled Kernel size and shows N x N")
    check("requestAnimationFrame" in filters_js and '"preview:show"' in filters_js,
          "dragging paints a browser-side preview (no request)")
    check("preview:clear" in filters_js and "cancelAnimationFrame" in filters_js,
          "the preview can be cancelled (Escape, another action)")
    check("dropEntry" in filters_js and "dropEntry" in _js_text("js/history.js"),
          "a repeated slider release replaces its own history step")
    for token in ["export function applyBrightness", "export function applyThreshold",
                  "export function applyMeanFilter", "PREVIEW_MAX_SIDE"]:
        check(token in preview_js, f"preview.js exports {token}")
    check("fetch(" not in preview_js and "ApiClient" not in preview_js,
          "the preview maths never talks to the server")
    check("reflect101" in preview_js, "the mean-filter preview uses OpenCV's border mode")
    check("setPreviewCanvas" in viewer_js and "clearPreview" in viewer_js and "previewBadge" in viewer_js,
          "the Viewer can show and drop an uncommitted preview")

    # Clusters panel (redesign): one editor table, no Last run / legend blocks
    clusters_js = _js_text("js/panels/clusters.js")
    check("const iterInput" not in clusters_js and "Max iterations" not in clusters_js,
          "the Clusters panel has no Max iterations field")
    check("KMEANS_MAX_ITER = 100" in clusters_js, "K-Means always sends max_iter=100")
    check(clusters_js.count('toolGroup("') == 2,
          "the Clusters panel has two groups (K-Means + one editor)",
          str(clusters_js.count('toolGroup("')))
    for gone in ["Last run", "Centroids", 'toolGroup("Legend"', "renderSummary", "renderLegend", "legendHost"]:
        check(gone not in clusters_js, f"the removed Clusters block is gone: {gone}")
    for kept in ["% of pixels", "Land cover", "cluster-actions", "Reset ranges"]:
        check(kept in clusters_js, f"the Clusters panel keeps {kept}")
    check("RESULT_VIEWS" not in clusters_js and ".segmented" not in clusters_js,
          "the Clustered image / Label map toggle is gone (the clustered image is the result)")
    check("showClusteredImage" in clusters_js and "display_image_id" in clusters_js,
          "K-Means always shows the clustered image")
    check("downloadLabelMap" in clusters_js and "labels_image_id" in clusters_js,
          "the raw label map is still downloadable (the API stores it)")
    files_source = _js_text("js/panels/files.js")
    check("Download raw label map" in files_source and "labelmap:request" in files_source,
          "the label-map download lives in the Files panel")
    check("grid-template-areas" in css and "grid-area: name" in css,
          "the editor rows are laid out on two lines so every column fits the sidebar")
    check('el("div", { class: "table-wrap" }' not in clusters_js,
          "the editor no longer wraps its table in a horizontal scroller")
    check("defaultClassNames" in clusters_js and "PRESET_NAME_K" in clusters_js,
          "class names follow the K rule (presets at 5, Class n otherwise)")
    check("appearance: textfield" in css,
          "the number spinners are dropped so 3-digit bounds fit")

    for token in [".cluster-actions", ".cluster-bound", ".cluster-name", ".cluster-share"]:
        check(token in css, f"the Clusters styling exists: {token}")

    # STEP 5: histogram options are browser-side, distance has real units
    hist_js = _js_text("js/histogram.js")
    for token in ["smoothBins", "cumulativeBins", "densityBins", "prepareBins",
                  "drawHistogram", "THEMES", "histogramFileName"]:
        check(f"export function {token}" in hist_js or f"export const {token}" in hist_js,
              f"histogram.js exports {token}")
    check("fetch(" not in hist_js and "ApiClient" not in hist_js and "await " not in hist_js,
          "the histogram module is pure maths — no request, no await (options recompute in the browser)")
    analysis_js = _js_text("js/panels/analysis.js")
    for control in ['id: "hist-scale"', 'id: "hist-smoothing"', 'id: "hist-cumulative"',
                    'id: "hist-density"', 'id: "hist-theme"']:
        check(control in analysis_js, f"the histogram exposes {control.split(chr(34))[1]}")
    check("exportPng" in analysis_js and "histogramFileName" in analysis_js,
          "the histogram can be exported as a PNG")
    measure_js = _js_text("js/measure.js")
    for unit in ["mm", "cm", "in"]:
        check(f"{unit}: {{" in measure_js, f"distance supports {unit}")
    check("export function describeDistance" in measure_js,
          "measure.js labels which distance is which")
    check("originalPixels" in measure_js and "/ factor" in measure_js,
          "the original-resolution distance divides by the upload scale")
    check("pxPerUnit" in analysis_js and "unitRateLabel" in analysis_js,
          "the distance panel asks for pixels-per-unit")

    # STEP 2.3: zoom controls exist in exactly one place
    index_zoom_ids = [i for i in ["tb-zoom-in", "tb-zoom-out", "tb-fit", "tb-1to1", "tb-zoom-25"] if f'id="{i}"' in index]
    check(not index_zoom_ids, "the toolbar has no zoom buttons (no duplicate controls)",
          ", ".join(index_zoom_ids))
    viewer_js = _js_text("js/viewer.js")
    check('"viewer-foot"' in viewer_js
          and 'this.zoomInButton' in viewer_js and 'this.zoomOutButton' in viewer_js
          and 'this.fitButton' in viewer_js,
          "the per-viewport footer is where the zoom buttons live")

    # responsiveness: the image workspace survives narrow windows
    check("@media (max-width: 1080px)" in css and "minmax(160px, 1fr)" in css,
          "the image workspace stays usable on narrow desktops")


def check_cors() -> None:
    if not port_open("localhost", 8000):
        skip("API CORS for the frontend origin", "API not running on :8000")
        return
    try:
        request = urllib.request.Request(f"{API}/health", headers={"Origin": ORIGIN})
        with urllib.request.urlopen(request, timeout=5) as response:
            allowed = response.headers.get("Access-Control-Allow-Origin")
        check(allowed == ORIGIN, f"API allows Origin {ORIGIN}", f"got {allowed!r}")
    except Exception as error:  # noqa: BLE001
        check(False, f"API allows Origin {ORIGIN}", str(error))

    try:
        request = urllib.request.Request(
            f"{API}/sessions",
            method="OPTIONS",
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            allowed = response.headers.get("Access-Control-Allow-Origin")
        check(allowed == ORIGIN, "API CORS preflight for POST+content-type", f"got {allowed!r}")
    except Exception as error:  # noqa: BLE001
        check(False, "API CORS preflight for POST+content-type", str(error))


def check_proxy(port: int = PORT) -> None:
    """serve.py forwards /api/* to the backend (used when the page is hosted)."""
    if not port_open("127.0.0.1", port):
        skip("serve.py /api proxy", f"nothing listening on :{port}")
        return
    origin = f"http://127.0.0.1:{port}"
    try:
        status, content_type, body = fetch(f"{origin}/api/health")
        payload = json.loads(body)
        check(status == 200 and "status" in payload, "GET /api/health proxied to the API",
              f"{status} {content_type} {body[:80]!r}")
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            detail = json.loads(payload).get("detail", "")
        except Exception:  # noqa: BLE001
            detail = payload[:80].decode("utf-8", "replace")
        check(error.code == 502, "GET /api/health proxied (API down → 502 JSON)", f"{error.code} {detail[:80]}")
    except Exception as error:  # noqa: BLE001
        check(False, "GET /api/health proxied to the API", str(error))

    try:
        status, _, body = fetch(f"{origin}/api/sessions/nope/images/nope?format=png", headers={"Origin": origin})
        check(False, "proxied 404 keeps the API's detail", f"unexpected {status}")
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read()).get("detail")
        except Exception:  # noqa: BLE001
            detail = None
        check(error.code == 404 and isinstance(detail, str) and "session" in detail.lower(),
              "proxied 404 keeps the API's detail", f"{error.code} {detail!r}")

    try:
        status, content_type, _ = fetch(f"{origin}/index.html", headers={"Origin": origin})
        check("text/html" in content_type, "static files are unaffected by the proxy", content_type)
    except Exception as error:  # noqa: BLE001
        check(False, "static files are unaffected by the proxy", str(error))


def main() -> int:
    print(f"web frontend smoke test — root: {WEB}\n")
    check_serving()
    print()
    check_references()
    print()
    check_no_secrets()
    check_no_innerhtml()
    print()
    check_workstation_layout()
    print()
    check_cors()
    print()
    check_proxy()
    print()
    if FAILURES:
        print(f"RESULT: {len(FAILURES)} failure(s)")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print(f"RESULT: all checks passed ({len(SKIPS)} skipped)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
