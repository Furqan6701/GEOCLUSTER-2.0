# GeoCluster 2.0 — web console

Static HTML/CSS/JavaScript frontend for the GeoCluster API (`api/`). No build
step, no framework, no keys: the browser talks straight to the API.

## What it does

* **Source** — upload an image (drag & drop or file picker; JPEG/PNG/BMP/TIFF)
  or fetch a Sentinel-2 tile for an Islamabad sector/alias (F-8, NUST, …) with
  optional start/end dates.
* **Filters** — grayscale, negative, laplacian, brightness, threshold and mean
  filter. Each result is a new image id; the original is never overwritten.
* **Clusters** — K-Means (K 2–20, max iterations) with ranges, centroids and
  pixel counts, then a classify editor (per-cluster min/max, land-cover name,
  colour) that returns the recoloured image and legend percentages.
* **Analysis** — 256-bin histogram (linear/log) and min/max/mean/std.
* **Files** — GCH2 Huffman compress to `.gch` (desktop-compatible) and
  decompress back into the session.
* **Assistant** — chat with the API's AI assistant; router commands such as
  `Show me F-8 imagery`, `Run k-means`, `Histogram` and `Compress this image`
  work even when the model is unavailable. Replies are shown as plain text.
* **Viewers** — fit-to-view (small satellite tiles are upscaled), cursor-
  anchored zoom with crisp nearest-neighbour rendering at ≥1:1, pan, pixel
  readout, and a two-click distance tool.

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

Open <http://localhost:5173> and check the chips in the top bar: the API
address, the session id, and whether the AI/satellite credentials are
configured on the server.

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
file input and then clicks through the filters, K-Means (checking the rendered
range table), classify, histogram/stats, GCH2 compress → decompress, the chat
router commands and the session-expired recovery path. It skips itself (exit 0)
when jsdom or the API is missing.

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
