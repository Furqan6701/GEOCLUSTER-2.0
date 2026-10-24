# GeoCluster API

FastAPI backend for GeoCluster 2.0. It ports the desktop processing code
(`desktop/`) into a framework-independent package (`geocluster/`) and exposes
it over HTTP. No PyQt, no torch, no matplotlib, no file-based IPC.

The desktop app is untouched and keeps working; the duplicated logic lives in
`api/` on purpose (see `docs/migration-decisions.md` at the repository root).

## Requirements

* Python 3.11
* No GL libraries needed (`opencv-python-headless`)

## Windows PowerShell — first time

```powershell
cd api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt          # runtime
pip install -r requirements-dev.txt      # tests (pytest, httpx)
Copy-Item .env.example .env              # then edit .env and paste your keys
```

## Run locally — one command

From the repository root, with the venv active (`api/.venv`):

```powershell
$env:SERVE_WEB="true"
python -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8010
```

```bash
SERVE_WEB=true python -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8010
```

Then open **<http://localhost:8010/>**. The same process serves the frontend
from `web/` and the API under `/api` (the root routes also answer, so the
frontend's local default keeps working). Interactive docs:
<http://localhost:8010/api/docs>; health: <http://localhost:8010/api/health>.

The app is at <http://localhost:8010/>, `/api/docs` is the interactive
reference (404 once `ENABLE_DOCS=false`), and `/.env`,
`/.git/config`, `/api/main.py`, `/tests/…` answer 404 by rule.
`API_ROOT_ALIASES=false` publishes `/api` only; `TRUST_FORWARDED_HEADERS=true`
is for running behind a proxy. Everything about deployment — Render settings,
environment variables, memory on the free tier, requirements and what happens
when the filesystem resets — is in
[`docs/deployment-render.md`](../docs/deployment-render.md).

`api/` stays the import root (`import schemas`), so start the server with
`cd api` or with `--app-dir api`; `uvicorn api.main:app` is not supported (see
the deployment document for why).

## Windows PowerShell — tests

```powershell
cd api
.\.venv\Scripts\Activate.ps1
pytest -q                                # ~340 tests, all offline (network mocked)
python tests/bench_4mp.py                # optional timing report
```

## macOS / Linux quickstart

```bash
cd api
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env                     # add your keys
pytest -q
cd .. && SERVE_WEB=true python -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8010
# then open http://localhost:8010/
```

## Environment variables (`api/.env`)

Secrets (server-side only — never send them to the browser):

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | AI assistant (Groq). Missing → `/ai/chat` answers 503. The older `FIREWORKS_API_KEY` name is still read as a fallback. |
| `COPERNICUS_CLIENT_ID` / `COPERNICUS_CLIENT_SECRET` | Sentinel-2 fetch. Missing → `/satellite/fetch` answers 503. |

Non-secret settings (defaults in brackets):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | localhost:3000/5173/8010 (http and 127.0.0.1) | CORS allow-list |
| `MAX_IMAGE_MEGAPIXELS` | `4` | Larger uploads are downscaled with `cv2.INTER_AREA` |
| `MAX_UPLOAD_MB` | `15` | Upload size cap (413 above it) |
| `SESSION_TTL_MINUTES` | `60` | Sliding session lifetime |
| `SESSION_MAX_IMAGES` | `6` | Per-session images; least-recently-used is evicted |
| `GLOBAL_MEMORY_MB` | `512` | Global in-memory image budget |
| `SATELLITE_CACHE_DIR` | `%TEMP%/geocluster-satellite-cache` (OS temp dir) | Satellite PNG cache |
| `AI_RATE_LIMIT_PER_MINUTE` | `10` | `/ai/chat` limit per client IP |
| `SATELLITE_RATE_LIMIT_PER_MINUTE` | `5` | `/satellite/fetch` limit per client IP |
| `ENABLE_DOCS` | `true` | `/docs`, `/redoc` and `/openapi.json`; set `false` in production |
| `TRUST_FORWARDED_HEADERS` | `false` | Charge rate limits to the `X-Forwarded-For` client (set `true` behind Render/nginx) |

## Security

* **Secrets live in environment variables only** (`api/.env` locally, the host's
  env vars in a deployment). They are read server-side, never written into a
  response, a log line or the frontend. `api/.env` is gitignored; the tracked
  `api/.env.example` holds placeholder names with empty values. The audit of the
  repository and its full git history (`docs/security-audit.md`) found no key,
  token or credential ever committed.
* **Logs are redacted.** `api/log_safety.py` wraps the log formatters (uvicorn's
  included) so any key-shaped string — `gsk_…`, `sk-…`, a `Bearer` header, an
  `api_key=` / `client_secret=` value — becomes `***` in the log line *and* in a
  logged traceback, while the error and the traceback stay readable.
* **No endpoint returns a secret, a file path or a stack trace.** Domain errors
  are curated sentences; validation errors are `{type, loc, msg}` without the
  submitted value; anything unforeseen becomes
  `{"detail": "The server hit an unexpected error. Try again."}` with the
  traceback logged server-side.
* **CORS is an allow-list** (`ALLOWED_ORIGINS`, localhost by default). A
  deployment sets its one public origin; a wildcard never travels with
  credentials.
* **`ENABLE_DOCS=false` closes the interactive reference** (404 for `/docs`,
  `/redoc`, `/openapi.json`) so a public deployment does not publish its route
  map.
* **Rate limits per client IP**: `/ai/chat` 10/min and `/satellite/fetch`
  5/min by default (429 with `Retry-After`) - the two endpoints that spend
  provider quota or fetch from a third party. Behind a proxy the socket peer is
  the proxy, so `TRUST_FORWARDED_HEADERS=true` makes the limiter read
  `X-Forwarded-For`. Only the **last** entry is believed (that is the hop the
  trusted proxy appended); client-supplied entries to its left are ignored, so a
  visitor cannot mint a fresh identity per request. Locally the header is not
  read at all.
* **Input size limits**: a chat message is capped at 2000 characters and
  rejected with 422; uploads (images and `.gch` files) are capped while
  streaming (`MAX_UPLOAD_MB`, 15) and rejected with 413; uploaded images are
  additionally capped by pixels (`MAX_IMAGE_MEGAPIXELS`, 4) and decoded from
  their bytes, never trusted by extension. Session ids and image ids are
  `secrets.token_urlsafe` values, and each session keeps at most
  `SESSION_MAX_IMAGES` images inside a global `GLOBAL_MEMORY_MB` budget.
* **Nothing on disk is served**: the API has no static-file route; the only
  bytes it returns are images/`.gch` payloads built in memory. The satellite
  cache lives under the OS temp directory and is disposable.
* **The frontend folder publishes only the frontend.** `web/serve.py` (and the
  unified server, see `docs/deployment-render.md`) answers 404 for dot-files and
  parent segments - `/.env`, `/.git/config`, `/%2e%2e/api/.env` - so a stray
  file or symlink inside `web/` is not on the internet by accident. The smoke
  test asserts this.

### Ground-scale metadata (`ImageOut`)

`POST /satellite/fetch` (and every image it derives from) reports the ground
scale it knows:

| Field | Meaning |
| --- | --- |
| `bbox` | `[west, south, east, north]` of the stored pixels; `null` for uploads |
| `meters_per_pixel` | metres one **stored** pixel covers — `resolution_m / scale`, so a downscale is accounted for; `null` for uploads |

Filters, K-Means and classify pass the source image's `bbox` through unchanged
and adjust `meters_per_pixel` by the size change (`derive_ground_metadata()` in
`sessions.py`), so a derived image never claims a scale it does not have — and
an upload never gains one. The frontend keeps these values with each history
state and carries them across a re-upload, which is what lets the Map
composer's scale bar be exact.

## Endpoints

All endpoints are synchronous. Sessions are in-memory and expire; images are
never overwritten — each operation returns a **new** image id.

| Method & path | Body / query | Success | Example |
| --- | --- | --- | --- |
| `POST /sessions` | – | 201 `{session_id, ttl_minutes, max_images}` | `curl -X POST http://localhost:8010/sessions` |
| `POST /sessions/{sid}/images` | multipart `file=` | 201 `ImageOut` | `curl -F "file=@../desktop/images/sample.jpg" http://localhost:8010/sessions/$SID/images` |
| `GET /sessions/{sid}/images/{iid}` | `?format=png\|jpeg` | 200 image bytes | `curl -o out.png "http://localhost:8010/sessions/$SID/images/$IID?format=png"` |
| `POST /sessions/{sid}/images/{iid}/operations/{op}` | op ∈ grayscale, negative, laplacian (no body); brightness `{"value":40}`; threshold `{"value":128}`; meanfilter `{"window":3}` | 201 `ImageOut` | `curl -X POST -H "Content-Type: application/json" -d "{\"value\":40}" http://localhost:8010/sessions/$SID/images/$IID/operations/brightness` |
| `POST /sessions/{sid}/images/{iid}/kmeans` | `{"k":5,"max_iter":30}` (`maxIter` also accepted) | 200 labels/display ids, ranges, centroids, counts | `curl -X POST -H "Content-Type: application/json" -d "{\"k\":5}" http://localhost:8010/sessions/$SID/images/$IID/kmeans` |
| `POST /sessions/{sid}/images/{iid}/classify` | `{"ranges":{"0":[0,50],...},"assignments":{"0":{"name":"Shadows","color":[0,0,0]},...}}` | 200 `{image_id, legend[]}` | see the e2e script below |
| `GET /sessions/{sid}/images/{iid}/histogram` | – | 200 `{bins:[256 ints]}` | `curl http://localhost:8010/sessions/$SID/images/$IID/histogram` |
| `GET /sessions/{sid}/images/{iid}/stats` | – | 200 `{min,max,mean,std}` | `curl http://localhost:8010/sessions/$SID/images/$IID/stats` |
| `POST /huffman/compress` | multipart `file=` | 200 `.gch` (GCH2) bytes | `curl -F "file=@../desktop/images/sample.jpg" -o out.gch http://localhost:8010/huffman/compress` |
| `POST /huffman/decompress` | multipart `file=*.gch` | 200 PNG bytes | `curl -F "file=@out.gch" -o back.png http://localhost:8010/huffman/decompress` |
| `POST /satellite/fetch` | `{"session_id":…, "location":"F-8", "start":"2026-08-01", "end":"2026-10-02"}` | 200 `ImageOut` | `curl -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$SID\",\"location\":\"F-8\"}" http://localhost:8010/satellite/fetch` |
| `GET /locations` | – | 200 `{sectors, aliases}` | `curl http://localhost:8010/locations` |
| `POST /ai/chat` | `{"message":"show me F-8"}` | 200 `{intent, reply, commands[]}` | `curl -X POST -H "Content-Type: application/json" -d "{\"message\":\"histogram\"}" http://localhost:8010/ai/chat` |
| `GET /health` | – | 200 `{status, ai_configured, satellite_configured, max_image_megapixels}` | `curl http://localhost:8010/health` |

Status codes: 201 image created · 400 bad Huffman payload · 404 unknown
session/image/operation/location · 413 upload too large · 415 unsupported or
undecodable image · 422 invalid parameters · 429 rate limited · 502 provider
failure (AI or Copernicus) · 503 not configured · 507 memory budget exhausted.

## Quick end-to-end example

```powershell
$base = "http://localhost:8010"
$sid  = (Invoke-RestMethod -Method Post "$base/sessions").session_id
$img  = Invoke-RestMethod -Method Post "$base/sessions/$sid/images" -Form @{ file = Get-Item ..\desktop\images\sample.jpg }
$gray = Invoke-RestMethod -Method Post "$base/sessions/$sid/images/$($img.image_id)/operations/grayscale"
$km   = Invoke-RestMethod -Method Post "$base/sessions/$sid/images/$($img.image_id)/kmeans" -ContentType application/json -Body '{"k":5}'
Invoke-RestMethod "$base/sessions/$sid/images/$($img.image_id)/stats"
```
