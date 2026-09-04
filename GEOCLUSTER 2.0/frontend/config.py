import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
PARAMS_TXT = os.path.join(DATA_DIR, "params.txt")
CENTROIDS_TXT = os.path.join(DATA_DIR, "centroids.txt")
RANGES_TXT = os.path.join(DATA_DIR, "ranges.txt")
OUTPUT_CSV = os.path.join(DATA_DIR, "output.csv")
META_TXT = os.path.join(DATA_DIR, "output_meta.txt")
HUFFMAN_BIN = os.path.join(DATA_DIR, "huffman.bin")
IMAGES_DIR = os.path.join(BASE_DIR, "images")
DEFAULT_IMAGE = os.path.join(IMAGES_DIR, "sample.jpg")
PYTHON_EXE = sys.executable


def verify_paths():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)
    return []
