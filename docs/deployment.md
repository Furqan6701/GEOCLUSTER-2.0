# Deploying on Render

This guide describes one way to host GeoCluster 2.0 on Render's free tier as a
single web service. The service serves the web page and the API from the same
origin, so the browser never needs a separate API address.

## Service settings

| Setting | Value |
| --- | --- |
| Environment | Python 3 |
| Root Directory | leave empty (the repository root) |
| Build Command | `pip install -r api/requirements.txt` |
| Start Command | `python -m uvicorn main:app --app-dir api --host 0.0.0.0 --port $PORT` |
| Health Check Path | `/api/health` |
| Python version | set the environment variable `PYTHON_VERSION` to `3.11.9` |

The start command must bind to `0.0.0.0` and to the `$PORT` value that Render
provides. Do not add `--workers`: the service must run a single worker (see
[Free tier behavior](#free-tier-behavior)).

## Environment variables

Set these in the Render dashboard under **Environment**. Values are never
stored in the repository.

| Variable | What to set |
| --- | --- |
| `SERVE_WEB` | `true`, so the service also serves the web page |
| `ENABLE_DOCS` | `false`, so the interactive API documentation is not public |
| `TRUST_FORWARDED_HEADERS` | `true`, so rate limits apply to each visitor rather than Render's proxy |
| `ALLOWED_ORIGINS` | your public address, for example `https://your-app.onrender.com` (no trailing slash) |
| `GROQ_API_KEY` | your Groq key, used by the chat assistant. Without it, chat answers with a friendly message, and the command shortcuts keep working. |
| `COPERNICUS_CLIENT_ID` | your Copernicus Data Space client ID, used for satellite imagery |
| `COPERNICUS_CLIENT_SECRET` | your Copernicus Data Space client secret, used for satellite imagery |

Without the two Copernicus variables, satellite fetching reports that imagery is
not configured. The rest of the application still works.

Optional tuning for the 512 MB free instance: `GLOBAL_MEMORY_MB`,
`SESSION_MAX_IMAGES`, `MAX_IMAGE_MEGAPIXELS`, `MAX_UPLOAD_MB`,
`AI_RATE_LIMIT_PER_MINUTE`, and `SATELLITE_RATE_LIMIT_PER_MINUTE`. The defaults
are in `api/.env.example`, with a comment on each one.

## Free tier behavior

- **Sleep:** the free tier stops the service after about 15 minutes without
  requests. The next request waits a few seconds while the service starts again.
- **Memory is cleared on sleep:** uploaded images and sessions are kept in
  memory, so they are lost when the service sleeps. The web page handles this:
  when a session has expired, it starts a new one and asks you to upload the
  image again.
- **One worker:** sessions and rate limits live in the process, so run exactly
  one worker.
- **Memory limit:** the instance has 512 MB of memory. Large images are
  downscaled on upload (see `MAX_IMAGE_MEGAPIXELS`).

## Checking the deployment

1. Open `https://your-app.onrender.com/api/health`. It should return a JSON
   object with `"status": "ok"`.
2. Open `https://your-app.onrender.com/`. The web page should load.
3. Upload a small image and run a filter, such as grayscale.
4. Confirm that `https://your-app.onrender.com/api/docs` returns 404, because
   `ENABLE_DOCS` is `false`.

## Security notes

- Secrets are read from environment variables on the server only. They are not
  sent to the browser and are not written to logs.
- Do not commit a `.env` file. The repository ignores `.env` files and includes
  only `api/.env.example`, which contains no real values.
