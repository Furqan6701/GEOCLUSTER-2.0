"""Generate a high-definition (1080p) demo video walkthrough for GeoCluster 2.0
with synchronized native English speech narration using edge-tts and ffmpeg.
"""

import asyncio
import os
import subprocess
import tempfile
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 1080p Video dimensions
WIDTH = 1920
HEIGHT = 1080
FPS = 24

# Colors (BGR for OpenCV, RGB for PIL)
BG_RGB = (11, 17, 32)            # #0B1120
CARD_BG_RGB = (30, 41, 59)       # #1E293B
CARD_BORDER_RGB = (51, 65, 85)   # #334155
EMERALD_RGB = (16, 185, 129)     # #10B981
CYAN_RGB = (6, 182, 212)         # #06B6D4
AMBER_RGB = (245, 158, 11)       # #F59E0B
WHITE_RGB = (248, 250, 252)      # #F8FAFC
SILVER_RGB = (148, 163, 184)     # #94A3B8

VOICE = "en-US-AndrewMultilingualNeural"

# Scenes script: title, category tag, narrative text for TTS, bullet points, image path
SCENES = [
    {
        "id": "scene1_intro",
        "tag": "WELCOME & OVERVIEW",
        "title": "GeoCluster 2.0: Web-Native Remote Sensing Workstation",
        "speech": (
            "Welcome to GeoCluster 2.0, a web-native Earth observation workstation that democratizes "
            "satellite image analysis and land-cover classification. Traditional desktop GIS software "
            "requires massive multi-gigabyte downloads and complex licenses. GeoCluster 2.0 brings "
            "full remote sensing power directly into any modern browser."
        ),
        "bullets": [
            "Zero-install, zero-build web architecture",
            "Direct Copernicus Sentinel-2 L2A satellite retrieval",
            "In-memory accelerated K-Means spectral clustering",
            "Natural-language AI Assistant powered by Groq LLaMA 3.3 70B",
            "Publication-ready cartographic Map Composer"
        ],
        "image": "desktop/data/cache/NUST.png",
        "image_label": "Sentinel-2 L2A (10m): NUST H-12 Campus"
    },
    {
        "id": "scene2_arch",
        "tag": "ARCHITECTURE & SESSIONS",
        "title": "Unified Single-Origin Engine & In-Memory Sessions",
        "speech": (
            "Under the hood, GeoCluster 2.0 features a unified single-origin architecture. "
            "The frontend is built on pure, build-free ES6 JavaScript modules, while the backend "
            "is powered by a high-concurrency FastAPI server. All image sessions are stored entirely "
            "in memory with a sliding 60-minute time-to-live, guaranteeing zero disk persistence of user data."
        ),
        "bullets": [
            "FastAPI backend with asynchronous request routing",
            "In-memory session store with sliding 60-minute TTL",
            "Global memory guard & LRU eviction preventing RAM exhaustion",
            "Automated secret scrubbing across all server logs and tracebacks",
            "Zero CORS friction: single process serves web and REST endpoints"
        ],
        "image": "docs/demo/F8_satellite.png",
        "image_label": "In-Memory Session Raster: Islamabad Sector F-8"
    },
    {
        "id": "scene3_satellite",
        "tag": "SATELLITE DATA RETRIEVAL",
        "title": "1-Click Copernicus Sentinel-2 Acquisition",
        "speech": (
            "Fetching satellite imagery is seamless. By connecting directly to the Copernicus Data "
            "Space Ecosystem, users can retrieve 10-meter Sentinel-2 true-color tiles by simply "
            "entering a sector code, alias, or global place name via Nominatim, or by pasting "
            "coordinate bounding boxes. Ground resolution metadata is strictly preserved."
        ),
        "bullets": [
            "Triple-mode geocoding: Sector codes, aliases, and Nominatim search",
            "Coordinate bounding-box parser for Google Maps latitude/longitude pairs",
            "Bottom-Of-Atmosphere (L2A) reflectance with automated cloud filtering",
            "10-meter ground sampling distance preserved for spatial measurement",
            "Configurable SATELLITE_MAX_KM boundaries ensuring safe memory quotas"
        ],
        "image": "docs/demo/F8_satellite.png",
        "image_label": "Copernicus Sentinel-2 Crop (True Color BOA)"
    },
    {
        "id": "scene4_filters",
        "tag": "IMAGE PROCESSING ENGINE",
        "title": "Spatial Filtering with Live Canvas Preview",
        "speech": (
            "Our image processing engine includes spatial filters such as Laplacian edge detection, "
            "box blur smoothing, grayscale conversion, and contrast inversion. Live canvas previews "
            "allow users to slide brightness and threshold controls with real-time browser feedback "
            "before committing to exact server results."
        ),
        "bullets": [
            "Zero-latency canvas previews during slider dragging",
            "Laplacian 2nd-derivative filtering for geological edge detection",
            "Odd-kernel mean blur (3x3 to 31x31) with reflect-101 border handling",
            "Strict alpha channel preservation for 4-channel BGRA imagery",
            "Live 256-bin intensity histogram windows with multi-image overlay"
        ],
        "image": "api/tests/fixtures/kmeans_k5_display.png",
        "image_label": "Filtered Spectral Intensities & Feature Extraction"
    },
    {
        "id": "scene5_kmeans",
        "tag": "UNSUPERVISED CLASSIFICATION",
        "title": "Accelerated K-Means Clustering & Land-Cover Mapping",
        "speech": (
            "GeoCluster's clustering engine uses a vectorized 256-bin intensity lookup table, "
            "achieving bit-identical mathematical precision with sub-15-millisecond convergence. "
            "Users can dynamically re-assign cluster bounds, map land-cover classes from forest to urban "
            "zones, and monitor precise pixel percentages."
        ),
        "bullets": [
            "Vectorized intensity-histogram LUT collapsing iteration overhead",
            "Rapid convergence: centroid shift < 0.5 units in under 15ms",
            "Dynamic cluster editor with synchronized boundary adjustments",
            "Built-in land cover presets: Shadows, Forest, Rooftops, Soil, Grass",
            "Exact pixel count and percentage calculation with zero drift"
        ],
        "image": "api/tests/fixtures/classify_display.png",
        "image_label": "Classified Land Cover Map: 5 Segmented Classes"
    },
    {
        "id": "scene6_ai",
        "tag": "AI CO-PILOT & ARCHIVAL",
        "title": "Three-Tier AI Assistant & Lossless GCH2 Compression",
        "speech": (
            "The integrated AI co-pilot, powered by Groq LLaMA 3.3 70B, answers remote sensing queries "
            "and executes validated actions with strict server-side parameter checks. Meanwhile, "
            "our custom GCH2 Huffman engine provides lossless, bit-packed image compression for rapid archival."
        ),
        "bullets": [
            "Tier 1: Built-in offline glossary for zero-token tool guidance",
            "Tier 2: Rule-based command router capturing explicit instructions",
            "Tier 3: Groq LLaMA 3.3 70B JSON mode with strict action whitelist",
            "GCH2 Lossless Huffman compression: vectorized bit-packing",
            "High-speed per-state byte transition decoding table"
        ],
        "image": "desktop/data/cache/NUST.png",
        "image_label": "AI Guided Geospatial Analysis Workstation"
    },
    {
        "id": "scene7_composer",
        "tag": "CARTOGRAPHY STUDIO & CONCLUSION",
        "title": "Map Composer Studio: Publication-Grade Cartography",
        "speech": (
            "Finally, the Map Composer Studio allows researchers to generate publication-grade "
            "cartographic maps complete with customizable titles, dynamic legends, true north arrows, "
            "and metric ground scale bars on a single WYSIWYG canvas. GeoCluster 2.0: remote sensing, "
            "simplified, accelerated, and open to the world."
        ),
        "bullets": [
            "Single-canvas rendering: interactive preview matches export 100%",
            "Multi-scale high-DPI export: 1x, 2x, and 3x scale options",
            "9 legend placements: outside margins or on-map corner overlays",
            "Exact metric scale bar calibrated with Sentinel-2 ground metadata",
            "Fully open source under the MIT License on GitHub"
        ],
        "image": "api/tests/fixtures/classify_display.png",
        "image_label": "Composed Cartographic Map Ready for Publication"
    }
]

async def generate_audio_for_scene(text, output_mp3):
    import edge_tts
    communicate = edge_tts.Communicate(text, VOICE)
    await communicate.save(output_mp3)

def get_audio_duration(audio_file):
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", audio_file
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        return float(res.stdout.strip())
    except Exception:
        # Fallback duration estimate
        return 12.0

def load_font(size, bold=False):
    # Try system fonts on Windows
    font_paths = [
        "C:\\Windows\\Fonts\\segoeuib.ttf" if bold else "C:\\Windows\\Fonts\\segoeui.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf" if bold else "C:\\Windows\\Fonts\\arial.ttf",
    ]
    for p in font_paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

def render_scene_frame(scene_data, progress_ratio=0.0):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_RGB)
    draw = ImageDraw.Draw(img)

    # Fonts
    font_tag = load_font(20, bold=True)
    font_title = load_font(44, bold=True)
    font_bullet_h = load_font(24, bold=True)
    font_bullet = load_font(22, bold=False)
    font_label = load_font(18, bold=True)
    font_foot = load_font(18, bold=False)

    # Top Brand Bar
    draw.rectangle([0, 0, WIDTH, 75], fill=(15, 23, 42))
    draw.line([0, 75, WIDTH, 75], fill=CARD_BORDER_RGB, width=2)
    
    # Brand title
    draw.text((60, 22), "GeoCluster 2.0", font=load_font(28, bold=True), fill=WHITE_RGB)
    draw.rectangle([270, 24, 380, 52], fill=(6, 78, 59))
    draw.text((280, 28), "WALKTHROUGH", font=load_font(14, bold=True), fill=EMERALD_RGB)
    draw.text((WIDTH - 480, 28), "REMOTE SENSING & AI WORKSTATION", font=load_font(16, bold=True), fill=SILVER_RGB)

    # Category Tag
    draw.text((60, 110), scene_data["tag"], font=font_tag, fill=EMERALD_RGB)

    # Scene Title
    draw.text((60, 142), scene_data["title"], font=font_title, fill=WHITE_RGB)

    # Left Container Card: Feature Highlights
    card_left = 60
    card_top = 230
    card_w = 1000
    card_h = 750
    draw.rounded_rectangle([card_left, card_top, card_left + card_w, card_top + card_h], radius=16, fill=CARD_BG_RGB, outline=CARD_BORDER_RGB, width=2)

    draw.text((card_left + 40, card_top + 35), "Key Engineering & Operational Highlights", font=font_bullet_h, fill=CYAN_RGB)

    # Bullets
    y_offset = card_top + 100
    for bullet in scene_data["bullets"]:
        # Bullet marker
        draw.ellipse([card_left + 40, y_offset + 8, card_left + 52, y_offset + 20], fill=EMERALD_RGB)
        draw.text((card_left + 70, y_offset), bullet, font=font_bullet, fill=WHITE_RGB)
        y_offset += 110

    # Right Container Card: Live Raster / Visual Showcase
    r_left = 1100
    r_top = 230
    r_w = 760
    r_h = 750
    draw.rounded_rectangle([r_left, r_top, r_left + r_w, r_top + r_h], radius=16, fill=CARD_BG_RGB, outline=CARD_BORDER_RGB, width=2)

    # Inner image
    img_path = scene_data["image"]
    if os.path.exists(img_path):
        try:
            show_im = Image.open(img_path).convert("RGB")
            # Resize preserving aspect ratio to fit inside 680x580
            show_im.thumbnail((680, 580), Image.Resampling.LANCZOS)
            im_w, im_h = show_im.size
            im_x = r_left + (r_w - im_w) // 2
            im_y = r_top + 50 + (580 - im_h) // 2
            img.paste(show_im, (im_x, im_y))
            draw.rectangle([im_x - 2, im_y - 2, im_x + im_w + 2, im_y + im_h + 2], outline=CARD_BORDER_RGB, width=2)
        except Exception as e:
            draw.text((r_left + 50, r_top + 200), f"Preview loading...", font=font_bullet, fill=SILVER_RGB)

    # Image Label
    lbl_text = scene_data["image_label"]
    draw.text((r_left + 40, r_top + 675), lbl_text, font=font_label, fill=EMERALD_RGB)

    # Bottom Progress Bar
    draw.rectangle([0, HEIGHT - 18, WIDTH, HEIGHT], fill=(15, 23, 42))
    progress_w = int(WIDTH * progress_ratio)
    if progress_w > 0:
        draw.rectangle([0, HEIGHT - 18, progress_w, HEIGHT], fill=CYAN_RGB)

    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

async def build_walkthrough():
    print("=" * 70)
    print("Starting GeoCluster 2.0 HD Demo Walkthrough Generator")
    print("=" * 70)

    temp_dir = tempfile.mkdtemp(prefix="geocluster_demo_")
    scene_clips = []

    for idx, scene in enumerate(SCENES):
        print(f"\n[Scene {idx+1}/{len(SCENES)}] Processing '{scene['title']}'...")
        mp3_path = os.path.join(temp_dir, f"{scene['id']}.mp3")
        
        # 1. Synthesize native English speech narration
        print(f"  -> Synthesizing native English voice ({VOICE})...")
        await generate_audio_for_scene(scene["speech"], mp3_path)
        
        duration = get_audio_duration(mp3_path)
        # Add 0.5s padding
        duration += 0.5
        total_frames = int(duration * FPS)
        print(f"  -> Audio duration: {duration:.2f}s ({total_frames} frames)")

        # 2. Render video clip for scene
        clip_avi = os.path.join(temp_dir, f"{scene['id']}_raw.avi")
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(clip_avi, fourcc, FPS, (WIDTH, HEIGHT))

        for frame_idx in range(total_frames):
            ratio = (frame_idx + 1) / total_frames
            # Overall progress across entire video
            global_ratio = (idx + ratio) / len(SCENES)
            frame = render_scene_frame(scene, global_ratio)
            out.write(frame)

        out.release()

        # 3. Mux video with audio
        clip_mp4 = os.path.join(temp_dir, f"{scene['id']}.mp4")
        mux_cmd = [
            "ffmpeg", "-y", "-i", clip_avi, "-i", mp3_path,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-shortest", clip_mp4
        ]
        subprocess.run(mux_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        scene_clips.append(clip_mp4)
        print(f"  -> Scene {idx+1} rendered: {clip_mp4}")

    # 4. Concatenate all scenes into master video
    concat_list = os.path.join(temp_dir, "concat.txt")
    with open(concat_list, "w") as f:
        for c in scene_clips:
            clean_path = c.replace("\\", "/")
            f.write(f"file '{clean_path}'\n")

    output_final = "geocluster2_demo_walkthrough.mp4"
    print(f"\nConcatenating all scenes into final video: {output_final}...")
    concat_cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
        "-c", "copy", output_final
    ]
    subprocess.run(concat_cmd, check=True)

    # Check file size
    size_mb = os.path.getsize(output_final) / (1024 * 1024)
    print(f"\nSUCCESS! Generated '{output_final}' ({size_mb:.2f} MB)")
    print(f"Resolution: 1920x1080 (Full HD), 24 FPS, AAC Stereo English Audio.")

if __name__ == "__main__":
    asyncio.run(build_walkthrough())
