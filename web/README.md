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

## Configuration

| Setting | How |
| --- | --- |
| API address | `http://localhost:5173/?api=http://127.0.0.1:8000`, or set `localStorage.geocluster.apiBase` |
| API port / credentials | `api/.env` (see `api/.env.example`) |
| CORS | serve the frontend from an origin listed in the API's `ALLOWED_ORIGINS` (defaults include localhost:5173) |
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
```

`node --test` also works from inside `web/`: `node --test "tests/*.test.mjs"`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Banner "Can't reach the API…" | start the API (`uvicorn main:app --port 8000`) and confirm the base URL |
| Browser console shows a CORS error | the page's origin is missing from `ALLOWED_ORIGINS` (or you opened `file://`) — add the origin and restart the API |
| "Your session expired…" toast | expected after an API restart or 60 minutes idle — the image must be uploaded again |
| AI chip says "not configured" | `FIREWORKS_API_KEY` is missing in `api/.env`; commands still work |
| Satellite chip says "not configured" | `COPERNICUS_CLIENT_ID`/`SECRET` missing in `api/.env` |
| Chat answers 502 | the AI provider errored; commands still run — see `docs/frontend-notes.md` |

More detail (error mapping, chat rules, viewer behaviour, known issues) is in
[`docs/frontend-notes.md`](../docs/frontend-notes.md).
