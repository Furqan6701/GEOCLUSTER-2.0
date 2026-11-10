"""Generate modern widescreen (16:9) Pitch Deck for GeoCluster 2.0.
"""

import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE

def build_deck(output_path="GEOCLUSTER_2.0_Pitch_Deck.pptx"):
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6]

    # Colors
    BG_DARK = RGBColor(11, 17, 32)        # #0B1120 deep navy slate
    CARD_BG = RGBColor(30, 41, 59)        # #1E293B slate card
    CARD_BORDER = RGBColor(51, 65, 85)    # #334155
    EMERALD = RGBColor(16, 185, 129)      # #10B981 vibrant green
    CYAN = RGBColor(6, 182, 212)          # #06B6D4 electric cyan
    WHITE = RGBColor(248, 250, 252)       # #F8FAFC crisp white
    SILVER = RGBColor(148, 163, 184)      # #94A3B8 muted text
    AMBER = RGBColor(245, 158, 11)        # #F59E0B warning/accent

    def set_slide_background(slide):
        bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0), Inches(0), Inches(13.333), Inches(7.5))
        bg.fill.solid()
        bg.fill.fore_color.rgb = BG_DARK
        bg.line.fill.background()
        return bg

    def add_card(slide, left, top, width, height, bg_color=CARD_BG, border_color=CARD_BORDER):
        card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(height))
        card.fill.solid()
        card.fill.fore_color.rgb = bg_color
        if border_color:
            card.line.color.rgb = border_color
            card.line.width = Pt(1.5)
        else:
            card.line.fill.background()
        return card

    def add_header(slide, tag, title, subtitle=None):
        # Category Tag
        tag_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.5), Inches(11.7), Inches(0.4))
        tf_tag = tag_box.text_frame
        tf_tag.word_wrap = True
        tf_tag.margin_left = tf_tag.margin_top = tf_tag.margin_right = tf_tag.margin_bottom = 0
        p_tag = tf_tag.paragraphs[0]
        p_tag.text = tag.upper()
        p_tag.font.bold = True
        p_tag.font.size = Pt(11)
        p_tag.font.color.rgb = EMERALD

        # Title
        title_box = slide.shapes.add_textbox(Inches(0.8), Inches(0.85), Inches(11.7), Inches(0.7))
        tf_title = title_box.text_frame
        tf_title.word_wrap = True
        tf_title.margin_left = tf_title.margin_top = tf_title.margin_right = tf_title.margin_bottom = 0
        p_title = tf_title.paragraphs[0]
        p_title.text = title
        p_title.font.bold = True
        p_title.font.size = Pt(26)
        p_title.font.color.rgb = WHITE

        # Subtitle
        if subtitle:
            sub_box = slide.shapes.add_textbox(Inches(0.8), Inches(1.5), Inches(11.7), Inches(0.45))
            tf_sub = sub_box.text_frame
            tf_sub.word_wrap = True
            tf_sub.margin_left = tf_sub.margin_top = tf_sub.margin_right = tf_sub.margin_bottom = 0
            p_sub = tf_sub.paragraphs[0]
            p_sub.text = subtitle
            p_sub.font.size = Pt(14)
            p_sub.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 1: Title Slide
    # ==========================================
    s1 = prs.slides.add_slide(blank_layout)
    set_slide_background(s1)

    # Accent decorative glow/pill
    add_card(s1, 0.8, 1.2, 3.4, 0.45, bg_color=RGBColor(6, 78, 59), border_color=EMERALD)
    badge = s1.shapes.add_textbox(Inches(0.9), Inches(1.25), Inches(3.2), Inches(0.35))
    tf_b = badge.text_frame
    p_b = tf_b.paragraphs[0]
    p_b.text = "EARTH OBSERVATION & GIS CO-PILOT"
    p_b.font.bold = True
    p_b.font.size = Pt(11)
    p_b.font.color.rgb = EMERALD

    # Main Title
    tbox = s1.shapes.add_textbox(Inches(0.8), Inches(1.85), Inches(11.5), Inches(1.6))
    tf = tbox.text_frame
    tf.word_wrap = True
    p1 = tf.paragraphs[0]
    p1.text = "GeoCluster 2.0"
    p1.font.bold = True
    p1.font.size = Pt(54)
    p1.font.color.rgb = WHITE
    
    p2 = tf.add_paragraph()
    p2.text = "Web-Native Satellite Analytics & AI-Driven Land Cover Classification"
    p2.font.bold = True
    p2.font.size = Pt(22)
    p2.font.color.rgb = CYAN

    # Subtitle / description
    desc_box = s1.shapes.add_textbox(Inches(0.8), Inches(3.6), Inches(7.5), Inches(1.5))
    tf_d = desc_box.text_frame
    tf_d.word_wrap = True
    p_d = tf_d.paragraphs[0]
    p_d.text = (
        "Empowering researchers, students, and geospatial engineers with instant "
        "Sentinel-2 satellite acquisition, in-memory K-Means clustering, lossless GCH2 compression, "
        "and publication-grade map generation — all in a zero-install, zero-build web interface."
    )
    p_d.font.size = Pt(15)
    p_d.font.color.rgb = SILVER

    # Stats cards on right side of title slide
    add_card(s1, 8.6, 2.2, 3.9, 1.2)
    st1 = s1.shapes.add_textbox(Inches(8.8), Inches(2.35), Inches(3.5), Inches(0.9))
    tf1 = st1.text_frame
    p_st1 = tf1.paragraphs[0]
    p_st1.text = "100% In-Memory"
    p_st1.font.bold = True
    p_st1.font.size = Pt(20)
    p_st1.font.color.rgb = EMERALD
    p_st1_sub = tf1.add_paragraph()
    p_st1_sub.text = "Zero disk persistence for uploads; fast sliding TTL sessions."
    p_st1_sub.font.size = Pt(11)
    p_st1_sub.font.color.rgb = SILVER

    add_card(s1, 8.6, 3.6, 3.9, 1.2)
    st2 = s1.shapes.add_textbox(Inches(8.8), Inches(3.75), Inches(3.5), Inches(0.9))
    tf2 = st2.text_frame
    p_st2 = tf2.paragraphs[0]
    p_st2.text = "10m Sentinel-2 L2A"
    p_st2.font.bold = True
    p_st2.font.size = Pt(20)
    p_st2.font.color.rgb = CYAN
    p_st2_sub = tf2.add_paragraph()
    p_st2_sub.text = "Direct Copernicus Data Space Ecosystem API integration."
    p_st2_sub.font.size = Pt(11)
    p_st2_sub.font.color.rgb = SILVER

    add_card(s1, 8.6, 5.0, 3.9, 1.2)
    st3 = s1.shapes.add_textbox(Inches(8.8), Inches(5.15), Inches(3.5), Inches(0.9))
    tf3 = st3.text_frame
    p_st3 = tf3.paragraphs[0]
    p_st3.text = "Groq LLaMA 3.3 70B"
    p_st3.font.bold = True
    p_st3.font.size = Pt(20)
    p_st3.font.color.rgb = AMBER
    p_st3_sub = tf3.add_paragraph()
    p_st3_sub.text = "Safe AI Assistant with deterministic action whitelist validation."
    p_st3_sub.font.size = Pt(11)
    p_st3_sub.font.color.rgb = SILVER

    # Author footer
    foot = s1.shapes.add_textbox(Inches(0.8), Inches(6.5), Inches(11.7), Inches(0.5))
    tf_f = foot.text_frame
    p_f = tf_f.paragraphs[0]
    p_f.text = "Author: Muhammad Furqan Shahid | National University of Sciences & Technology (NUST)"
    p_f.font.size = Pt(13)
    p_f.font.color.rgb = WHITE

    # ==========================================
    # SLIDE 2: The Problem
    # ==========================================
    s2 = prs.slides.add_slide(blank_layout)
    set_slide_background(s2)
    add_header(s2, "The Market Problem", "GIS & Satellite Image Analysis Is Trapped Behind Heavy Desktop Stacks", 
               "Traditional remote sensing workflows impose severe access, licensing, and compute barriers.")

    cards_p = [
        ("Massive Software Bloat", 
         "Traditional desktop suites like ArcGIS, QGIS, and ENVI require multi-gigabyte installations, complex dependencies (C++ runtimes, GDAL binaries), and high-end dedicated workstation hardware.",
         AMBER),
        ("Extremely Steep Learning Curve",
         "Non-specialists face hundreds of nested menus, manual coordinate projection transformations (CRS, UTM/WGS84), and obscure raster file formats just to perform basic land-cover segmentation.",
         CYAN),
        ("Cost & Access Barriers",
         "High licensing costs, academic workstation constraints, and lack of browser mobility isolate students, environmental field teams, urban planners, and emerging research groups.",
         EMERALD)
    ]
    for idx, (title, desc, color) in enumerate(cards_p):
        left = 0.8 + idx * 4.0
        add_card(s2, left, 2.2, 3.75, 4.2)
        tb = s2.shapes.add_textbox(Inches(left + 0.3), Inches(2.5), Inches(3.15), Inches(3.6))
        tf = tb.text_frame
        tf.word_wrap = True
        p_t = tf.paragraphs[0]
        p_t.text = title
        p_t.font.bold = True
        p_t.font.size = Pt(19)
        p_t.font.color.rgb = color
        
        p_d = tf.add_paragraph()
        p_d.space_before = Pt(14)
        p_d.text = desc
        p_d.font.size = Pt(14)
        p_d.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 3: The Solution
    # ==========================================
    s3 = prs.slides.add_slide(blank_layout)
    set_slide_background(s3)
    add_header(s3, "The GeoCluster 2.0 Solution", "A Zero-Install, Zero-Build Cloud-Native Geospatial Workstation",
               "Full desktop GIS power delivered through modern, responsive web standards.")

    sol_cards = [
        ("Instant Browser Access",
         "Runs in any browser without plugins or npm build pipelines. Single-origin FastAPI app serves ES modules directly.",
         CYAN),
        ("1-Click Satellite Fetch",
         "Download real Sentinel-2 L2A true-color tiles by place name, sector code, or coordinates with automatic 10m scaling.",
         EMERALD),
        ("Automated K-Means Clustering",
         "Vectorized NumPy intensity histogram LUT clustering with live range previews and interactive land cover classification.",
         WHITE),
        ("Cartographic Map Composer",
         "Export publication-ready scientific maps with title, custom legend, metric scale bar, and true north arrow on one canvas.",
         AMBER)
    ]
    for idx, (title, desc, color) in enumerate(sol_cards):
        row = idx // 2
        col = idx % 2
        left = 0.8 + col * 5.95
        top = 2.2 + row * 2.3
        add_card(s3, left, top, 5.75, 2.05)
        tb = s3.shapes.add_textbox(Inches(left + 0.3), Inches(top + 0.25), Inches(5.15), Inches(1.55))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = title
        p.font.bold = True
        p.font.size = Pt(18)
        p.font.color.rgb = color
        
        pd = tf.add_paragraph()
        pd.space_before = Pt(8)
        pd.text = desc
        pd.font.size = Pt(13)
        pd.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 4: Architecture
    # ==========================================
    s4 = prs.slides.add_slide(blank_layout)
    set_slide_background(s4)
    add_header(s4, "System Architecture", "Unified Single-Process Architecture & Secure Microservices",
               "Clean separation of concerns with synchronous high-speed in-memory sessions.")

    # Left Card: Frontend
    add_card(s4, 0.8, 2.2, 3.6, 4.4)
    tb = s4.shapes.add_textbox(Inches(1.0), Inches(2.4), Inches(3.2), Inches(4.0))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = "Browser Workstation (web/)"
    p.font.bold = True
    p.font.size = Pt(17)
    p.font.color.rgb = CYAN
    bullets_fe = [
        "Vanilla ES6 JavaScript modules",
        "Dual sync viewports (Original & Result)",
        "Canvas-based live slider previews",
        "Map Studio single-canvas composer",
        "Pure CSS dark-mode workstation theme",
        "Zero bundler / build step complexity"
    ]
    for b in bullets_fe:
        pb = tf.add_paragraph()
        pb.space_before = Pt(6)
        pb.text = "• " + b
        pb.font.size = Pt(12)
        pb.font.color.rgb = SILVER

    # Middle Card: FastAPI Backend
    add_card(s4, 4.8, 2.2, 3.7, 4.4)
    tb2 = s4.shapes.add_textbox(Inches(5.0), Inches(2.4), Inches(3.3), Inches(4.0))
    tf2 = tb2.text_frame
    tf2.word_wrap = True
    p2 = tf2.paragraphs[0]
    p2.text = "FastAPI Backend (api/)"
    p2.font.bold = True
    p2.font.size = Pt(17)
    p2.font.color.rgb = EMERALD
    bullets_be = [
        "In-Memory Session Store (60m TTL)",
        "Global & per-session LRU eviction",
        "NumPy + OpenCV image operations",
        "GCH2 vectorized Huffman engine",
        "Secret redaction & CORS protection",
        "Single-origin unified serving (/ & /api)"
    ]
    for b in bullets_be:
        pb = tf2.add_paragraph()
        pb.space_before = Pt(6)
        pb.text = "• " + b
        pb.font.size = Pt(12)
        pb.font.color.rgb = SILVER

    # Right Card: Cloud & APIs
    add_card(s4, 8.85, 2.2, 3.65, 4.4)
    tb3 = s4.shapes.add_textbox(Inches(9.05), Inches(2.4), Inches(3.25), Inches(4.0))
    tf3 = tb3.text_frame
    tf3.word_wrap = True
    p3 = tf3.paragraphs[0]
    p3.text = "External Integrations"
    p3.font.bold = True
    p3.font.size = Pt(17)
    p3.font.color.rgb = AMBER
    bullets_ext = [
        "Copernicus CDSE Sentinel Hub:",
        "  - Sentinel-2 L2A BOA Reflectance",
        "  - Token caching & auto-retry",
        "Groq AI Cloud:",
        "  - LLaMA-3.3-70B high-speed inference",
        "  - Structured JSON action generation",
        "OpenStreetMap Nominatim:",
        "  - Place geocoding with 1 req/s rate limit"
    ]
    for b in bullets_ext:
        pb = tf3.add_paragraph()
        pb.space_before = Pt(5)
        pb.text = "• " + b
        pb.font.size = Pt(12)
        pb.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 5: Satellite Retrieval
    # ==========================================
    s5 = prs.slides.add_slide(blank_layout)
    set_slide_background(s5)
    add_header(s5, "Satellite Data Integration", "Live Copernicus Sentinel-2 Retrieval on Demand",
               "Direct API query pipeline fetching multispectral optical data at 10m native resolution.")

    add_card(s5, 0.8, 2.2, 7.2, 4.5)
    tb = s5.shapes.add_textbox(Inches(1.1), Inches(2.4), Inches(6.6), Inches(4.1))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = "Intelligent Geocoding & Crop Pipeline"
    p.font.bold = True
    p.font.size = Pt(18)
    p.font.color.rgb = CYAN
    sat_points = [
        ("Triple-Mode Spatial Query:", "Fetch by official sector code (e.g., 'F-8', 'H-12'), common alias ('NUST', 'Centaurus'), or arbitrary global place names resolved via Nominatim."),
        ("Coordinate Bounding Box:", "Directly paste two opposite lat/long corners (e.g., from Google Maps) for custom bounding box crops."),
        ("Atmospheric Correction (L2A):", "Fetches Bottom-Of-Atmosphere (BOA) true-color imagery using custom evalscripts (B04, B03, B02)."),
        ("Rolling Time Window & Least Cloud Cover:", "Automatically searches recent acquisitions filtered by lowest cloud percentage (`leastCC`)."),
        ("Ground Scale Preservation:", "Maintains native ground sampling metadata (10 m/pixel) for ground-truth distance measurement.")
    ]
    for h, desc in sat_points:
        p_pt = tf.add_paragraph()
        p_pt.space_before = Pt(8)
        p_pt.text = "• " + h + " " + desc
        p_pt.font.size = Pt(12.5)
        p_pt.font.color.rgb = SILVER

    # Insert satellite image preview on right
    if os.path.exists("docs/demo/F8_satellite.png"):
        add_card(s5, 8.4, 2.2, 4.1, 4.5)
        s5.shapes.add_picture("docs/demo/F8_satellite.png", Inches(8.65), Inches(2.45), width=Inches(3.6), height=Inches(3.6))
        c_box = s5.shapes.add_textbox(Inches(8.5), Inches(6.1), Inches(3.9), Inches(0.4))
        p_c = c_box.text_frame.paragraphs[0]
        p_c.alignment = PP_ALIGN.CENTER
        p_c.text = "Sentinel-2 Crop: Islamabad Sector F-8 (10m Res)"
        p_c.font.size = Pt(10)
        p_c.font.color.rgb = EMERALD

    # ==========================================
    # SLIDE 6: K-Means & Classification
    # ==========================================
    s6 = prs.slides.add_slide(blank_layout)
    set_slide_background(s6)
    add_header(s6, "Unsupervised Spectral Clustering", "Fast Intensity-Histogram K-Means & Dynamic Land Cover Classification",
               "Accelerated Lloyd clustering with live browser threshold adjustment.")

    add_card(s6, 0.8, 2.2, 6.0, 4.5)
    tb = s6.shapes.add_textbox(Inches(1.0), Inches(2.4), Inches(5.6), Inches(4.1))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = "Algorithm Highlights"
    p.font.bold = True
    p.font.size = Pt(18)
    p.font.color.rgb = EMERALD
    km_points = [
        ("Vectorized 256-Bin LUT:", "Pixels are mapped via a 256-intensity lookup table, reducing complexity from O(N·K) to O(256·K + N) per iteration."),
        ("Fast Convergence:", "Iterates until centroid shift < 0.5 intensity units (typically 4-9 iterations, max 30) in < 15 milliseconds."),
        ("Interactive Re-coloring:", "Users can interactively adjust cluster min/max bounds and assign intuitive land cover labels (Shadows, Water, Vegetation, Urban, Bare Soil)."),
        ("Synchronized Legend Math:", "Calculates exact pixel percentages per land cover class with zero floating-point accumulation drift.")
    ]
    for h, desc in km_points:
        p_pt = tf.add_paragraph()
        p_pt.space_before = Pt(8)
        p_pt.text = "• " + h + " " + desc
        p_pt.font.size = Pt(12.5)
        p_pt.font.color.rgb = SILVER

    if os.path.exists("api/tests/fixtures/kmeans_k5_display.png"):
        add_card(s6, 7.1, 2.2, 5.4, 4.5)
        s6.shapes.add_picture("api/tests/fixtures/kmeans_k5_display.png", Inches(7.3), Inches(2.4), width=Inches(5.0), height=Inches(3.4))
        c_box = s6.shapes.add_textbox(Inches(7.2), Inches(5.9), Inches(5.2), Inches(0.6))
        p_c = c_box.text_frame.paragraphs[0]
        p_c.alignment = PP_ALIGN.CENTER
        p_c.text = "5-Cluster Land Cover Output (Vegetation, Urban, Soil, Shadows)"
        p_c.font.size = Pt(11)
        p_c.font.color.rgb = WHITE

    # ==========================================
    # SLIDE 7: Filters & Compression
    # ==========================================
    s7 = prs.slides.add_slide(blank_layout)
    set_slide_background(s7)
    add_header(s7, "Image Processing & Archival", "Spatial Filtering Suite & Lossless GCH2 Huffman Compression",
               "Real-time canvas filter previews and bespoke high-ratio image serialization.")

    # Spatial Filters card
    add_card(s7, 0.8, 2.2, 5.75, 4.5)
    tb1 = s7.shapes.add_textbox(Inches(1.0), Inches(2.4), Inches(5.35), Inches(4.1))
    tf1 = tb1.text_frame
    tf1.word_wrap = True
    p1 = tf1.paragraphs[0]
    p1.text = "Spatial Filtering Engine"
    p1.font.bold = True
    p1.font.size = Pt(18)
    p1.font.color.rgb = CYAN
    f_items = [
        ("Live Preview Sliders:", "Brightness (-255..255) and Binary Threshold (0..255) sliders paint instant canvas previews during drag, replacing with exact server results on release."),
        ("Odd-Kernel Mean Blur:", "Noise reduction using 3x3 to 31x31 square kernel smoothing with reflect101 boundary handling."),
        ("Laplacian Edge Detection:", "2nd-order spatial derivative (cv2.Laplacian) highlighting geological lineaments, road grids, and water boundaries."),
        ("Alpha Channel Isolation:", "For BGRA imagery, the alpha channel is strictly preserved while color bands are filtered.")
    ]
    for h, d in f_items:
        p = tf1.add_paragraph()
        p.space_before = Pt(6)
        p.text = "• " + h + " " + d
        p.font.size = Pt(12)
        p.font.color.rgb = SILVER

    # Lossless GCH2 Card
    add_card(s7, 6.8, 2.2, 5.75, 4.5)
    tb2 = s7.shapes.add_textbox(Inches(7.0), Inches(2.4), Inches(5.35), Inches(4.1))
    tf2 = tb2.text_frame
    tf2.word_wrap = True
    p2 = tf2.paragraphs[0]
    p2.text = "Lossless GCH2 Huffman Engine"
    p2.font.bold = True
    p2.font.size = Pt(18)
    p2.font.color.rgb = EMERALD
    gch_items = [
        ("Binary Archive Container:", "Header struct `<IIIII` (rows, cols, channels, payload_bits, version=1) with 256 uint32 frequency tables."),
        ("MSB-First Vectorized Packing:", "NumPy bit-packing achieving full lossless reversibility with zero entropy loss."),
        ("Desktop Compatibility:", "Full backward and forward binary compatibility with earlier desktop GeoCluster archives."),
        ("Fast State-Transition Decoding:", "Per-state byte transition lookup table decodes 8 bits per table hop instead of bit-by-bit parsing.")
    ]
    for h, d in gch_items:
        p = tf2.add_paragraph()
        p.space_before = Pt(6)
        p.text = "• " + h + " " + d
        p.font.size = Pt(12)
        p.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 8: AI Assistant
    # ==========================================
    s8 = prs.slides.add_slide(blank_layout)
    set_slide_background(s8)
    add_header(s8, "Natural Language Co-Pilot", "AI Geospatial Assistant with Three-Tier Deterministic Security",
               "Powered by Groq LLaMA-3.3-70B with strict guardrails preventing unintended executions.")

    add_card(s8, 0.8, 2.2, 3.75, 4.4)
    tb1 = s8.shapes.add_textbox(Inches(1.0), Inches(2.4), Inches(3.35), Inches(4.0))
    tf1 = tb1.text_frame
    tf1.word_wrap = True
    p1 = tf1.paragraphs[0]
    p1.text = "Tier 1: Offline Glossary"
    p1.font.bold = True
    p1.font.size = Pt(17)
    p1.font.color.rgb = EMERALD
    p1_d = tf1.add_paragraph()
    p1_d.space_before = Pt(10)
    p1_d.text = (
        "Zero API calls, zero tokens consumed, and instant answers.\n\n"
        "Questions such as 'What is a mean filter?' or 'How does thresholding work?' are matched directly against "
        "the local curated GIS glossary (`app_help.json`). Works even when offline or without API keys."
    )
    p1_d.font.size = Pt(13)
    p1_d.font.color.rgb = SILVER

    add_card(s8, 4.8, 2.2, 3.75, 4.4)
    tb2 = s8.shapes.add_textbox(Inches(5.0), Inches(2.4), Inches(3.35), Inches(4.0))
    tf2 = tb2.text_frame
    tf2.word_wrap = True
    p2 = tf2.paragraphs[0]
    p2.text = "Tier 2: Command Router"
    p2.font.bold = True
    p2.font.size = Pt(17)
    p2.font.color.rgb = CYAN
    p2_d = tf2.add_paragraph()
    p2_d.space_before = Pt(10)
    p2_d.text = (
        "Rule-based deterministic intent routing.\n\n"
        "Explicit operational commands (e.g., 'show me NUST imagery', 'run k-means', 'measure distance') are captured "
        "without LLM latency, translating immediately into structured UI actions."
    )
    p2_d.font.size = Pt(13)
    p2_d.font.color.rgb = SILVER

    add_card(s8, 8.8, 2.2, 3.75, 4.4)
    tb3 = s8.shapes.add_textbox(Inches(9.0), Inches(2.4), Inches(3.35), Inches(4.0))
    tf3 = tb3.text_frame
    tf3.word_wrap = True
    p3 = tf3.paragraphs[0]
    p3.text = "Tier 3: Safe LLM Agent"
    p3.font.bold = True
    p3.font.size = Pt(17)
    p3.font.color.rgb = AMBER
    p3_d = tf3.add_paragraph()
    p3_d.space_before = Pt(10)
    p3_d.text = (
        "Groq LLaMA 3.3 70B JSON-mode reasoning.\n\n"
        "The model can explain complex remote sensing concepts (NDVI, spectral bands, clustering) AND suggest at most ONE action "
        "from an immutable server whitelist. Any invalid parameter or out-of-bounds value is dropped server-side."
    )
    p3_d.font.size = Pt(13)
    p3_d.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 9: Map Composer Studio
    # ==========================================
    s9 = prs.slides.add_slide(blank_layout)
    set_slide_background(s9)
    add_header(s9, "Cartographic Map Studio", "Single-Canvas Publication-Ready Cartography",
               "Bridge the gap between raw data analysis and scientific reporting with one unified canvas.")

    features = [
        ("One-Canvas Architecture", "The preview and export are drawn by the identical `drawStudioMap` routine, guaranteeing 100% WYSIWYG fidelity with zero layout drift."),
        ("Multi-Scale Export", "Export high-dpi figures at 1x, 2x, or 3x pixel density for presentation screens, academic publications, or report documents."),
        ("Flexible Legend Placements", "5 outside margin bands (right, left, bottom-left/center/right) and 4 on-map corner overlays with automated class percentages."),
        ("Ground-Truth Scale Bar", "Accurately represents ground distances in meters, kilometers, feet, or miles using native Sentinel-2 metadata."),
        ("Customizable North Arrow", "Supports classic arrow, compass rose, and triangle styles with 7 distinct on-map and outside margin placements."),
        ("Attribution & Metadata", "Automatic credit line embedding ('Contains modified Copernicus Sentinel data') and optional 4-corner GPS coordinates.")
    ]
    for idx, (title, desc) in enumerate(features):
        row = idx // 2
        col = idx % 2
        left = 0.8 + col * 5.95
        top = 2.2 + row * 1.5
        add_card(s9, left, top, 5.75, 1.35)
        tb = s9.shapes.add_textbox(Inches(left + 0.25), Inches(top + 0.15), Inches(5.25), Inches(1.1))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = title
        p.font.bold = True
        p.font.size = Pt(15)
        p.font.color.rgb = CYAN if col == 0 else EMERALD
        
        pd = tf.add_paragraph()
        pd.text = desc
        pd.font.size = Pt(11.5)
        pd.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 10: Security & Performance
    # ==========================================
    s10 = prs.slides.add_slide(blank_layout)
    set_slide_background(s10)
    add_header(s10, "Enterprise Security & Performance", "Defensive Engineering & Zero-Disk Leakage",
               "Hardened against credential leakage, excessive memory usage, and unauthorized network traversal.")

    sec_cards = [
        ("Secret Redaction",
         "Custom log safety filter scans all outbound logs and tracebacks, automatically scrubbing credential patterns (Groq, Copernicus tokens).",
         CYAN),
        ("In-Memory Ephemeral Storage",
         "Session images exist only in memory with a 60-minute sliding TTL. No sensitive user uploads are ever persisted to server disks.",
         EMERALD),
        ("Strict Rate Limiting",
         "Per-IP token bucket limits protect external APIs (10 req/min for AI chat, 5 req/min for satellite, 1 req/s for Nominatim geocoding).",
         WHITE),
        ("Path & Static Guardrails",
         "Static file handler rigorously rejects dotfiles, directory traversal segments ('..'), and denied dev folders (tests, __pycache__).",
         AMBER)
    ]
    for idx, (title, desc, color) in enumerate(sec_cards):
        row = idx // 2
        col = idx % 2
        left = 0.8 + col * 5.95
        top = 2.2 + row * 2.3
        add_card(s10, left, top, 5.75, 2.05)
        tb = s10.shapes.add_textbox(Inches(left + 0.3), Inches(top + 0.25), Inches(5.15), Inches(1.55))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = title
        p.font.bold = True
        p.font.size = Pt(18)
        p.font.color.rgb = color
        
        pd = tf.add_paragraph()
        pd.space_before = Pt(8)
        pd.text = desc
        pd.font.size = Pt(13)
        pd.font.color.rgb = SILVER

    # ==========================================
    # SLIDE 11: Competitive Advantage & Benchmarks
    # ==========================================
    s11 = prs.slides.add_slide(blank_layout)
    set_slide_background(s11)
    add_header(s11, "Competitive Advantage", "How GeoCluster 2.0 Compares to Existing GIS Stacks",
               "Radical accessibility without sacrificing scientific precision.")

    headers = ["Feature", "Traditional GIS (Desktop)", "Cloud Notebooks (GEE/Python)", "GeoCluster 2.0 (Web)"]
    rows = [
        ["Installation", "Heavy install (5-15 GB)", "Requires Python / cloud setup", "Zero install (instant web access)"],
        ["Satellite Retrieval", "Manual download / complex plugins", "API code scripts required", "1-click place name / coordinates"],
        ["Learning Curve", "Weeks to months", "Requires programming skill", "Instant / guided by AI Assistant"],
        ["AI Copilot", "None or experimental plugins", "Separate LLM tab / manual prompt", "Integrated Groq LLaMA 3.3 70B"],
        ["Map Composition", "Complex layout views", "Manual Matplotlib scripting", "Integrated single-canvas Map Studio"],
        ["Resource Footprint", "Heavy RAM / GPU locks", "Server quota limits", "Efficient in-memory sliding TTL"]
    ]

    table_shape = s11.shapes.add_table(len(rows) + 1, len(headers), Inches(0.8), Inches(2.2), Inches(11.73), Inches(4.5))
    table = table_shape.table
    table.columns[0].width = Inches(2.2)
    table.columns[1].width = Inches(3.1)
    table.columns[2].width = Inches(3.2)
    table.columns[3].width = Inches(3.23)

    # Style Header Row
    for c_idx, h in enumerate(headers):
        cell = table.cell(0, c_idx)
        cell.fill.solid()
        cell.fill.fore_color.rgb = RGBColor(30, 58, 138) if c_idx < 3 else RGBColor(6, 78, 59)
        p = cell.text_frame.paragraphs[0]
        p.text = h
        p.font.bold = True
        p.font.size = Pt(13)
        p.font.color.rgb = WHITE

    # Style Data Rows
    for r_idx, row in enumerate(rows):
        for c_idx, val in enumerate(row):
            cell = table.cell(r_idx + 1, c_idx)
            cell.fill.solid()
            cell.fill.fore_color.rgb = CARD_BG if c_idx < 3 else RGBColor(19, 78, 74)
            p = cell.text_frame.paragraphs[0]
            p.text = val
            p.font.size = Pt(11.5)
            p.font.color.rgb = WHITE if c_idx == 3 else SILVER

    # ==========================================
    # SLIDE 12: Roadmap & Conclusion
    # ==========================================
    s12 = prs.slides.add_slide(blank_layout)
    set_slide_background(s12)
    add_header(s12, "Future Horizon & Impact", "Expanding the Frontier of Democratized Earth Observation",
               "Building next-generation geospatial intelligence for researchers and decision-makers.")

    r_items = [
        ("Multispectral Indices (Q1 2027)", "Native calculation of NDVI, NDWI, SAVI, and NBR directly from Sentinel-2 NIR/SWIR bands for crop health and drought monitoring."),
        ("Supervised Deep Learning (Q2 2027)", "Integrating browser-side ONNX / WebGPU inference for automated building footprint extraction and road network segmentation."),
        ("Multi-Constellation Support (Q3 2027)", "Expanding data ingestion to Landsat 8/9, PlanetScope daily mosaics, and synthetic aperture radar (Sentinel-1 SAR)."),
        ("Collaborative Cloud Workspaces (Q4 2027)", "Shared project sessions, annotated map export, and webhooks for GIS automated pipeline integration.")
    ]
    for idx, (title, desc) in enumerate(r_items):
        top = 2.1 + idx * 1.05
        add_card(s12, 0.8, top, 11.73, 0.95)
        tb = s12.shapes.add_textbox(Inches(1.0), Inches(top + 0.1), Inches(11.3), Inches(0.75))
        tf = tb.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = title
        p.font.bold = True
        p.font.size = Pt(15)
        p.font.color.rgb = EMERALD
        
        pd = tf.add_paragraph()
        pd.text = desc
        pd.font.size = Pt(12)
        pd.font.color.rgb = SILVER

    # Thank you footer card
    add_card(s12, 0.8, 6.4, 11.73, 0.75, bg_color=RGBColor(15, 23, 42), border_color=EMERALD)
    tb_foot = s12.shapes.add_textbox(Inches(1.0), Inches(6.5), Inches(11.3), Inches(0.55))
    tf_foot = tb_foot.text_frame
    p_ft = tf_foot.paragraphs[0]
    p_ft.text = "GeoCluster 2.0 • Thank You! • Open Source: https://github.com/Furqan6701/GEOCLUSTER-2.0"
    p_ft.font.bold = True
    p_ft.font.size = Pt(13)
    p_ft.font.color.rgb = WHITE
    p_ft.alignment = PP_ALIGN.CENTER

    prs.save(output_path)
    print(f"Successfully generated {output_path} with {len(prs.slides)} slides.")

if __name__ == "__main__":
    build_deck("GEOCLUSTER_2.0_Pitch_Deck.pptx")
