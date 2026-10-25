# GeoCluster API

> **Setup and first run:** see the [root README](../README.md). This file is the
> technical reference for the API: endpoints, environment variables and the
> security contract.

The API is a FastAPI backend. It ports the desktop processing code (`desktop/`)
into a framework-independent package (`geocluster/`) and exposes it over HTTP.
It has no PyQt, no torch, no matplotlib and no file-based IPC. The desktop app is
untouched; the duplicated logic lives here on purpose (see
[`docs/migration-decisions.md`](../docs/migration-decisions.md)).

Requirements: Python 3.11. No GL libraries are needed (`opencv-python-headless`).

## Serving modes

| Mode | How | Routes |
| --- | --- | --- |
| Unified (default for local use and Render) | `SERVE_WEB=true` | Frontend at `/`, API under `/api`. The same routes also answer at the root (`/sessions`, `/health`, ...) unless `API_ROOT_ALIASES=false`. |
| API only | `SERVE_WEB` unset or `false` | API at the root (`/sessions`, `/health`, ...). No static files, no `/api` prefix. |

The examples below use the canonical `/api` prefix on `http://localhost:8010`.

`api/` is the import root (`import schemas`), so start the server with
`--app-dir api` from the repository root. `uvicorn api.main:app` is not
supported (see the deployment document for why). Hosting, Render settings and
memory on the free tier are in
[`docs/deployment-render.md`](../docs/deployment-render.md).

## Environment variables (api/.env)

Copy `api/.env.example` to `api/.env` and edit it. Never commit `api/.env`.

Secrets (server-side only; never sent to the browser):

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | AI assistant (Groq). Missing: `/api/ai/chat` answers 503 for questions. The older `FIREWORKS_API_KEY` name is still read as a fallback. Get a key: see the [root README](../README.md#step-3-get-your-keys-optional). |
| `COPERNICUS_CLIENT_ID` / `COPERNICUS_CLIENT_SECRET` | Sentinel-2 fetch. Missing: `/api/satellite/fetch` answers 503. Get them: see the [root README](../README.md#step-3-get-your-keys-optional). |

Non-secret settings (defaults in brackets):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVE_WEB` | `false` | `true` serves `web/` at `/` and moves the API to `/api`. |
| `API_ROOT_ALIASES` | `true` | With `SERVE_WEB=true`, also answer the API at the root. Set `false` to publish `/api` only. |
| `ALLOWED_ORIGINS` | `http` and `127.0.0.1` on ports 3000, 5173 and 8010 | CORS allow-list, comma-separated. A deployment sets its one public origin. |
| `MAX_IMAGE_MEGAPIXELS` | `4` | Larger uploads are downscaled with `cv2.INTER_AREA`. |
| `MAX_UPLOAD_MB` | `15` | Upload size cap (413 above it). |
| `SESSION_TTL_MINUTES` | `60` | Sliding session lifetime. |
| `SESSION_MAX_IMAGES` | `6` | Images per session; the least recently used is evicted. |
| `GLOBAL_MEMORY_MB` | `512` | Global in-memory image budget (507 when exhausted). |
| `SATELLITE_MAX_KM` | `5` | Largest satellite crop, per side, in kilometres. A 5 × 5 km square is the largest crop by default. Larger requests get a 422. |
| `SATELLITE_CACHE_DIR` | the OS temp folder, `geocluster-satellite-cache` | Satellite PNG and place-lookup cache. Disposable and never served over HTTP. |
| `NOMINATIM_USER_AGENT` | `GeoCluster/2.0 (Sentinel-2 crop fetch; +repository URL)` | Identifying User-Agent for OpenStreetMap place lookups. Set your own contact URL for long-running use. |
| `AI_RATE_LIMIT_PER_MINUTE` | `10` | `/api/ai/chat` limit per client IP. `0` disables it. |
| `SATELLITE_RATE_LIMIT_PER_MINUTE` | `5` | `/api/satellite/fetch` limit per client IP. `0` disables it. |
| `ENABLE_DOCS` | `true` | `/api/docs`, `/api/redoc` and `/api/openapi.json`. Set `false` in production. |
| `TRUST_FORWARDED_HEADERS` | `false` | Charge rate limits to the `X-Forwarded-For` client. Set `true` only behind a proxy that overwrites that header (Render, nginx). |

## Endpoints

All endpoints are synchronous. Sessions are in memory and expire. Images are
never overwritten: each operation returns a **new** image id. Run the curl
examples from the repository root so the sample path resolves. The sample is
[`docs/samples/sample-landcover.jpg`](../docs/samples/sample-landcover.jpg).

| Method and path | Body or query | Success | Example |
| --- | --- | --- | --- |
| `POST /api/sessions` | none | 201 `{session_id, ttl_minutes, max_images}` | `curl -X POST http://localhost:8010/api/sessions` |
| `POST /api/sessions/{session_id}/images` | multipart `file=` (an image; decoded from its bytes) | 201 `ImageOut` | `curl -F "file=@docs/samples/sample-landcover.jpg" http://localhost:8010/api/sessions/$SID/images` |
| `GET /api/sessions/{session_id}/images/{image_id}` | query `format=png` (default) or `jpeg` | 200 image bytes | `curl -o out.png "http://localhost:8010/api/sessions/$SID/images/$IID?format=png"` |
| `POST /api/sessions/{session_id}/images/{image_id}/operations/{operation}` | no body for `grayscale`, `negative`, `laplacian`; `{"value": 40}` for `brightness` and `threshold`; `{"window": 3}` for `meanfilter` | 201 `ImageOut` | `curl -X POST -H "Content-Type: application/json" -d "{\"value\":40}" http://localhost:8010/api/sessions/$SID/images/$IID/operations/brightness` |
| `POST /api/sessions/{session_id}/images/{image_id}/kmeans` | `{"k": 5, "max_iter": 30}`; `k` 2 to 20; `maxIter` is also accepted | 200 `labels_image_id`, `display_image_id`, `ranges`, `centroids`, `counts`, `assignments`, `converged`, `iterations` | `curl -X POST -H "Content-Type: application/json" -d "{\"k\":5}" http://localhost:8010/api/sessions/$SID/images/$IID/kmeans` |
| `POST /api/sessions/{session_id}/images/{image_id}/classify` | `{"ranges": {"0": [0, 50], ...}, "assignments": {"0": {"name": "Shadows", "color": [0, 0, 0]}, ...}}` (the ranges and names come from `kmeans`) | 200 `{image_id, legend[]}` | see the request shape above |
| `GET /api/sessions/{session_id}/images/{image_id}/histogram` | none | 200 `{bins}` (256 integers) | `curl http://localhost:8010/api/sessions/$SID/images/$IID/histogram` |
| `GET /api/sessions/{session_id}/images/{image_id}/stats` | none | 200 `{min, max, mean, std}` | `curl http://localhost:8010/api/sessions/$SID/images/$IID/stats` |
| `POST /api/huffman/compress` | multipart `file=` (an image) | 200 `.gch` (GCH2) bytes | `curl -F "file=@docs/samples/sample-landcover.jpg" -o out.gch http://localhost:8010/api/huffman/compress` |
| `POST /api/huffman/decompress` | multipart `file=` (a `.gch` file) | 200 PNG bytes | `curl -F "file=@out.gch" -o back.png http://localhost:8010/api/huffman/decompress` |
| `POST /api/satellite/fetch` | JSON with `session_id`. Place mode: `location`, optional `start` and `end` (`YYYY-MM-DD`), optional `size_km`. Corner mode: `mode: "bbox"`, `corner1` and `corner2` as `"lat, lon"`. Optional `refresh: true` skips the cache. Unknown fields are rejected. | 200 `ImageOut` | `curl -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$SID\",\"location\":\"F-8\"}" http://localhost:8010/api/satellite/fetch` |
| `GET /api/locations` | none | 200 `{sectors, aliases}` | `curl http://localhost:8010/api/locations` |
| `POST /api/ai/chat` | JSON `{"message": "..."}` (1 to 2000 characters). Optional booleans `has_image`, `has_clusters`, `has_history`, `can_undo`, `can_redo`. | 200 `{intent, reply, action, commands[]}` | `curl -X POST -H "Content-Type: application/json" -d "{\"message\":\"histogram\"}" http://localhost:8010/api/ai/chat` |
| `GET /api/health` | none | 200 `{status, ai_configured, satellite_configured, max_image_megapixels}` | `curl http://localhost:8010/api/health` |

Status codes: 201 created · 400 bad Huffman payload · 404 unknown
session, image, operation or location · 413 upload too large · 415 unsupported
or undecodable image · 422 invalid parameters · 429 rate limited (with
`Retry-After`) · 500 unexpected error (generic message) · 502 provider failure
(AI or Copernicus) · 503 not configured · 507 memory budget exhausted.

Every error body is `{"detail": "..."}`. Validation errors list `{type, loc, msg}`
without the submitted value.

## Quick end-to-end example (PowerShell 7 or newer)

`Invoke-RestMethod -Form` needs PowerShell 7. Run this from the repository root:

```powershell
$base = "http://localhost:8010/api"
$sid  = (Invoke-RestMethod -Method Post "$base/sessions").session_id
$img  = Invoke-RestMethod -Method Post "$base/sessions/$sid/images" -Form @{ file = Get-Item docs\samples\sample-landcover.jpg }
$gray = Invoke-RestMethod -Method Post "$base/sessions/$sid/images/$($img.image_id)/operations/grayscale"
$km   = Invoke-RestMethod -Method Post "$base/sessions/$sid/images/$($img.image_id)/kmeans" -ContentType application/json -Body '{"k":5}'
Invoke-RestMethod "$base/sessions/$sid/images/$($img.image_id)/stats"
```

## Ground-scale metadata (`ImageOut`)

`POST /api/satellite/fetch` (and every image it derives from) reports the ground
scale it knows:

| Field | Meaning |
| --- | --- |
| `bbox` | `[west, south, east, north]` of the stored pixels; `null` for uploads. |
| `meters_per_pixel` | Metres that one **stored** pixel covers: `resolution_m / scale`, so a downscale is accounted for; `null` for uploads. |

Filters, K-Means and classify pass the source image's `bbox` through unchanged
and adjust `meters_per_pixel` by the size change (`derive_ground_metadata()` in
`sessions.py`). A derived image never claims a scale it does not have, and an
upload never gains one. The frontend keeps these values with each history state
and carries them across a re-upload, which is what makes the Map composer's
scale bar exact.

## Security

* **Secrets live in environment variables only** (`api/.env` locally, the host's
  environment in a deployment). They are read server-side and never written into
  a response, a log line or the frontend. `api/.env` is git-ignored; the tracked
  `api/.env.example` holds placeholder names with empty values. The audit of the
  repository and its git history is in
  [`docs/security-audit.md`](../docs/security-audit.md).
* **Logs are redacted.** `api/log_safety.py` wraps the log formatters (uvicorn's
  included), so key-shaped strings, `Bearer` headers and `api_key=` or
  `client_secret=` values become `***` in the log line and in a logged traceback.
* **No endpoint returns a secret, a file path or a stack trace.** Domain errors
  are curated sentences. Anything unforeseen becomes
  `{"detail": "The server hit an unexpected error. Try again."}` with the
  traceback logged on the server.
* **CORS is an allow-list** (`ALLOWED_ORIGINS`, localhost by default). A wildcard
  never travels with credentials.
* **`ENABLE_DOCS=false` closes the interactive reference** (404 for `/docs`,
  `/redoc` and `/openapi.json`), so a public deployment does not publish its route
  map.
* **Rate limits per client IP:** `/api/ai/chat` 10 per minute and
  `/api/satellite/fetch` 5 per minute by default (429 with `Retry-After`). These are
  the two endpoints that spend provider quota or call a third party. Behind a
  proxy the socket peer is the proxy, so `TRUST_FORWARDED_HEADERS=true` makes the
  limiter read `X-Forwarded-For`. Only the last entry is believed (the hop the
  trusted proxy appended), so a visitor cannot mint a new identity per request.
  Locally the header is not read at all.
* **Input size limits:** a chat message is capped at 2000 characters (422 above
  it). Uploads are capped while streaming (`MAX_UPLOAD_MB`, 413 above it), and
  uploaded images are capped by pixels (`MAX_IMAGE_MEGAPIXELS`) and decoded from
  their bytes, never trusted by file extension. Session and image ids are
  `secrets.token_urlsafe` values.
* **Nothing on disk is served.** The API has no static-file route. The only bytes
  it returns are images and `.gch` payloads built in memory. The satellite cache
  lives under the OS temp directory and is disposable.
* **The frontend folder publishes only the frontend.** `web/serve.py` and the
  unified server answer 404 for dot-files and parent segments (`/.env`,
  `/.git/config`, `/%2e%2e/api/.env`). The smoke test asserts this.

## Tests

```bash
pytest api/tests -q                      # 341 tests, offline (network mocked)
```

On Windows, skip `test_memory.py` because it imports the Unix-only `resource`
module: `pytest api\tests -q --ignore api\tests\test_memory.py`. The live API
checks and the browser-level boot test are in [`web/README.md`](../web/README.md#tests).
