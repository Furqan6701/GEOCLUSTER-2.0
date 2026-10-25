# GeoCluster 2.0

**Browser-based satellite image analysis and K-Means land-cover mapping.**

GeoCluster 2.0 fetches a Sentinel-2 true-colour crop for a place or coordinate
pair, clusters its pixels with K-Means, turns the clusters into a classified
map, and lets you compose that map with a title, legend, scale bar and north
arrow. It runs in any modern browser, backed by a FastAPI server.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Problem Statement

GIS and remote sensing image analysis is usually locked behind heavy desktop
software: large installs, specialist licences and hardware that students and
small teams often do not have. This project makes the core tools available in
a browser, so that anyone with an internet connection can fetch satellite
imagery, cluster it and produce a labelled map.

## Solution and Features

Everything below exists in the code today.

- **Satellite fetch** of Sentinel-2 true-colour imagery by **place name**
  (sectors, aliases and free-text places) or by **coordinates** (two corners).
  A crop may be at most **5 km per side** (a 5 × 5 km square at the largest),
  set by `SATELLITE_MAX_KM`.
- **K-Means clustering** of image intensities, with editable class ranges and
  names.
- **Classification** that applies the clusters as ranges and generates the
  classified map.
- **Map composer** with an editable title, legend (five placements), scale bar,
  north arrow, credit line and size controls, exported as one PNG.
- **Spatial filters**: mean (box blur), Laplacian edge detection, negative and
  grayscale.
- **Brightness and threshold sliders with live preview.** The preview is drawn
  in the browser while you drag; the server's exact result replaces it on
  release.
- **Histogram windows**: 256-bin histograms and statistics, in one or more
  windows.
- **Huffman compression** to a lossless `.gch` (GCH2) file and back.
- **Distance tool** that measures on the image in pixels, or in ground units
  when the satellite scale is known.
- **Undo and redo** (up to 15 steps), a zoom/fit toolbar, and a
  keyboard-shortcut dialog.
- **AI assistant** (Groq). Ask it in plain language to run a filter, K-Means,
  classification or a tool. It can only choose from a fixed list of actions,
  every parameter is range-checked on the server, and it can never pick
  satellite coordinates or trigger a satellite download by itself. Tool
  questions ("what is the mean filter?") are answered offline from a built-in
  glossary, with no model call.

## Technology Stack

| Layer | Technology |
| --- | --- |
| Backend API | Python 3.11, FastAPI, Uvicorn, Pydantic |
| Image processing | NumPy, OpenCV (headless) |
| AI assistant | Groq API (`llama-3.3-70b-versatile`, JSON output) via the OpenAI Python SDK |
| Satellite data | Copernicus Data Space Ecosystem (Sentinel-2 L2A, Process API) |
| Place lookup | OpenStreetMap Nominatim |
| Frontend | Plain HTML, CSS and ES-module JavaScript (no framework, no build step) |
| Tests | pytest, Node's built-in test runner, jsdom for the browser boot test |

## Architecture

```
Browser (web/)                           FastAPI server (api/)
┌──────────────────────────┐   same     ┌──────────────────────────────────┐
│ index.html, css/, js/    │◀─ origin ─▶│ /         → web/ (SERVE_WEB=true) │
│ panels, viewers, map     │            │ /api/*    → REST routes           │
│ composer, live preview   │            │   sessions, uploads, filters,     │
└──────────────────────────┘            │   K-Means, classify, histogram,   │
                                        │   Huffman, satellite, AI chat     │
                                        │ in-memory sessions (TTL, limits)  │
                                        └──────┬───────────┬────────────┬───┘
                                               │           │            │
                                        Copernicus    Groq API     Nominatim
                                        (imagery)     (assistant)  (place names)
```

* **One process, one origin.** With `SERVE_WEB=true` the same FastAPI app serves
  the frontend at `/` and the API under `/api`, so the browser calls relative
  URLs and no CORS setup is needed for the hosted page.
* **Sessions are in memory.** Images live in the server process for a sliding
  time-to-live and a per-session image limit. A server restart asks the user to
  upload again. Uploads and results are never written to disk; only disposable
  satellite-download caches go to the operating system's temp folder.
* **Secrets stay on the server.** Keys are read from environment variables and
  are never sent to the browser. Logs are redacted, and errors are generic.
* **The frontend has no build step.** Open-source readers can follow it file
  by file under `web/js/`.

More detail: [`api/README.md`](api/README.md) (endpoints, limits, environment
variables), [`web/README.md`](web/README.md) (frontend and its tests),
[`docs/deployment-render.md`](docs/deployment-render.md) (hosting),
[`docs/security-audit.md`](docs/security-audit.md) (security review).

## Setup Instructions

You need **Python 3.11** and a copy of this repository. Every command below runs
from the repository root, the folder that contains `api/`, `web/` and `docs/`.

Get the code:

```bash
git clone https://github.com/Furqan6701/GEOCLUSTER-2.0.git
cd GEOCLUSTER-2.0
```

### Step 1: Create the virtual environment and install the requirements

**Windows (PowerShell):**

```powershell
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r api\requirements.txt
```

If `python` is not Python 3.11, use the launcher instead: `py -3.11 -m venv venv`.

You do not need to activate the environment. Calling `.\venv\Scripts\python.exe`
directly always uses it. This matters when PowerShell blocks `Activate.ps1` with
its execution policy. If you do want to activate it, run
`.\venv\Scripts\Activate.ps1` and then use `python` as usual.

**macOS and Linux:**

```bash
python3.11 -m venv venv
source venv/bin/activate
pip install -r api/requirements.txt
```

### Step 2: Create your `.env` file

**Windows (PowerShell):**

```powershell
Copy-Item api\.env.example api\.env
```

**macOS and Linux:**

```bash
cp api/.env.example api/.env
```

Open `api/.env` in a text editor and fill in the keys you have (step 3). Every
key is optional: without a Groq key the AI chat answers with a notice, and
without Copernicus credentials satellite fetch is unavailable. Everything else
keeps working. `api/.env` is git-ignored, so it stays on your machine. Never
commit it.

### Step 3: Get your keys (optional)

**Groq key (AI assistant):**

1. Sign in at [console.groq.com](https://console.groq.com) (you can use a Google account).
2. Open **API Keys** at [console.groq.com/keys](https://console.groq.com/keys).
3. Click **Create API Key**, give it a name, and copy the key. Groq shows it once.
4. Paste it into `api/.env` as `GROQ_API_KEY=` followed by the key.

**Copernicus client ID and secret (satellite fetch):**

1. Create a free account at [dataspace.copernicus.eu](https://dataspace.copernicus.eu) and sign in.
2. Open your profile menu, choose **Sentinel Hub**, and open the **Sentinel Hub Dashboard**.
3. Go to **User settings** and find the **OAuth clients** section.
4. Click **Create**, give the client a name, choose an expiry date, and set the supported flow to **Client Credentials**.
5. Click **Create**. The **client ID** and **client secret** appear. Copy both now: the secret is shown **once** and cannot be retrieved later.
6. Paste them into `api/.env` as `COPERNICUS_CLIENT_ID=` and `COPERNICUS_CLIENT_SECRET=`.

Restart the server after you edit `api/.env`.

The other settings in `api/.env` have safe defaults. The full list is in
[`api/README.md`](api/README.md#environment-variables-apienv).

### Step 4: Start the app

Start the server from the repository root. It runs in the foreground, so keep
the terminal open while you use the app.

**Windows (PowerShell):**

```powershell
$env:SERVE_WEB="true"
.\venv\Scripts\python.exe -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8010
```

**macOS and Linux:**

```bash
SERVE_WEB=true python -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8010
```

The app is set up for port 8010 on localhost. Keep that port unless you also read
[`web/README.md`](web/README.md#where-the-api-request-goes), which explains how the page finds the API.

### Step 5: Open the app

| What | Address |
| --- | --- |
| The app | <http://localhost:8010/> |
| Health check | <http://localhost:8010/api/health> |
| Interactive API reference | <http://localhost:8010/api/docs> |

The health check reports whether the AI and satellite credentials are configured,
without showing their values. Stop the server with `Ctrl+C`.

### Run the tests (optional)

Install the test requirements once (they go on top of the runtime requirements):

**Windows (PowerShell):**

```powershell
.\venv\Scripts\python.exe -m pip install -r api\requirements.txt -r api\requirements-dev.txt
.\venv\Scripts\python.exe -m pytest api\tests -q --ignore api\tests\test_memory.py
node --test web/tests/logic.test.mjs
```

**macOS and Linux:**

```bash
pip install -r api/requirements.txt -r api/requirements-dev.txt
python -m pytest api/tests -q
node --test web/tests/logic.test.mjs
```

`api/tests/test_memory.py` uses the Unix-only `resource` module, so it is skipped
on Windows with `--ignore`. The Node tests need Node 18 or newer and no browser.
The browser-level boot test and the live API checks are described in
[`web/README.md`](web/README.md#tests).

## Demo

> Placeholders. Replace each one before the public release.

| | |
| --- | --- |
| ![Screenshot: fetching a Sentinel-2 crop](docs/images/TODO-fetch.png) | ![Screenshot: K-Means clusters and classification](docs/images/TODO-kmeans.png) |
| *TODO: caption, fetch by place name* | *TODO: caption, K-Means and classification* |
| ![Screenshot: map composer with legend and scale bar](docs/images/TODO-composer.png) | ![Screenshot: histogram window](docs/images/TODO-histogram.png) |
| *TODO: caption, map composer* | *TODO: caption, histogram window* |

**Demo video:** [TODO: replace with the hosted video link](Geocluster2.0%20demo.mp4)
(the 18 MB recording currently stored in this repository).

## Project History

GeoCluster 2.0 builds on an earlier Python desktop version by the same author,
which is kept in [`desktop/`](desktop/) for reference. The web version reuses
its image-processing logic and its K-Means and classification method, and adds:

* a FastAPI backend that owns the image processing and the session handling;
* a browser frontend, with no install step for the people who use it;
* a Groq-based AI assistant that can run validated app actions;
* satellite fetch by place name and by coordinates, from Copernicus;
* a map composer with editable title, legend, scale bar and north arrow;
* filter sliders with live preview;
* histogram windows.

## Team Contributions

* **Muhammad Furqan Shahid**: project author; the web conversion; backend and
  frontend integration; deployment.

## Acknowledgements

* **[Groq](https://groq.com/)** for the fast inference API behind the AI assistant.
* **[Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/)** for the
  Sentinel-2 satellite imagery. Sentinel data remains subject to the Copernicus
  terms of use.
* **[PyTorch](https://pytorch.org/)** (used by the desktop version).
* **[FastAPI](https://fastapi.tiangolo.com/)** and its dependencies.
* Every other major dependency listed in the requirements files:
  * `api/requirements.txt`: FastAPI, Uvicorn, python-multipart, Pydantic,
    python-dotenv, NumPy, OpenCV (headless), Requests and the OpenAI Python SDK.
  * `api/requirements-dev.txt`: pytest and HTTPX (tests only).
  * `desktop/requirements.txt`: PyTorch, PyQt5, Matplotlib, NetworkX, SymPy,
    Pillow, OpenAI, HTTPX, Requests, Pydantic, NumPy, OpenCV and python-dotenv,
    with their transitive dependencies.
* **[OpenStreetMap Nominatim](https://nominatim.openstreetmap.org/)** for place-name
  lookup. Its data is © OpenStreetMap contributors (ODbL).

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Muhammad Furqan Shahid.
