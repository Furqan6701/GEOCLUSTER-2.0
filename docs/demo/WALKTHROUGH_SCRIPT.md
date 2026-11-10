# GeoCluster 2.0 - Official Video Walkthrough Script

**Platform:** Web-Native Satellite Analytics & AI-Driven Land Cover Classification  
**Author:** Muhammad Furqan Shahid  
**Institution:** National University of Sciences & Technology (NUST)  
**Narration Voice:** Native English (US - Andrew Multilingual Neural)  
**Video Specifications:** 1080p Full HD (1920×1080), 24 FPS, AAC Stereo  

---

## Complete Scene-by-Scene Script & Timestamps

### Scene 1: Welcome & Executive Overview (00:00 - 00:19)
**Visual:** 
- GeoCluster 2.0 Brand banner, "WALKTHROUGH" badge.
- Left panel: High-level architectural pillars (Zero-install web architecture, Sentinel-2 L2A acquisition, In-memory K-Means clustering, Groq LLaMA 3.3 70B AI Assistant, Cartographic Map Composer).
- Right panel: Live Sentinel-2 10m satellite crop of NUST H-12 Campus.

**Voiceover Narration (English):**
> *"Welcome to GeoCluster 2.0, a web-native Earth observation workstation that democratizes satellite image analysis and land-cover classification. Traditional desktop GIS software requires massive multi-gigabyte downloads and complex licenses. GeoCluster 2.0 brings full remote sensing power directly into any modern browser."*

---

### Scene 2: Architecture & In-Memory Sessions (00:19 - 00:38)
**Visual:**
- Left panel: Single-origin FastAPI + ES6 Vanilla JS architecture, in-memory SessionStore with sliding 60-minute TTL, global RAM guard & LRU eviction, automated secret scrubbing in logs.
- Right panel: In-memory session raster of Islamabad Sector F-8.

**Voiceover Narration (English):**
> *"Under the hood, GeoCluster 2.0 features a unified single-origin architecture. The frontend is built on pure, build-free ES6 JavaScript modules, while the backend is powered by a high-concurrency FastAPI server. All image sessions are stored entirely in memory with a sliding 60-minute time-to-live, guaranteeing zero disk persistence of user data."*

---

### Scene 3: 1-Click Copernicus Sentinel-2 Acquisition (00:38 - 00:58)
**Visual:**
- Left panel: Triple-mode geocoding (Sector codes like 'F-8', aliases like 'NUST', and OpenStreetMap Nominatim global place search), coordinate bounding box parser, 10-meter native ground sampling metadata.
- Right panel: True-color Sentinel-2 L2A tile with atmospheric correction.

**Voiceover Narration (English):**
> *"Fetching satellite imagery is seamless. By connecting directly to the Copernicus Data Space Ecosystem, users can retrieve 10-meter Sentinel-2 true-color tiles by simply entering a sector code, alias, or global place name via Nominatim, or by pasting coordinate bounding boxes. Ground resolution metadata is strictly preserved."*

---

### Scene 4: Spatial Filtering with Live Canvas Preview (00:58 - 01:17)
**Visual:**
- Left panel: Zero-latency canvas preview sliders for Brightness (-255..255) and Binary Threshold (0..255), Laplacian edge detection for geological features, odd-kernel mean blur (3x3 to 31x31), alpha channel preservation.
- Right panel: Spectral feature extraction and edge filtering.

**Voiceover Narration (English):**
> *"Our image processing engine includes spatial filters such as Laplacian edge detection, box blur smoothing, grayscale conversion, and contrast inversion. Live canvas previews allow users to slide brightness and threshold controls with real-time browser feedback before committing to exact server results."*

---

### Scene 5: Accelerated K-Means Clustering & Land-Cover Mapping (01:17 - 01:37)
**Visual:**
- Left panel: Vectorized 256-bin intensity histogram lookup table (LUT), sub-15ms convergence, interactive cluster range re-coloring, curated land-cover classes (Shadows, Water, Forest, Rooftops, Bare Soil, Grass).
- Right panel: 5-class segmented land-cover classification map.

**Voiceover Narration (English):**
> *"GeoCluster's clustering engine uses a vectorized 256-bin intensity lookup table, achieving bit-identical mathematical precision with sub-15-millisecond convergence. Users can dynamically re-assign cluster bounds, map land-cover classes from forest to urban zones, and monitor precise pixel percentages."*

---

### Scene 6: Three-Tier AI Assistant & Lossless GCH2 Compression (01:37 - 01:57)
**Visual:**
- Left panel: Three-tier AI architecture:
  - Tier 1: Local offline GIS glossary (0 tokens, 0 API calls).
  - Tier 2: Deterministic command router for instant execution.
  - Tier 3: Groq LLaMA 3.3 70B JSON mode with strict action whitelist.
  - GCH2 Huffman binary serialization with MSB bit-packing.
- Right panel: AI-assisted geospatial analysis workstation view.

**Voiceover Narration (English):**
> *"The integrated AI co-pilot, powered by Groq LLaMA 3.3 70B, answers remote sensing queries and executes validated actions with strict server-side parameter checks. Meanwhile, our custom GCH2 Huffman engine provides lossless, bit-packed image compression for rapid archival."*

---

### Scene 7: Map Composer Studio & Conclusion (01:57 - 02:18)
**Visual:**
- Left panel: Single-canvas Map Studio renderer (100% WYSIWYG preview & export), 1x, 2x, 3x high-DPI export, 9 legend placements, true north arrow, calibrated metric scale bar, open-source MIT license details.
- Right panel: Finished publication-ready cartographic map with title, scale bar, legend, and north arrow.

**Voiceover Narration (English):**
> *"Finally, the Map Composer Studio allows researchers to generate publication-grade cartographic maps complete with customizable titles, dynamic legends, true north arrows, and metric ground scale bars on a single WYSIWYG canvas. GeoCluster 2.0: remote sensing, simplified, accelerated, and open to the world."*

---

## Technical Specifications Summary
- **Backend Framework:** FastAPI, Uvicorn, Pydantic, Python 3.11
- **Raster Processing:** NumPy, OpenCV (headless)
- **AI Infrastructure:** Groq Cloud API (`llama-3.3-70b-versatile`, JSON structured output)
- **Satellite Provider:** Copernicus Data Space Ecosystem (Sentinel-2 L2A Process API)
- **Geocoding:** OpenStreetMap Nominatim with 1 req/s token bucket rate limiting
- **Frontend:** Vanilla HTML5, CSS3, ES6 Modules (Zero build pipeline)
- **Video Rendering:** OpenCV VideoWriter, edge-tts, FFmpeg 7.x
