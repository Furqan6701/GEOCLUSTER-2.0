# GEOCLUSTER 2.0

## AI-Powered Geospatial Image Analysis Platform

GEOCLUSTER 2.0 is an AI-powered desktop application that combines satellite imagery retrieval, GIS visualization, and classical image processing into a single intelligent geospatial analysis platform.

Developed for the **AMD Developer Hackathon: ACT II (Unicorn Track)**, GEOCLUSTER 2.0 enables users to retrieve satellite imagery, apply spatial filters and radiometric enhancements, perform clustering and classification, measure real-world distances, and interact with the system using natural language.

---

## Key Features

- 🛰️ Satellite imagery retrieval
- 🤖 AI-powered geospatial assistant
- 💬 Natural language command interface
- 🎨 Spatial filters (Grayscale, Negative, Mean Filter, Laplacian)
- 🔆 Radiometric enhancement (Brightness, Threshold)
- 📊 K-Means clustering
- 🏷️ Cluster classification
- 🗺️ Map generation from clusters
- 📈 Metadata tools (Statistics, Histogram)
- 🗜️ Huffman compression / decompression
- 📏 Distance measurement with custom unit conversion
- 🔍 Zoom, Fit, and Pan controls
- 🖥️ Modern PyQt5 desktop interface

---

# ✨ Key Features

### 🤖 AI Assistant

- 💬 Conversational AI powered by **GPT-OSS-20B**
- 🧠 Natural language command understanding
- 📚 Remote sensing and GIS knowledge assistant (e.g. answers questions like "What is NDVI?")
- ⚡ Intelligent command routing to the app's processing tools
- 🎯 Context-aware responses

---

### 🛰️ Satellite Imagery

- 📡 Satellite imagery retrieval
- 🌍 Location-based imagery loading

---

### 🎨 Spatial Filters

- ⚫ Grayscale
- 🎭 Negative
- 🌊 Mean Filter
- 🔲 Laplacian

---

### 🔆 Radiometric Enhancement

- 🔆 Brightness adjustment
- 🌗 Thresholding

---

### 📊 Clustering

- 🎨 K-Means Clustering
- 🏷️ Classify Clusters
- 🗺️ Generate Map

---

### 📈 Metadata

- 📊 Statistics
- 📉 Histogram

---

### 🗜️ Compression

- 🗜️ Huffman Compress
- 📂 Huffman Decompress

---

### 📏 Distance Tool

- 📏 Pixel distance measurement
- 🔁 Custom unit conversion (e.g. cm, with configurable pixels-per-unit)

---

### 🖥️ Desktop Experience

- 🎯 Modern PyQt5 Interface
- 🪟 Floating AI Assistant panel
- 🔍 Zoom In / Zoom Out / Fit / Pan
- 🖱️ Interactive User Experience

---

# 🧠 How GEOCLUSTER Thinks

Every interaction inside **GEOCLUSTER 2.0** follows an intelligent processing pipeline designed to make geospatial analysis as simple as having a conversation.

```text
              👤 User
                 │
                 ▼
      💬 Natural Language Query
                 │
                 ▼
      🤖 AI Assistant (GPT-OSS-20B)
                 │
                 ▼
         🧠 Command Router
                 │
      ┌──────────┴──────────┐
      │                     │
      ▼                     ▼
🛰️ Satellite Client      🖼️ Image Processing
      │                     │
      ▼                     ▼
Satellite Imagery      Filters / Clustering / Metadata
      │                     │
      └──────────┬──────────┘
                 ▼
        🖥️ GEOCLUSTER Interface
```

The AI assistant first interprets the user's request using natural language understanding. The command router then determines whether the request requires satellite imagery retrieval, image processing, or an informational response. Results are seamlessly displayed inside the desktop application, providing an intuitive and interactive GIS experience.

---

# 🏗️ System Architecture

GEOCLUSTER 2.0 follows a modular architecture that separates the user interface, AI interaction, processing modules, and satellite retrieval system.

```text
                    GEOCLUSTER 2.0
                           │
      ┌────────────────────┼────────────────────┐
      │                    │                    │
      ▼                    ▼                    ▼
🖥️ User Interface     🤖 AI Assistant     🛰️ Satellite Client
      │                    │
      ▼                    ▼
 Image Viewer       Command Router
      │                    │
      └──────────────┬─────┘
                     ▼
          🖼️ Processing Engine
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
 K-Means         Spatial          Radiometric
 Clustering       Filters         Enhancement
```

The modular design allows new processing algorithms, AI commands, and satellite providers to be added with minimal changes to the overall application.

---

# 🛠️ Technology Stack

| Category | Technologies |
|----------|--------------|
| 🐍 Programming Language | Python 3.11 |
| 🖥️ Desktop GUI | PyQt5 |
| 🤖 AI | GPT-OSS-20B (Fireworks AI) |
| 🖼️ Image Processing | OpenCV |
| 🔢 Scientific Computing | NumPy |
| 📊 Visualization | Matplotlib |
| 🖼️ Image Handling | Pillow |
| 🔥 Deep Learning | PyTorch |
| 🌐 Networking | Requests |
| 🔐 Environment Management | python-dotenv |
| 📦 Containerization | Docker |

---

# 📂 Project Structure

```text
GEOCLUSTER 2.0
│
├── frontend/
│   ├── app.py
│   ├── ui.py
│   ├── ai_widget.py
│   ├── ai_panel.py
│   ├── ai_assistant.py
│   ├── command_router.py
│   ├── sentinel_client.py
│   ├── location_database.py
│   └── assets/
│       └── ai_icon.png
│
├── backend/
│
├── Dockerfile
├── requirements.txt
├── README.md
└── .dockerignore
```

The project is organized into modular components, making it easier to extend, maintain, and integrate additional AI capabilities in future versions.

---

# 🚀 Getting Started

## 📋 Prerequisites

Before running GEOCLUSTER 2.0, ensure the following are installed:

- Python 3.11+
- Git
- Docker Desktop (Optional)
- Internet connection (for AI and satellite imagery)

---

## 📥 Clone the Repository

```bash
git clone <repository-url>
```

Move into the project folder:

```bash
cd "GEOCLUSTER 2.0"
```

> **Note:** The repository contains a nested folder — the actual application lives inside `GEOCLUSTER 2.0/GEOCLUSTER 2.0/`. Make sure you `cd` into the **inner** folder before continuing:
>
> ```bash
> cd "GEOCLUSTER 2.0"
> ```
>
> You should see `frontend/`, `backend/`, `venv/`, and `requirements.txt` in your current directory before proceeding.

---

## 📦 Install Dependencies

```bash
pip install -r requirements.txt
```

---

## ▶️ Launch GEOCLUSTER

```bash
python -m frontend.app
```

The application will launch with the integrated AI assistant and geospatial analysis interface.

---

# 🐳 Docker Support (Optional)

GEOCLUSTER 2.0 includes optional Docker support for reproducible builds and deployment. **This is not required to run the app** — if you followed the steps above, you already have everything you need to run GEOCLUSTER locally with Python.

Docker is provided mainly as a convenience for packaging the app and its dependencies consistently across environments.

### Build the Docker image

```bash
docker build -t geocluster .
```

### Run the container

```bash
docker run geocluster
```

> **Note:** GEOCLUSTER 2.0 is a PyQt5 desktop application. Since it has a graphical interface, running it inside a Docker container requires additional display configuration (e.g. X11 forwarding on Linux, or a tool like VcXsrv on Windows) — it won't just work out of the box the way a typical containerized web app would. For most users, running the app natively with Python (as shown above) is the simplest path.

---

# 💬 Example AI Commands

## 🛰️ Satellite Retrieval

```text
Show me F-8 imagery
```

---

## 🖼️ Image Processing

```text
Apply K-Means
```

```text
Generate Histogram
```

```text
Increase Brightness
```

```text
Apply Mean Filter
```

---

## 📚 General GIS Questions

```text
What is NDVI?
```

```text
What is Remote Sensing?
```

```text
Explain supervised classification.
```

---

# 📸 Application Preview

The following screenshots demonstrate GEOCLUSTER 2.0 in action.

| Screenshot | Description |
|------------|-------------|
| 🖥️ Main Interface | Primary application window |
| 🤖 AI Assistant | Floating AI chat panel |
| 🎨 Spatial Filters | Grayscale, Negative, Mean Filter, Laplacian |
| 📊 Clustering | K-Means clustering and classification |
| 📏 Distance Tool | Pixel-to-unit distance measurement |

> Screenshots will be added before the final submission.

---

# 🚀 Future Roadmap

Although GEOCLUSTER 2.0 already provides an integrated AI-powered geospatial analysis environment, several enhancements are planned for future releases:

- 🌍 Global location database
- 🛰️ Additional satellite providers
- 🌱 Remote sensing indices (NDVI, SAVI)
- 🧠 Advanced deep learning models for land cover classification
- ☁️ Cloud-based image processing
- 🌐 Web application version
- 📊 Interactive GIS dashboards
- 🗺️ 3D terrain visualization
- 🤝 Multi-user collaboration

---

# 🙏 Acknowledgements

This project was proudly developed for the **AMD Developer Hackathon: ACT II (Unicorn Track)**.

Special thanks to:

- ❤️ AMD
- 🚀 lablab.ai
- 🤖 Fireworks AI
- 🐍 Python Community
- 📦 Open Source Contributors

---

# 📜 License

This project was developed for educational purposes and as part of the **AMD Developer Hackathon: ACT II**.

Feel free to explore, learn from, and build upon the project while respecting the licenses of all third-party libraries and services used.