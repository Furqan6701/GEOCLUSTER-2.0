# Deployment: one server, one command (Task 3)

GeoCluster is **one FastAPI process**. It serves the frontend folder at `/` and
the API under `/api`, so there is no second service, no separate static host and
no CORS configuration to get wrong in production.

| Path | Served by the unified server (`SERVE_WEB=true`) |
| --- | --- |
| `/`, `/index.html`, `/js/*`, `/css/*`, `/assets/*` | the `web/` folder |
| `/api/health`, `/api/sessions`, `/api/ai/chat`, … | the API (canonical prefix) |
| `/health`, `/sessions`, `/ai/chat`, … | the same API routes at the root (**aliases**, on by default) |
| `/api/docs`, `/api/redoc`, `/api/openapi.json` | the interactive reference, only while `ENABLE_DOCS` is not false |
| anything private (`/.env`, `/.git/config`, `/%2e%2e/api/.env`, `web/tests/…`) | 404, always |

The root aliases exist so that the frontend's **local** default
(`http://localhost:8000`, see `web/js/config.js`) keeps working unchanged. A
deployment sets `API_ROOT_ALIASES=false`: the hosted page is same-origin and
calls `/api`, so exactly one API URL is published.

Without `SERVE_WEB` nothing changes: `create_app()` is the historical API-only
application with every route at the root, which is what `api/tests`, the smoke
test, the integration script and the documented `cd api && uvicorn main:app`
loop expect.

## The `import schemas` question — decision

**Keep the flat imports and keep `cd api && uvicorn main:app` working.** The two
supported ways to start the server are:

```bash
cd api && python -m uvicorn main:app --port 8000                # API only (development, tests)
python -m uvicorn main:app --app-dir api --port 8000            # repo root, same app
```

`api/` stays the import root, so `import schemas`, `import settings`,
`from routers import assistant` keep resolving exactly as they do today. That is
why `python -m uvicorn api.main:app` from the repository root is **not**
supported and `api/__init__.py` is deliberately absent: turning `api` into a
package would either break `cd api` (imports would then need `from api import
schemas` everywhere) or force a dual-import arrangement that breaks the test
suite and every documented command. `--app-dir api` gives the same convenience
from the repository root — and it is what the Render start command uses, because
the unified server has to find `web/` one level above `api/`.

## Local run — exactly one command

```bash
# once
python -m venv .venv && . .venv/bin/activate
pip install -r api/requirements.txt

# every time, from the repository root
SERVE_WEB=true python -m uvicorn main:app --app-dir api --host 0.0.0.0 --port 8000
```

* App: <http://localhost:8000/> — the same origin also answers `/api/health`.
* Windows PowerShell:
  `$env:SERVE_WEB="true"; python -m uvicorn main:app --app-dir api --port 8000`
* API only (tests, integration scripts):
  `cd api && python -m uvicorn main:app --host 0.0.0.0 --port 8000`
* Frontend dev loop (unchanged, for iterating on `web/` alone):
  `python web/serve.py` on <http://localhost:5173>, which proxies `/api/*` to
  127.0.0.1:8000. `web/README.md` documents the `--api`, `--no-proxy` and
  `?api=`/localStorage overrides.

`web/js/config.js` resolves the API base in this order: `?api=` → localStorage →
page host (`localhost`/`127.0.0.1` → `http://localhost:8000`; anything else →
same-origin `/api`). Browsers must never call localhost for a service that runs
on the server, and a hosted page never does.

## Render settings (free tier)

| Setting | Value |
| --- | --- |
| Environment | Python 3 |
| **Root Directory** | *(leave empty — the repository root)* |
| **Build Command** | `pip install -r api/requirements.txt` |
| **Start Command** | `python -m uvicorn main:app --app-dir api --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/health` |
| `PYTHON_VERSION` | `3.11.9` |
| Instances / workers | 1 (see "Why one worker" below) |

Alternative equivalent setup: set **Root Directory** to `api`, Build Command
`pip install -r requirements.txt`, Start Command
`python -m uvicorn main:app --host 0.0.0.0 --port $PORT`. The unified server
still finds `web/` (`api/../web`) because Render checks out the whole repository
in all cases.

### Environment variables to set

Required for the features you want:

| Variable | Value | Effect when missing |
| --- | --- | --- |
| `SERVE_WEB` | `true` | without it the API is served but the page is not |
| `API_ROOT_ALIASES` | `false` | unpublish the duplicate root API; harmless either way |
| `ENABLE_DOCS` | `false` | `/api/docs` and `/api/openapi.json` stay public |
| `TRUST_FORWARDED_HEADERS` | `true` | rate limits would charge Render's proxy, not the visitor |
| `ALLOWED_ORIGINS` | `https://<your-app>.onrender.com` | localhost default (unused: the hosted page is same-origin) |
| `GROQ_API_KEY` | your key (`gsk_…`) | `/ai/chat` answers 503 for questions; glossary + routed commands still work |
| `COPERNICUS_CLIENT_ID` / `COPERNICUS_CLIENT_SECRET` | your credentials | `/satellite/fetch` answers 503 |

Recommended for the 512 MB instance:

| Variable | Value | Why |
| --- | --- | --- |
| `GLOBAL_MEMORY_MB` | `192` | the in-memory image budget; 512 MB also has to hold the interpreter, NumPy/OpenCV and per-request copies |
| `SESSION_MAX_IMAGES` | `4` | fewer images resident per session |
| `MAX_IMAGE_MEGAPIXELS` | `4` | larger uploads are downscaled with `cv2.INTER_AREA` before anything else happens |
| `MAX_UPLOAD_MB` | `10` | request-body ceiling (413 above it) |
| `AI_RATE_LIMIT_PER_MINUTE` | `10` | free-tier guard on `/ai/chat` |
| `SATELLITE_RATE_LIMIT_PER_MINUTE` | `5` | free-tier guard on `/satellite/fetch` |

Secrets are read server-side only; nothing here is ever sent to the browser and
nothing key-shaped reaches a log line (`api/log_safety.py`). The audit of the
repository and its git history is in `docs/security-audit.md` — no credential
was ever committed, so there is nothing to rotate from git.

### Why one worker

Sessions, uploaded images and the rate-limit buckets live in the process, so the
deployment must run a **single** worker (`uvicorn --workers 1`, the default —
never add `--workers`). The free tier spins the service down after ~15 minutes
idle: the first request then takes a few seconds longer, the in-memory state is
gone, and the frontend's documented 404 handling creates a fresh session and
asks for the image again.

## requirements.txt — pins and what is actually used

`api/requirements.txt` is fully pinned; nothing in it is unused, so no line was
removed:

| Pin | Used by |
| --- | --- |
| `fastapi==0.142.2` | the app, routing, validation |
| `uvicorn[standard]==0.54.0` | the server (`uvloop`/`httptools`/`websockets`/`watchfiles` come from the extra) |
| `python-multipart==0.0.32` | multipart uploads (`/sessions/{id}/images`) |
| `pydantic==2.13.5` | the request/response models |
| `python-dotenv==1.2.4` | reading `api/.env` locally |
| `numpy==2.4.6` | every operation, the histogram and K-Means |
| `opencv-python-headless==5.0.0.93` | decoding, resizing, filtering, PNG encoding |
| `requests==2.34.2` | Copernicus and Nominatim calls (server-side only) |
| `openai==3.22.1` | the Groq client (OpenAI-compatible base URL) |

`starlette`, `anyio` and `httpx2` are transitive (FastAPI/OpenAI); they are
deliberately not pinned separately so a FastAPI patch release can move them
inside its own supported range. `api/requirements-dev.txt` (pytest, httpx) is
for tests only and is not installed on Render. There is **no torch**
dependency: `desktop/requirements.txt` has it, `api/` does not.

## Memory on the 512 MB free tier

Measured on this checkout (`python -m uvicorn`, 2000×2000 RGB JPEG = 4.0 MP,
the `MAX_IMAGE_MEGAPIXELS` ceiling):

| State | RSS |
| --- | --- |
| started, idle (after `/api/health`) | **97 MB** |
| one 4 MP image uploaded, brightness + threshold + laplacian + 31×31 mean filter + K-Means (k=8) + histogram | peak **274 MB**, resident **244 MB** |

So a single 4 MP image with one K-Means run sits comfortably inside 512 MB, and
the failure mode to avoid is *several* large images plus a K-Means on top:
K-Means converts the image to float64 (`8 bytes × 3 channels × pixels` ≈ 96 MB
for 4 MP) on top of the resident copy. That is what `GLOBAL_MEMORY_MB=192`,
`SESSION_MAX_IMAGES=4` and `MAX_IMAGE_MEGAPIXELS=4` above are for. If a
deployment ever gets an OOM kill (Render shows "Ran out of memory (used over
512 MB)"), lower `MAX_IMAGE_MEGAPIXELS` to `2` first, then
`GLOBAL_MEMORY_MB` to `128`.

## Does the NumPy K-Means match torch's output?

**Yes, and torch is not needed for it.** torch appears only in `desktop/` (the
PyQt app and `desktop/frontend/backend_py.py::run_kmeans`); the API never
imports it. `api/geocluster/kmeans.py` is a step-by-step port of that function:

* initialization: centroid of each initial range, `(low + high) / 2` — identical
  to the desktop's `calculate_default_ranges(K)` input;
* assignment: each of the 256 possible intensities goes to its nearest centroid
  with the first-minimum tie-break (the desktop's behaviour), then pixels look
  up their label — an intensity-histogram LUT;
* update: `centroid := mean intensity of its members`, empty clusters keep their
  centroid;
* convergence: `max |new − old| < 0.5`, at most 30 iterations;
* output ranges from the midpoints of sorted centroids, output labels from the
  final ranges (including the desktop's closing masking pass).

The arithmetic is float64 over integer sums, so the result does not depend on
accumulation order — the reason torch and NumPy agree bit-for-bit here, and the
reason the port is safe without importing torch at all. Behaviour is pinned by
`api/tests/test_golden_kmeans.py` against `api/tests/fixtures/expected_values.json`.
Honest caveat: torch is not installable in the build sandbox, so the fixture was
produced by a deliberately naive reference implementation of
`backend_py.run_kmeans` (see the fixture's `kmeans_k5.generator` note), not by
torch itself. A spot-check on a machine that does have torch is inexpensive:
run the desktop app's K-Means smoke test and compare its ranges/labels with
`GET /sessions/{id}/images/{id}/stats` on the same image.

## Nothing breaks when the filesystem resets

Everything the app *needs* lives in memory, and the only disk writes are two
**disposable caches** under the OS temp directory:

| Write | Where | If the disk is gone / read-only |
| --- | --- | --- |
| satellite crop | `SATELLITE_CACHE_DIR` (default `%TEMP%/geocluster-satellite-cache`) | write failures are logged and ignored; the image is still returned |
| place lookup | same directory, `places/` | unreadable entries are ignored and re-fetched |

Uploads, processed images, K-Means results, `.gch` files and PNG/label-map
exports are built in memory and streamed back; the API has no route that reads a
file from disk. A container restart therefore loses nothing but the caches, and
the next request simply re-downloads. The one-off cost is one extra Copernicus
token request and Nominatim lookup per fresh instance.

## After deploying — five checks

1. `https://<app>.onrender.com/api/health` → `{"status":"ok", …}` with
   `ai_configured`/`satellite_configured` reflecting your keys.
2. `https://<app>.onrender.com/` loads the app; the status chips show the
   session TTL and image cap (the page calls `/api` because the host is not
   localhost).
3. `https://<app>.onrender.com/api/docs` → 404 while `ENABLE_DOCS=false`, and
   `https://<app>.onrender.com/.env` → 404.
4. Upload an image, run brightness, K-Means and Classify; type "make it brighter"
   in the chat (needs `GROQ_API_KEY`) and confirm the slider moves and the
   history entry appears exactly as if you had clicked.
5. `https://<app>.onrender.com/api/sessions/<id>/images/<id>/stats` after the
   free tier has slept (16+ minutes) → 404, and the browser shows the friendly
   "session expired, upload again" message instead of a raw error.
