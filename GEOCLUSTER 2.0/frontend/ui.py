from __future__ import annotations
from frontend.location_database import get_sector_bbox
from frontend.sentinel_client import fetch_sentinel_image, fetch_sector_image
from frontend.command_router import CommandRouter
from frontend.ai_widget import FloatingAIWidget
from frontend.ai_panel import AIPanel
from frontend.ai_assistant import AIAssistant

import heapq
import os
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec
from PyQt5.QtCore import QEvent, Qt, pyqtSignal
from PyQt5.QtGui import QColor, QCursor, QImage, QPen, QPixmap
from PyQt5.QtWidgets import (
    QAction,
    QActionGroup,
    QApplication,
    QCheckBox,
    QComboBox,
    QColorDialog,
    QDialog,
    QDialogButtonBox,
    QDockWidget,
    QFileDialog,
    QFormLayout,
    QGraphicsLineItem,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsView,
    QGroupBox,
    QHeaderView,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSlider,
    QSpinBox,
    QStatusBar,
    QStyle,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QToolButton,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from config import (
    PARAMS_TXT,
    CENTROIDS_TXT, RANGES_TXT,
    IMAGES_DIR, DATA_DIR, verify_paths,
    OUTPUT_CSV as CONFIG_OUTPUT_CSV,
    META_TXT as CONFIG_META_TXT,
    HUFFMAN_BIN as CONFIG_HUFFMAN_BIN,
    DEFAULT_IMAGE as CONFIG_DEFAULT_IMAGE,
)
from backend_py import process_operation

PROJECT_ROOT = Path(DATA_DIR).parent
DATA_DIR = Path(DATA_DIR)
IMAGES_DIR = Path(IMAGES_DIR)
PARAMS_TXT = Path(PARAMS_TXT)
CENTROIDS_TXT = Path(CENTROIDS_TXT)
RANGES_TXT = Path(RANGES_TXT)
OUTPUT_CSV = Path(CONFIG_OUTPUT_CSV)
META_TXT = Path(CONFIG_META_TXT)
HUFFMAN_BIN = Path(CONFIG_HUFFMAN_BIN)
DEFAULT_IMAGE = Path(CONFIG_DEFAULT_IMAGE)


@dataclass
# [DSA] Record Struct - packages operation metadata so menus and descriptions stay synchronized
class OperationConfig:
    key: str
    title: str
    description: str


OPERATIONS: List[OperationConfig] = [
    OperationConfig("grayscale", "Grayscale", "Convert the loaded image to grayscale."),
    OperationConfig("negative", "Negative", "Invert grayscale intensities using 255 - pixel."),
    OperationConfig("brightness", "Brightness", "Add or subtract a constant value from all pixels."),
    OperationConfig("laplacian", "Laplacian", "Apply Laplacian edge detection to the original image."),
    OperationConfig("statistics", "Statistics", "Show grayscale image statistics for the original image."),
    OperationConfig("threshold", "Threshold", "Convert grayscale to black and white using a cutoff value."),
    OperationConfig("meanfilter", "Mean Filter", "Smooth grayscale values with a configurable moving window."),
    OperationConfig("kmeans", "K-Means Clustering", "Cluster grayscale intensities into K classes."),
    OperationConfig("histogram", "Histogram", "Open the histogram analysis window for the original or output image."),
]


# [KEY] parse_metadata
# Why important: run details and distance measurements rely on these parsed key-value pairs.
# Logic: split each metadata line once at '=' and trim both sides before storing them in a dictionary.
# Complexity: O(n) time | O(n) space
# Watch out: only the first '=' is treated as the separator, so values may safely contain additional '=' characters.
def parse_metadata(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    metadata: Dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            metadata[key.strip()] = value.strip()
    return metadata


# [DSA] Matrix Serialization - writes a NumPy image array as the CSV format expected by the backend
def write_csv_matrix(path: Path, image: np.ndarray) -> None:
    np.savetxt(path, image.astype(np.uint8), fmt="%d", delimiter=",")


# [DSA] Matrix Deserialization - rebuilds a 2D NumPy array from the backend's CSV output
def read_csv_matrix(path: Path) -> np.ndarray:
    matrix = np.loadtxt(path, delimiter=",", dtype=np.uint8)
    if matrix.ndim == 1:
        matrix = matrix.reshape(1, -1)
    return matrix


# [DSA] Hash Map - maps cluster ids to centroid values for O(1) average lookup during display reconstruction
def read_centroids(path: Path) -> Dict[int, int]:
    centroids: Dict[int, int] = {}
    if not path.exists():
        return centroids
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line:
            continue
        k, v = line.strip().split("=", 1)
        centroids[int(k)] = int(v)
    return centroids


# [DSA] Hash Map - maps cluster ids to grayscale intervals for quick cluster classification lookups
def read_ranges(path: Path) -> Dict[int, Tuple[int, int]]:
    ranges: Dict[int, Tuple[int, int]] = {}
    if not path.exists():
        return ranges
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line:
            continue
        k, r = line.strip().split("=", 1)
        minv, maxv = r.split("-", 1)
        ranges[int(k)] = (int(minv), int(maxv))
    return ranges


# [DSA] Key-Value Serialization - writes backend parameters as one 'key=value' pair per line
def write_params(path: Path, params: Dict[str, str | int]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for key, value in params.items():
            handle.write(f"{key}={value}\n")


# [DSA] Interval Partitioning - divides the 0..255 grayscale domain into K contiguous default buckets
def calculate_default_ranges(K: int) -> List[Tuple[int, int]]:
    ranges = []
    step = 256 / K
    for i in range(K):
        min_val = int(i * step)
        max_val = int((i + 1) * step) - 1
        if i == K - 1:
            max_val = 255
        ranges.append((min_val, max_val))
    return ranges


# [DSA] String Builder - joins interval pairs into the compact comma-separated range string the backend parses
def ranges_to_string(ranges: List[Tuple[int, int]]) -> str:
    return ",".join(f"{min_val}-{max_val}" for min_val, max_val in ranges)


LAND_COVER_OPTIONS = [
    "Shadows",
    "Dark Trees / Forest",
    "Light Trees / Dry Vegetation",
    "Grass / Lawn",
    "Roads / Pathways",
    "Buildings / Rooftops",
    "Bare Soil / Ground",
    "Parking / Open Area",
    "Urban / Mixed",
    "Water Body",
    "Other",
]

SIX_CLUSTER_DEFAULTS = [
    {"cluster": 0, "min": 0, "max": 69, "land_cover": "Shadows", "color": (0, 0, 0)},
    {"cluster": 1, "min": 70, "max": 85, "land_cover": "Dark Trees / Forest", "color": (0, 180, 0)},
    {"cluster": 2, "min": 86, "max": 130, "land_cover": "Buildings / Rooftops", "color": (128, 128, 128)},
    {"cluster": 3, "min": 131, "max": 145, "land_cover": "Bare Soil / Ground", "color": (100, 200, 0)},
    {"cluster": 4, "min": 146, "max": 216, "land_cover": "Grass / Lawn", "color": (180, 180, 180)},
    {"cluster": 5, "min": 217, "max": 255, "land_cover": "Buildings / Rooftops", "color": (255, 255, 255)},
]


# [KEY] default_cluster_assignments
# Why important: legend labels and cluster colors come from here; wrong defaults make maps misleading even if clustering is correct.
# Logic: use a curated six-cluster preset when available, otherwise assign ordered names and evenly spaced HSV colors.
# Complexity: O(k log k) time | O(k) space
# Watch out: cluster keys are sorted first so visual labels stay stable across runs.
# [DSA] Hash Map - stores per-cluster display metadata by cluster id
def default_cluster_assignments(method: str, cluster_keys: List[int]) -> Dict[int, Dict[str, object]]:
    sorted_clusters = sorted(cluster_keys)
    if len(sorted_clusters) == 6:
        return {
            cluster: {
                "name": SIX_CLUSTER_DEFAULTS[i]["land_cover"],
                "color": SIX_CLUSTER_DEFAULTS[i]["color"],
            }
            for i, cluster in enumerate(sorted_clusters)
        }
    names = [
        "Shadows",
        "Dark Trees / Forest",
        "Roads / Pathways",
        "Bare Soil / Ground",
        "Grass / Lawn",
        "Buildings / Rooftops",
        "Parking / Open Area",
        "Urban / Mixed",
        "Water Body",
        "Other",
    ]
    assignments: Dict[int, Dict[str, object]] = {}
    count = len(sorted_clusters)
    for i, cluster in enumerate(sorted_clusters):
        color = QColor.fromHsv(int(i * 255 / max(count, 1)), 180, 220)
        assignments[cluster] = {
            "name": names[i] if i < len(names) else "Other",
            "color": (color.red(), color.green(), color.blue()),
        }
    return assignments


# [DSA] Hash Map - assigns each cluster id to its active grayscale interval
def default_cluster_ranges(cluster_keys: List[int]) -> Dict[int, Tuple[int, int]]:
    sorted_clusters = sorted(cluster_keys)
    if len(sorted_clusters) == 6:
        return {
            cluster: (SIX_CLUSTER_DEFAULTS[i]["min"], SIX_CLUSTER_DEFAULTS[i]["max"])
            for i, cluster in enumerate(sorted_clusters)
        }
    calculated = calculate_default_ranges(max(1, len(sorted_clusters)))
    return {cluster: calculated[i] for i, cluster in enumerate(sorted_clusters)}


# [DSA] Masked Assignment - fills all pixels belonging to each cluster in one vectorized NumPy pass
def build_cluster_display_image(labels: np.ndarray, centroids: Dict[int, int], assignments: Dict[int, Dict[str, object]]) -> np.ndarray:
    h, w = labels.shape
    display_img = np.zeros((h, w, 3), dtype=np.uint8)
    for k, config in assignments.items():
        color = tuple(int(c) for c in config["color"])
        display_img[labels == k] = (color[2], color[1], color[0])
    return display_img


# [DSA] Masked Assignment - paints each label region with its configured land-cover color
def build_cluster_map_image(labels: np.ndarray, assignments: Dict[int, Dict[str, object]]) -> np.ndarray:
    h, w = labels.shape
    map_img = np.zeros((h, w, 3), dtype=np.uint8)
    for k, config in assignments.items():
        map_img[labels == k] = tuple(int(c) for c in config["color"])
    return map_img


# [KEY] to_grayscale
# Why important: almost every backend operation expects grayscale input; inconsistent channel handling would break processing.
# Logic: keep 2D arrays unchanged, drop alpha when present, and delegate color conversion to OpenCV.
# Complexity: O(r*c) time | O(r*c) space
# Watch out: BGRA images keep only the first three channels before conversion.
def to_grayscale(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image.copy()
    if image.shape[2] == 4:
        base = image[:, :, :3]
    else:
        base = image
    return cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)


# [KEY] threshold_image
# Why important: binary outputs, later statistics, and visual previews depend on this cutoff behaving consistently across image layouts.
# Logic: apply OpenCV thresholding directly to grayscale data or only to the color channels when alpha is present.
# Complexity: O(r*c) time | O(r*c) space
# Watch out: alpha is preserved for 4-channel images while only BGR content is thresholded.
def threshold_image(image: np.ndarray, threshold: int) -> np.ndarray:
    if image.ndim == 2:
        _, output = cv2.threshold(image, threshold, 255, cv2.THRESH_BINARY)
        return output
    if image.shape[2] == 4:
        output = image.copy()
        _, output[:, :, :3] = cv2.threshold(image[:, :, :3], threshold, 255, cv2.THRESH_BINARY)
        return output
    _, output = cv2.threshold(image, threshold, 255, cv2.THRESH_BINARY)
    return output


# [DSA] Binary Tree Node - stores one Huffman subtree for Python-side compression and decompression
class _PyHuffmanNode:
    def __init__(self, frequency: int, value: int | None = None, left: "_PyHuffmanNode | None" = None, right: "_PyHuffmanNode | None" = None) -> None:
        self.frequency = frequency
        self.value = value
        self.left = left
        self.right = right

    def __lt__(self, other: "_PyHuffmanNode") -> bool:
        left_value = -1 if self.value is None else self.value
        right_value = -1 if other.value is None else other.value
        return (self.frequency, left_value) < (other.frequency, right_value)


# [KEY] _build_huffman_codes
# Why important: both Python compression and decompression depend on these exact prefix codes.
# Logic: build a min-heap from nonzero frequencies, merge the two lightest nodes until one tree remains, then DFS to assign bits.
# Complexity: O(a log a) time | O(a) space
# Watch out: the single-symbol case must still emit code "0" or no payload bits could be decoded later.
# [DSA] Min-Heap - always combines the two lowest-frequency Huffman nodes first
def _build_huffman_codes(frequencies: List[int]) -> Dict[int, str]:
    heap = [_PyHuffmanNode(freq, value=i) for i, freq in enumerate(frequencies) if freq > 0]
    if not heap:
        raise ValueError("Cannot compress empty image data.")
    heapq.heapify(heap)
    if len(heap) == 1:
        return {heap[0].value: "0"}  # type: ignore[index]
    while len(heap) > 1:
        left = heapq.heappop(heap)
        right = heapq.heappop(heap)
        heapq.heappush(
            heap,
            _PyHuffmanNode(
                left.frequency + right.frequency,
                value=min(v for v in (left.value, right.value) if v is not None),
                left=left,
                right=right,
            ),
        )
    codes: Dict[int, str] = {}

    # [DSA] DFS (recursive) - walks root-to-leaf so each left/right decision appends one Huffman bit
    def walk(node: _PyHuffmanNode, prefix: str) -> None:
        if node.value is not None and node.left is None and node.right is None:
            codes[node.value] = prefix or "0"
            return
        walk(node.left, prefix + "0")  # type: ignore[arg-type]
        walk(node.right, prefix + "1")  # type: ignore[arg-type]

    walk(heap[0], "")
    return codes


# [KEY] compress_color_image_huffman
# Why important: this defines the `.gch` file format written by the GUI; mistakes here make saved files unreadable.
# Logic: flatten raw bytes, count frequencies, Huffman-encode them into packed bits, then write a header plus frequency table.
# Complexity: O(n + a log a) time | O(n + a) space
# Watch out: the image is flattened byte-by-byte, so color channels are encoded in the array's existing order.
# [DSA] Frequency Array - counts the 256 possible byte values before Huffman tree construction
def compress_color_image_huffman(image: np.ndarray, path: Path) -> Dict[str, str]:
    source = image.copy()
    if source.ndim == 2:
        channels = 1
    else:
        channels = source.shape[2]

    flat = source.reshape(-1).astype(np.uint8)
    frequencies = [0] * 256
    for value in flat:
        frequencies[int(value)] += 1
    codes = _build_huffman_codes(frequencies)

    packed = bytearray()
    current_byte = 0
    bit_count = 0
    payload_bits = 0
    for value in flat:
        for bit in codes[int(value)]:
            current_byte = (current_byte << 1) | (1 if bit == "1" else 0)  # append one Huffman bit into the current output byte
            bit_count += 1
            payload_bits += 1
            if bit_count == 8:
                packed.append(current_byte)
                current_byte = 0
                bit_count = 0
    if bit_count:
        packed.append(current_byte << (8 - bit_count))

    with path.open("wb") as handle:
        handle.write(b"GCH2")
        handle.write(struct.pack("<IIIII", source.shape[0], source.shape[1], channels, payload_bits, 1))
        for freq in frequencies:
            handle.write(struct.pack("<I", freq))
        handle.write(packed)

    return {
        "path": str(path),
        "rows": str(source.shape[0]),
        "cols": str(source.shape[1]),
        "channels": str(channels),
        "original_bytes": str(int(flat.size)),
        "compressed_bytes": str(path.stat().st_size),
    }


# [KEY] decompress_color_image_huffman
# Why important: this reconstructs saved `.gch` files; if code reversal or bit consumption is wrong the image corrupts immediately.
# Logic: rebuild codes from stored frequencies, scan the payload bit-by-bit, and emit a value whenever a prefix matches.
# Complexity: O(n + a log a) time | O(n + a) space
# Watch out: the decoded value count must exactly equal rows*cols*channels or the payload is invalid.
# [DSA] Prefix Decoding - grows a bitstring until it matches a valid Huffman code, then emits one byte
def decompress_color_image_huffman(path: Path) -> tuple[np.ndarray, Dict[str, str]]:
    data = path.read_bytes()
    if len(data) < 24 or data[:4] != b"GCH2":
        raise ValueError("Invalid Huffman file.")
    rows, cols, channels, payload_bits, version = struct.unpack("<IIIII", data[4:24])
    offset = 24
    frequencies = list(struct.unpack("<256I", data[offset:offset + 1024]))
    offset += 1024
    codes = _build_huffman_codes(frequencies)
    reverse_codes = {code: value for value, code in codes.items()}
    payload = data[offset:]
    values: List[int] = []
    current = ""
    consumed = 0
    for byte in payload:
        for bit in range(7, -1, -1):
            if consumed >= payload_bits:
                break
            current += "1" if ((byte >> bit) & 1) else "0"
            consumed += 1
            value = reverse_codes.get(current)
            if value is not None:
                values.append(value)
                current = ""
    expected = rows * cols * channels
    if len(values) != expected:
        raise ValueError("Corrupted Huffman payload.")
    array = np.array(values, dtype=np.uint8)
    image = array.reshape((rows, cols) if channels == 1 else (rows, cols, channels))
    return image, {
        "path": str(path),
        "rows": str(rows),
        "cols": str(cols),
        "channels": str(channels),
        "version": str(version),
        "compressed_bytes": str(path.stat().st_size),
    }


# [KEY] numpy_to_pixmap
# Why important: every image preview uses this conversion; wrong channel ordering would make the UI display garbage colors.
# Logic: choose the matching QImage format for grayscale, BGRA, or BGR input and copy the buffer into Qt-owned memory.
# Complexity: O(r*c) time | O(r*c) space
# Watch out: `.copy()` is required so the QImage does not outlive the temporary NumPy-backed buffer view.
def numpy_to_pixmap(image: np.ndarray) -> QPixmap:
    if image.ndim == 2:
        qimage = QImage(
            image.data,
            image.shape[1],
            image.shape[0],
            image.strides[0],
            QImage.Format_Grayscale8,
        ).copy()
    elif image.shape[2] == 4:
        rgba = cv2.cvtColor(image, cv2.COLOR_BGRA2RGBA)
        qimage = QImage(
            rgba.data,
            rgba.shape[1],
            rgba.shape[0],
            rgba.strides[0],
            QImage.Format_RGBA8888,
        ).copy()
    else:
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        qimage = QImage(
            rgb.data,
            rgb.shape[1],
            rgb.shape[0],
            rgb.strides[0],
            QImage.Format_RGB888,
        ).copy()
    return QPixmap.fromImage(qimage)


# [KEY] pixel_text
# Why important: cursor inspection and measurement feedback depend on this exact coordinate/value string.
# Logic: bounds-check first, then format grayscale, BGR, or BGRA pixel data according to the image shape.
# Complexity: O(1) time | O(1) space
# Watch out: x and y map to image[y, x], not image[x, y].
def pixel_text(image: np.ndarray | None, x: int, y: int) -> str:
    if image is None or x < 0 or y < 0 or y >= image.shape[0] or x >= image.shape[1]:
        return "x: -, y: -, value: -"
    if image.ndim == 2:
        return f"x: {x}, y: {y}, value: {int(image[y, x])}"
    if image.shape[2] == 4:
        b, g, r, a = image[y, x]
        return f"x: {x}, y: {y}, value: BGRA({int(b)}, {int(g)}, {int(r)}, {int(a)})"
    b, g, r = image[y, x]
    return f"x: {x}, y: {y}, value: BGR({int(b)}, {int(g)}, {int(r)})"


class HistogramTargetDialog(QDialog):
    def __init__(self, has_output: bool, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._selection = ""
        self.setWindowTitle("Histogram Source")
        self.setModal(True)

        layout = QVBoxLayout(self)
        label = QLabel("Generate histogram for:")
        label.setWordWrap(True)
        layout.addWidget(label)

        original_button = QPushButton("Original Image")
        original_button.clicked.connect(lambda: self._choose("original"))
        layout.addWidget(original_button)

        output_button = QPushButton("Output Image")
        output_button.setEnabled(has_output)
        output_button.clicked.connect(lambda: self._choose("output"))
        layout.addWidget(output_button)

        cancel = QDialogButtonBox(QDialogButtonBox.Cancel)
        cancel.rejected.connect(self.reject)
        layout.addWidget(cancel)

    def _choose(self, selection: str) -> None:
        self._selection = selection
        self.accept()

    @property
    def selection(self) -> str:
        return self._selection


class StatisticsTargetDialog(QDialog):
    def __init__(self, has_output: bool, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._selection = ""
        self.setWindowTitle("Statistics Source")
        self.setModal(True)

        layout = QVBoxLayout(self)
        label = QLabel("Generate statistics for:")
        label.setWordWrap(True)
        layout.addWidget(label)

        original_button = QPushButton("Original Image")
        original_button.clicked.connect(lambda: self._choose("original"))
        layout.addWidget(original_button)

        output_button = QPushButton("Output Image")
        output_button.setEnabled(has_output)
        output_button.clicked.connect(lambda: self._choose("output"))
        layout.addWidget(output_button)

        cancel = QDialogButtonBox(QDialogButtonBox.Cancel)
        cancel.rejected.connect(self.reject)
        layout.addWidget(cancel)

    def _choose(self, selection: str) -> None:
        self._selection = selection
        self.accept()

    @property
    def selection(self) -> str:
        return self._selection


class BrightnessDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Brightness")
        self.setModal(True)

        layout = QVBoxLayout(self)

        self.value_label = QLabel()
        layout.addWidget(self.value_label)

        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(-255, 255)
        self.slider.setValue(0)
        self.slider.valueChanged.connect(self._update_label)
        layout.addWidget(self.slider)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self._update_label(0)

    def _update_label(self, value: int) -> None:
        self.value_label.setText(f"Brightness: {value:+d}")

    @property
    def value(self) -> int:
        return self.slider.value()


class KMeansDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("K-Means Clustering")
        self.setModal(True)
        layout = QVBoxLayout(self)
        form = QFormLayout()
        self.k_spin = QSpinBox()
        self.k_spin.setRange(2, 20)
        self.k_spin.setValue(6)
        form.addRow("Number of Clusters (K):", self.k_spin)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    @property
    def value(self) -> int:
        return self.k_spin.value()


class ClassifyClustersDialog(QDialog):
    def __init__(
        self,
        ranges: Dict[int, Tuple[int, int]],
        assignments: Dict[int, Dict[str, object]],
        gray_flat: np.ndarray,
        apply_callback,
        reset_callback,
        rerun_callback,
        generate_map_callback,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Classify Clusters")
        self.setModal(False)
        self.resize(1080, 560)
        self.ranges = dict(sorted(ranges.items()))
        self.assignments = {
            k: {"name": str(v["name"]), "color": tuple(v["color"])} for k, v in assignments.items()
        }
        self.gray_flat = gray_flat
        self.apply_callback = apply_callback
        self.reset_callback = reset_callback
        self.rerun_callback = rerun_callback
        self.generate_map_callback = generate_map_callback
        self._updating_ranges = False

        layout = QVBoxLayout(self)
        self.warning_label = QLabel("")
        self.warning_label.setStyleSheet("color: #f87171;")
        layout.addWidget(self.warning_label)
        self.table = QTableWidget(len(sorted(ranges)), 7)
        self.table.setHorizontalHeaderLabels([
            "Cluster",
            "Min Value",
            "Max Value",
            "Pixel Count",
            "Percentage",
            "Land Cover Type",
            "Color",
        ])
        self._build_rows()
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Stretch)
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(4, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(6, QHeaderView.ResizeToContents)
        layout.addWidget(self.table)

        button_row = QHBoxLayout()
        apply_button = QPushButton("Apply")
        apply_button.clicked.connect(self.apply_changes)
        button_row.addWidget(apply_button)

        reset_button = QPushButton("Reset to Default")
        reset_button.clicked.connect(self.reset_defaults)
        button_row.addWidget(reset_button)

        rerun_button = QPushButton("Re-run Algorithm")
        rerun_button.clicked.connect(self.rerun_algorithm)
        button_row.addWidget(rerun_button)

        map_button = QPushButton("Generate Map")
        map_button.clicked.connect(self.generate_map_now)
        button_row.addWidget(map_button)

        close_button = QPushButton("Close")
        close_button.clicked.connect(self.close)
        button_row.addWidget(close_button)
        layout.addLayout(button_row)

    # [KEY] _build_rows
    # Why important: the classification editor depends on each table row matching the correct cluster state.
    # Logic: build one row per sorted cluster with synchronized spin boxes, labels, combo boxes, and color buttons.
    # Complexity: O(k log k) time | O(k) space
    # Watch out: lambda callbacks capture `cluster` through a default argument so each widget updates the right row.
    def _build_rows(self) -> None:
        for row, cluster in enumerate(sorted(self.ranges)):
            cluster_item = QTableWidgetItem(str(cluster))
            cluster_item.setFlags(cluster_item.flags() & ~Qt.ItemIsEditable)
            self.table.setItem(row, 0, cluster_item)
            min_spin = QSpinBox()
            min_spin.setRange(0, 255)
            min_spin.setValue(self.ranges[cluster][0])
            min_spin.valueChanged.connect(lambda value, c=cluster: self._on_min_changed(c, value))
            self.table.setCellWidget(row, 1, min_spin)

            max_spin = QSpinBox()
            max_spin.setRange(0, 255)
            max_spin.setValue(self.ranges[cluster][1])
            max_spin.valueChanged.connect(lambda value, c=cluster: self._on_max_changed(c, value))
            self.table.setCellWidget(row, 2, max_spin)

            count_label = QLabel("0")
            self.table.setCellWidget(row, 3, count_label)

            percent_label = QLabel("0.0%")
            self.table.setCellWidget(row, 4, percent_label)

            combo = QComboBox()
            combo.addItems(LAND_COVER_OPTIONS)
            combo.setCurrentText(str(self.assignments[cluster]["name"]))
            self.table.setCellWidget(row, 5, combo)

            button = QPushButton()
            button.setMinimumHeight(34)
            button.clicked.connect(lambda _=False, c=cluster: self.pick_color(c))
            self.table.setCellWidget(row, 6, button)
            self._refresh_row(cluster)
        self._lock_edges()
        self._recalculate_counts()
        header = self.table.horizontalHeader()
        header.setStretchLastSection(True)

    def _row_for_cluster(self, cluster: int) -> int:
        return sorted(self.ranges).index(cluster)

    def _refresh_row(self, cluster: int) -> None:
        row = self._row_for_cluster(cluster)
        color = tuple(int(v) for v in self.assignments[cluster]["color"])
        button = self.table.cellWidget(row, 6)
        if len(self.ranges) == 6 and cluster in {0, 1, 2}:
            text_color = "white"
        elif len(self.ranges) == 6 and cluster in {3, 4, 5}:
            text_color = "black"
        else:
            text_color = "white" if sum(color) < 420 else "black"
        style = f"background-color: rgb({color[0]}, {color[1]}, {color[2]}); color: {text_color};"
        button.setStyleSheet(style)
        button.setText("")

    def _lock_edges(self) -> None:
        clusters = sorted(self.ranges)
        if not clusters:
            return
        first_row = self._row_for_cluster(clusters[0])
        last_row = self._row_for_cluster(clusters[-1])
        self.table.cellWidget(first_row, 1).setEnabled(False)
        self.table.cellWidget(last_row, 2).setEnabled(False)

    def _set_row_invalid(self, cluster: int, invalid: bool) -> None:
        row = self._row_for_cluster(cluster)
        color = "#7f1d1d" if invalid else "transparent"
        for column in range(self.table.columnCount()):
            item = self.table.item(row, column)
            if item is not None:
                item.setBackground(QColor(color))
            widget = self.table.cellWidget(row, column)
            if widget is not None:
                widget.setStyleSheet(widget.styleSheet() + (f"; background-color: {color};" if invalid else ""))

    # [KEY] _recalculate_counts
    # Why important: percentages and validation warnings drive the user's manual reclassification decisions.
    # Logic: scan each active grayscale interval, count matching pixels with NumPy masks, and flag invalid min/max ranges.
    # Complexity: O(k*n) time | O(1) extra space
    # Watch out: ranges are inclusive on both ends, so adjacent buckets must be adjusted carefully to avoid gaps or overlaps.
    # [DSA] Range Counting - counts pixels by checking whether each value falls inside the current cluster interval
    def _recalculate_counts(self) -> None:
        invalid = False
        total = len(self.gray_flat)
        for cluster in sorted(self.ranges):
            min_val, max_val = self.ranges[cluster]
            row = self._row_for_cluster(cluster)
            if min_val > max_val:
                invalid = True
                self.table.cellWidget(row, 3).setText("0")
                self.table.cellWidget(row, 4).setText("0.0%")
            else:
                count = int(np.sum((self.gray_flat >= min_val) & (self.gray_flat <= max_val)))
                percentage = round(count / total * 100, 1) if total else 0.0
                self.table.cellWidget(row, 3).setText(str(count))
                self.table.cellWidget(row, 4).setText(f"{percentage}%")
            self.table.item(row, 0).setBackground(QColor("#7f1d1d") if min_val > max_val else QColor("transparent"))
        self.warning_label.setText("Invalid range: Min cannot exceed Max" if invalid else "")
        if not invalid:
            self.parent().status_label.setText("Ranges updated - click Re-run to re-classify")

    # [KEY] _on_max_changed
    # Why important: one edited upper bound must keep neighboring cluster ranges contiguous.
    # Logic: update the current cluster's max, then push the next cluster's min to `value + 1`.
    # Complexity: O(k log k) time | O(1) space
    # Watch out: `_updating_ranges` prevents recursive signal loops while the paired spin box is adjusted.
    def _on_max_changed(self, cluster: int, value: int) -> None:
        if self._updating_ranges:
            return
        self._updating_ranges = True
        self.ranges[cluster] = (self.ranges[cluster][0], value)
        keys = sorted(self.ranges)
        idx = keys.index(cluster)
        if idx + 1 < len(keys):
            next_cluster = keys[idx + 1]
            self.ranges[next_cluster] = (min(255, value + 1), self.ranges[next_cluster][1])
            self.table.cellWidget(self._row_for_cluster(next_cluster), 1).setValue(min(255, value + 1))
        self._updating_ranges = False
        self._recalculate_counts()

    # [KEY] _on_min_changed
    # Why important: lowering or raising a lower bound must also repair the previous interval to avoid overlap.
    # Logic: update the current cluster's min, then pull the previous cluster's max to `value - 1`.
    # Complexity: O(k log k) time | O(1) space
    # Watch out: `_updating_ranges` prevents recursive signal loops while the paired spin box is adjusted.
    def _on_min_changed(self, cluster: int, value: int) -> None:
        if self._updating_ranges:
            return
        self._updating_ranges = True
        self.ranges[cluster] = (value, self.ranges[cluster][1])
        keys = sorted(self.ranges)
        idx = keys.index(cluster)
        if idx - 1 >= 0:
            prev_cluster = keys[idx - 1]
            self.ranges[prev_cluster] = (self.ranges[prev_cluster][0], max(0, value - 1))
            self.table.cellWidget(self._row_for_cluster(prev_cluster), 2).setValue(max(0, value - 1))
        self._updating_ranges = False
        self._recalculate_counts()

    def pick_color(self, cluster: int) -> None:
        current = tuple(int(v) for v in self.assignments[cluster]["color"])
        dialog = QColorDialog(QColor(current[0], current[1], current[2]), self)
        dialog.setWindowTitle("Choose Color")
        dialog.setOption(QColorDialog.DontUseNativeDialog, True)
        if dialog.exec_() != QDialog.Accepted:
            return
        color = dialog.selectedColor()
        if not color.isValid():
            return
        self.assignments[cluster]["color"] = (color.red(), color.green(), color.blue())
        self._refresh_row(cluster)

    # [DSA] Hash Map - rebuilds the per-cluster name/color mapping from the current table widgets
    def _collect_assignments(self) -> Dict[int, Dict[str, object]]:
        updated: Dict[int, Dict[str, object]] = {}
        for cluster in sorted(self.ranges):
            row = self._row_for_cluster(cluster)
            combo = self.table.cellWidget(row, 5)
            updated[cluster] = {
                "name": combo.currentText(),
                "color": tuple(self.assignments[cluster]["color"]),
            }
        return updated

    def apply_changes(self) -> None:
        self.assignments = self._collect_assignments()
        self.apply_callback(self.ranges, self.assignments)

    def reset_defaults(self) -> None:
        self.ranges, self.assignments = self.reset_callback()
        for cluster in sorted(self.ranges):
            row = self._row_for_cluster(cluster)
            combo = self.table.cellWidget(row, 5)
            self.table.cellWidget(row, 1).setValue(self.ranges[cluster][0])
            self.table.cellWidget(row, 2).setValue(self.ranges[cluster][1])
            combo.setCurrentText(str(self.assignments[cluster]["name"]))
            self._refresh_row(cluster)
        self._lock_edges()
        self._recalculate_counts()

    def rerun_algorithm(self) -> None:
        self.assignments = self._collect_assignments()
        self.rerun_callback(self.ranges, self.assignments)

    def generate_map_now(self) -> None:
        self.assignments = self._collect_assignments()
        self.apply_callback(self.ranges, self.assignments)
        self.generate_map_callback()


class DistanceUnitDialog(QDialog):
    def __init__(self, pixel_distance: float, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Distance Units")
        self.setModal(True)

        layout = QVBoxLayout(self)
        label = QLabel(f"Measured pixel distance: {pixel_distance:.3f} px\n\nChoose the display unit.")
        label.setWordWrap(True)
        layout.addWidget(label)

        form = QFormLayout()

        self.unit_combo = QComboBox()
        self.unit_combo.addItems(["pixels", "mm", "cm", "inches"])
        self.unit_combo.currentTextChanged.connect(self._update_fields)
        form.addRow("Unit", self.unit_combo)

        self.scale_spin = QSpinBox()
        self.scale_spin.setRange(1, 100000)
        self.scale_spin.setValue(1)
        form.addRow("Pixels per unit", self.scale_spin)

        layout.addLayout(form)

        self.help_label = QLabel("For physical units, enter how many pixels equal 1 chosen unit.")
        self.help_label.setWordWrap(True)
        layout.addWidget(self.help_label)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self._update_fields(self.unit_combo.currentText())

    def _update_fields(self, unit: str) -> None:
        is_pixels = unit == "pixels"
        self.scale_spin.setEnabled(not is_pixels)
        self.help_label.setVisible(not is_pixels)

    @property
    def unit(self) -> str:
        return self.unit_combo.currentText()

    @property
    def pixels_per_unit(self) -> int:
        return self.scale_spin.value()


class HistogramWindow(QMainWindow):
    def __init__(self, title: str, image: np.ndarray, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(1040, 640)
        self.source_image = image.copy()
        self.current_theme = "dark"
        self._build_toolbar()

        self.figure = Figure(facecolor="#0a0a0f")
        self.canvas = FigureCanvas(self.figure)
        self.setCentralWidget(self.canvas)
        self.ax = self.figure.add_subplot(111)
        self.figure.subplots_adjust(left=0.09, right=0.97, top=0.9, bottom=0.14)
        self.update_plot()

    def _build_toolbar(self) -> None:
        toolbar = QToolBar("Histogram Tools", self)
        toolbar.setMovable(False)
        self.addToolBar(Qt.TopToolBarArea, toolbar)

        export_action = QAction("Export", self)
        export_action.triggered.connect(self.export_histogram)
        toolbar.addAction(export_action)

        toolbar.addSeparator()
        toolbar.addWidget(QLabel("Bins"))
        self.bin_spin = QSpinBox()
        self.bin_spin.setRange(16, 256)
        self.bin_spin.setValue(256)
        self.bin_spin.valueChanged.connect(self.update_plot)
        toolbar.addWidget(self.bin_spin)

        toolbar.addSeparator()
        toolbar.addWidget(QLabel("Mode"))
        self.mode_combo = QComboBox()
        if self.source_image.ndim == 2:
            self.mode_combo.addItems(["Grayscale", "Smoothed"])
        else:
            self.mode_combo.addItems(["RGB Overlay", "Red", "Green", "Blue", "Luminance", "Smoothed"])
        self.mode_combo.currentIndexChanged.connect(self.update_plot)
        toolbar.addWidget(self.mode_combo)

        toolbar.addSeparator()
        self.log_check = QCheckBox("Log Y")
        self.log_check.stateChanged.connect(self.update_plot)
        toolbar.addWidget(self.log_check)

        self.cumulative_check = QCheckBox("Cumulative")
        self.cumulative_check.stateChanged.connect(self.update_plot)
        toolbar.addWidget(self.cumulative_check)

        self.density_check = QCheckBox("Normalize")
        self.density_check.stateChanged.connect(self.update_plot)
        toolbar.addWidget(self.density_check)

        self.grid_check = QCheckBox("Grid")
        self.grid_check.setChecked(True)
        self.grid_check.stateChanged.connect(self.update_plot)
        toolbar.addWidget(self.grid_check)

        toolbar.addSeparator()
        toolbar.addWidget(QLabel("Smooth"))
        self.smooth_slider = QSlider(Qt.Horizontal)
        self.smooth_slider.setRange(0, 8)
        self.smooth_slider.setValue(0)
        self.smooth_slider.setFixedWidth(100)
        self.smooth_slider.valueChanged.connect(self.update_plot)
        toolbar.addWidget(self.smooth_slider)

        toolbar.addSeparator()
        self.theme_action = QAction("Light Theme", self)
        self.theme_action.triggered.connect(self.toggle_theme)
        toolbar.addAction(self.theme_action)

    def _apply_theme(self) -> None:
        if self.current_theme == "dark":
            figure_face = "#0a0a0f"
            axes_face = "#10131a"
            text_color = "#d8e7f2"
            grid_color = "#2b3140"
            spine_color = "#4a5268"
            legend_face = "#10131a"
        else:
            figure_face = "#f8fafc"
            axes_face = "#ffffff"
            text_color = "#0f172a"
            grid_color = "#cbd5e1"
            spine_color = "#94a3b8"
            legend_face = "#ffffff"

        self.figure.set_facecolor(figure_face)
        self.ax.set_facecolor(axes_face)
        self.ax.set_title("Pixel Intensity Distribution", color=text_color)
        self.ax.set_xlabel("Pixel Intensity (0-255)", color=text_color)
        self.ax.set_ylabel("Frequency", color=text_color)
        self.ax.tick_params(colors=text_color)
        for spine in self.ax.spines.values():
            spine.set_color(spine_color)
        self.ax.grid(self.grid_check.isChecked(), color=grid_color, alpha=0.45)
        legend = self.ax.get_legend()
        if legend is not None:
            legend.get_frame().set_facecolor(legend_face)
            legend.get_frame().set_edgecolor(spine_color)
            for text in legend.get_texts():
                text.set_color(text_color)

    def _gray_values(self) -> np.ndarray:
        if self.source_image.ndim == 2:
            return self.source_image.ravel()
        base = self.source_image[:, :, :3] if self.source_image.shape[2] == 4 else self.source_image
        return cv2.cvtColor(base, cv2.COLOR_BGR2GRAY).ravel()

    # [DSA] Sliding Window - averages neighboring bins to smooth jagged histogram spikes without recomputing from raw pixels
    def _smooth_counts(self, counts: np.ndarray, radius: int) -> np.ndarray:
        if radius <= 0:
            return counts
        kernel_size = radius * 2 + 1
        kernel = np.ones(kernel_size, dtype=np.float64) / kernel_size
        padded = np.pad(counts, (radius, radius), mode="edge")
        return np.convolve(padded, kernel, mode="valid")

    # [KEY] _stable_y_limit
    # Why important: an unstable axis makes histogram comparisons visually misleading between refreshes.
    # Logic: compute the peak exact bin count, then round it up to a "nice" power-of-ten-based display limit.
    # Complexity: O(n + b) time | O(b) space
    # Watch out: density plots intentionally skip a fixed limit because the scale depends on normalized bin widths.
    def _stable_y_limit(self, values: np.ndarray, density: bool, cumulative: bool) -> float | None:
        if density:
            return None
        total_pixels = float(values.size)
        if total_pixels <= 0:
            return 1.0
        if cumulative:
            return total_pixels
        exact_counts = np.bincount(values.astype(np.uint8), minlength=256).astype(np.float64)
        peak = float(exact_counts.max())
        if peak <= 0.0:
            return 1.0
        magnitude = 10 ** np.floor(np.log10(peak))
        normalized = peak / magnitude
        if normalized <= 1.0:
            nice = 1.0
        elif normalized <= 2.0:
            nice = 2.0
        elif normalized <= 5.0:
            nice = 5.0
        else:
            nice = 10.0
        return nice * magnitude

    # [KEY] _rebinned_histogram
    # Why important: all histogram display modes depend on this rebinner; mistakes distort the plotted distribution.
    # Logic: start from exact 0..255 counts, then distribute each unit-width intensity bucket across the requested bin edges by overlap.
    # Complexity: O(n + 256*b) time | O(b) space
    # Watch out: density mode divides by both total mass and bin width, while cumulative mode sums after rebinning.
    # [DSA] Prefix Sum Preparation - builds exact counts first so later cumulative histograms can use `np.cumsum`
    def _rebinned_histogram(self, values: np.ndarray, bins: int, density: bool, cumulative: bool) -> tuple[np.ndarray, np.ndarray]:
        exact_counts = np.bincount(values.astype(np.uint8), minlength=256).astype(np.float64)
        edges = np.linspace(0.0, 256.0, bins + 1)
        counts = np.zeros(bins, dtype=np.float64)

        for intensity in range(256):
            weight = exact_counts[intensity]
            if weight <= 0.0:
                continue
            source_start = float(intensity)
            source_end = float(intensity + 1)
            start_bin = max(0, np.searchsorted(edges, source_start, side="right") - 1)
            end_bin = min(bins - 1, np.searchsorted(edges, source_end, side="left"))
            for bin_index in range(start_bin, end_bin + 1):
                overlap = min(source_end, edges[bin_index + 1]) - max(source_start, edges[bin_index])
                if overlap > 0.0:
                    counts[bin_index] += weight * overlap

        bin_widths = np.diff(edges)
        if density:
            total = counts.sum()
            if total > 0:
                counts = counts / (total * bin_widths)
        elif not cumulative:
            counts = counts / bin_widths
        if cumulative:
            counts = np.cumsum(counts)
        return counts, edges

    # [KEY] update_plot
    # Why important: this is the histogram window's main renderer; wrong mode logic gives users the wrong distribution view.
    # Logic: choose the active channel mode, rebin and optionally smooth the data series, then redraw the themed Matplotlib axes.
    # Complexity: O(series * (n + 256*b)) time | O(b) space
    # Watch out: RGB overlay draws three separate series, while grayscale-style modes draw exactly one.
    def update_plot(self) -> None:
        self.ax.clear()
        bins = self.bin_spin.value()
        cumulative = self.cumulative_check.isChecked()
        density = self.density_check.isChecked()
        smoothing = self.smooth_slider.value()
        mode = self.mode_combo.currentText()
        y_limit: float | None = None

        def plot_series(values: np.ndarray, color: str, label: str | None = None) -> None:
            nonlocal y_limit
            counts, edges = self._rebinned_histogram(values, bins, density, cumulative)
            counts = self._smooth_counts(counts.astype(np.float64), smoothing)
            if y_limit is None:
                y_limit = self._stable_y_limit(values, density, cumulative)
            if smoothing > 0:
                centers = edges[:-1] + np.diff(edges) / 2.0
                self.ax.plot(centers, counts, color=color, linewidth=1.8, alpha=0.98, label=label)
            else:
                self.ax.stairs(counts, edges, color=color, linewidth=1.6, alpha=0.98, label=label)

        if self.source_image.ndim == 2:
            plot_series(self._gray_values(), "#00f0ff")
        else:
            image = self.source_image[:, :, :3] if self.source_image.shape[2] == 4 else self.source_image
            if mode == "RGB Overlay":
                plot_series(image[:, :, 2].ravel(), "#ff3b3b", "Red")
                plot_series(image[:, :, 1].ravel(), "#39ff88", "Green")
                plot_series(image[:, :, 0].ravel(), "#00f0ff", "Blue")
                self.ax.legend()
            elif mode == "Red":
                plot_series(image[:, :, 2].ravel(), "#ff3b3b")
            elif mode == "Green":
                plot_series(image[:, :, 1].ravel(), "#39ff88")
            elif mode == "Blue":
                plot_series(image[:, :, 0].ravel(), "#00f0ff")
            elif mode == "Luminance":
                plot_series(self._gray_values(), "#ffd60a")
            else:
                plot_series(self._gray_values(), "#8a2be2")

        self.ax.set_xlim(0, 256)
        self.ax.set_yscale("log" if self.log_check.isChecked() else "linear")
        if y_limit is not None and not self.log_check.isChecked():
            self.ax.set_ylim(0, y_limit)
        self._apply_theme()
        self.canvas.draw_idle()

    def toggle_theme(self) -> None:
        self.current_theme = "light" if self.current_theme == "dark" else "dark"
        self.theme_action.setText("Dark Theme" if self.current_theme == "light" else "Light Theme")
        self.update_plot()

    def export_histogram(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Export histogram",
            str(IMAGES_DIR / "histogram_export.png"),
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;TIFF (*.tif *.tiff);;PDF (*.pdf)",
        )
        if not path:
            return
        self.figure.savefig(path, dpi=220, bbox_inches="tight", facecolor=self.figure.get_facecolor())


class MapWindow(QMainWindow):
    def __init__(
        self,
        title: str,
        map_image: np.ndarray,
        legend_items: List[Tuple[str, Tuple[int, int, int]]],
        classification_method: str,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(1200, 820)
        self.figure = Figure(figsize=(12, 8), facecolor="#0a0a0f")
        self.canvas = FigureCanvas(self.figure)

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.addWidget(self.canvas)

        save_button = QPushButton("Save Map")
        save_button.clicked.connect(self.save_map)
        layout.addWidget(save_button, 0, Qt.AlignCenter)
        self.setCentralWidget(central)

        self._draw_map(title, map_image, legend_items, classification_method)

    # [KEY] _draw_map
    # Why important: this composes the final land-cover map and legend shown to the user.
    # Logic: place the rendered map and its legend in a two-column Matplotlib grid, then apply title and method labels.
    # Complexity: O(k) time | O(k) space
    # Watch out: legend colors are normalized to 0..1 floats because Matplotlib patch colors are not byte-based.
    def _draw_map(
        self,
        title: str,
        map_image: np.ndarray,
        legend_items: List[Tuple[str, Tuple[int, int, int]]],
        classification_method: str,
    ) -> None:
        self.figure.clear()
        grid = GridSpec(1, 2, figure=self.figure, width_ratios=[5.9, 1.0], wspace=0.02)
        self.figure.subplots_adjust(left=0.02, right=0.92)
        map_ax = self.figure.add_subplot(grid[0, 0])
        legend_ax = self.figure.add_subplot(grid[0, 1])

        map_ax.imshow(map_image)
        map_ax.axis("off")
        map_ax.set_facecolor("#0a0a0f")
        legend_ax.axis("off")
        legend_ax.set_facecolor("#0a0a0f")
        handles = [
            mpatches.Patch(color=np.array(color, dtype=np.float32) / 255.0, label=name)
            for name, color in legend_items
        ]
        legend = legend_ax.legend(handles=handles, loc="center left", frameon=True, fontsize=9)
        if legend is not None:
            legend.get_frame().set_facecolor("#10131a")
            legend.get_frame().set_edgecolor("#8a2be2")
            legend.get_frame().set_linewidth(1.0)
            for text in legend.get_texts():
                text.set_color("#d8e7f2")

        self.figure.suptitle(title, fontsize=16, fontweight="bold", y=0.98, color="#d8e7f2")
        self.figure.text(
            0.97,
            0.04,
            f"Classification Method: {classification_method}",
            ha="right",
            va="bottom",
            fontsize=9,
            style="italic",
            color="#8fa3bf",
        )
        self.canvas.draw_idle()

    def save_map(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Save map",
            str(IMAGES_DIR / "land_use_map.png"),
            "PNG (*.png);;JPEG (*.jpg *.jpeg)",
        )
        if not path:
            return
        self.figure.savefig(path, dpi=150, bbox_inches="tight")


class ImageViewer(QGraphicsView):
    view_changed = pyqtSignal(object)
    cursor_changed = pyqtSignal(str)
    focus_gained = pyqtSignal(object)
    image_clicked = pyqtSignal(object, int, int)

    def __init__(self, placeholder: str) -> None:
        super().__init__()
        self._scene = QGraphicsScene(self)
        self._pixmap_item = QGraphicsPixmapItem()
        self._scene.addItem(self._pixmap_item)
        self.setScene(self._scene)
        self.setBackgroundBrush(Qt.black)
        self.setAlignment(Qt.AlignCenter)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.NoDrag)
        self.viewport().setAttribute(Qt.WA_AcceptTouchEvents, True)
        self.grabGesture(Qt.PinchGesture)
        self.setMouseTracking(True)
        self.viewport().setMouseTracking(True)
        self.setMinimumSize(780, 650)
        self._placeholder = placeholder
        self._placeholder_label = QLabel(placeholder, self.viewport())
        self._placeholder_label.setAlignment(Qt.AlignCenter)
        self._placeholder_label.setStyleSheet("color: #d1d5db; background: transparent; font-size: 16px;")
        self._placeholder_label.show()
        self._image: np.ndarray | None = None
        self._has_image = False
        self._suspend_sync = False
        self._measurement_items: List[QGraphicsLineItem] = []
        self.setFocusPolicy(Qt.StrongFocus)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._placeholder_label.setGeometry(self.viewport().rect())

    def focusInEvent(self, event) -> None:
        super().focusInEvent(event)
        self.focus_gained.emit(self)

    def enterEvent(self, event) -> None:
        super().enterEvent(event)
        self.focus_gained.emit(self)

    # [KEY] set_image
    # Why important: every load, undo, and result refresh flows through this viewer state update.
    # Logic: clear the scene for `None`, otherwise install a new pixmap, refresh the scene rect, and fit it into view.
    # Complexity: O(r*c) time | O(r*c) space
    # Watch out: measurement overlays must be cleared when a new image replaces the current one.
    def set_image(self, image: np.ndarray | None) -> None:
        self._image = image.copy() if image is not None else None
        if image is None:
            self._pixmap_item.setPixmap(QPixmap())
            self._has_image = False
            self.resetTransform()
            self._placeholder_label.setText(self._placeholder)
            self._placeholder_label.show()
            return
        self._pixmap_item.setPixmap(numpy_to_pixmap(image))
        self._scene.setSceneRect(self._pixmap_item.boundingRect())
        self._has_image = True
        self._placeholder_label.hide()
        self.clear_measurement_overlay()
        self.fit_to_view()

    def fit_to_view(self) -> None:
        if not self._has_image:
            return
        self._suspend_sync = True
        self.resetTransform()
        self.fitInView(self._pixmap_item, Qt.KeepAspectRatio)
        self._suspend_sync = False
        self.view_changed.emit(self)

    def zoom_by(self, factor: float) -> None:
        if not self._has_image:
            return
        self.scale(factor, factor)
        self.view_changed.emit(self)

    def zoom_in(self) -> None:
        self.zoom_by(1.15)

    def zoom_out(self) -> None:
        self.zoom_by(1 / 1.15)

    def set_pan_mode(self) -> None:
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.viewport().setCursor(QCursor(Qt.OpenHandCursor))

    def set_select_mode(self) -> None:
        self.setDragMode(QGraphicsView.NoDrag)
        self.viewport().setCursor(QCursor(Qt.CrossCursor))

    def wheelEvent(self, event) -> None:
        if not self._has_image:
            super().wheelEvent(event)
            return
        self.focus_gained.emit(self)
        delta = event.angleDelta().y()
        if delta == 0 and not event.pixelDelta().isNull():
            delta = event.pixelDelta().y()
        if delta != 0:
            factor = 1.0 + min(abs(delta) / 480.0, 0.35)
            self.zoom_by(factor if delta > 0 else 1.0 / factor)
            event.accept()
            return
        super().wheelEvent(event)

    def event(self, event) -> bool:
        if event.type() == QEvent.Gesture:
            gesture = event.gesture(Qt.PinchGesture)
            if gesture is not None and self._has_image:
                self.focus_gained.emit(self)
                if gesture.changeFlags() & gesture.ScaleFactorChanged:
                    factor = gesture.scaleFactor()
                    if factor > 0:
                        self.zoom_by(factor)
                return True
        return super().event(event)

    def mouseMoveEvent(self, event) -> None:
        super().mouseMoveEvent(event)
        if self._image is None:
            self.cursor_changed.emit("x: -, y: -, value: -")
            return
        point = self.mapToScene(event.pos())
        self.cursor_changed.emit(pixel_text(self._image, int(point.x()), int(point.y())))

    def mousePressEvent(self, event) -> None:
        self.setFocus(Qt.MouseFocusReason)
        self.focus_gained.emit(self)
        super().mousePressEvent(event)
        if self._image is None or event.button() != Qt.LeftButton:
            return
        point = self.mapToScene(event.pos())
        self.image_clicked.emit(self, int(point.x()), int(point.y()))

    def leaveEvent(self, event) -> None:
        super().leaveEvent(event)
        self.cursor_changed.emit("x: -, y: -, value: -")

    def scrollContentsBy(self, dx: int, dy: int) -> None:
        super().scrollContentsBy(dx, dy)
        if self._has_image and not self._suspend_sync:
            self.view_changed.emit(self)

    # [KEY] apply_view_from
    # Why important: synchronized side-by-side inspection depends on both viewers sharing the same transform and scroll offsets.
    # Logic: copy the source transform and scrollbar positions while temporarily suspending feedback signals.
    # Complexity: O(1) time | O(1) space
    # Watch out: `_suspend_sync` prevents an infinite ping-pong of `view_changed` events.
    def apply_view_from(self, other: "ImageViewer") -> None:
        if not self._has_image:
            return
        self._suspend_sync = True
        self.setTransform(other.transform())
        self.horizontalScrollBar().setValue(other.horizontalScrollBar().value())
        self.verticalScrollBar().setValue(other.verticalScrollBar().value())
        self._suspend_sync = False

    def clear_measurement_overlay(self) -> None:
        for item in self._measurement_items:
            self._scene.removeItem(item)
        self._measurement_items.clear()

    def show_measurement_overlay(self, points: List[Tuple[int, int]]) -> None:
        self.clear_measurement_overlay()
        if not points:
            return

        marker_pen = QPen(QColor("#ef4444"))
        marker_pen.setWidth(2)
        marker_pen.setCosmetic(True)

        for x, y in points:
            self._measurement_items.append(self._scene.addLine(x - 8, y, x + 8, y, marker_pen))
            self._measurement_items.append(self._scene.addLine(x, y - 8, x, y + 8, marker_pen))

        if len(points) >= 2:
            line_pen = QPen(QColor("#ef4444"))
            line_pen.setWidth(2)
            line_pen.setStyle(Qt.DotLine)
            line_pen.setCosmetic(True)
            x1, y1 = points[0]
            x2, y2 = points[1]
            self._measurement_items.append(self._scene.addLine(x1, y1, x2, y2, line_pen))


class GeoClusterWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.router = CommandRouter()
        self.ai = AIAssistant()
        self.setWindowTitle("GEOCLUSTER 2.0")
        self.resize(1760, 1020)
        self.original_image: np.ndarray | None = None
        self.result_image: np.ndarray | None = None
        self.current_path = DEFAULT_IMAGE
        self.active_view: ImageViewer | None = None
        self.histogram_windows: List[HistogramWindow] = []
        self.map_windows: List[MapWindow] = []
        self.undo_stack: List[Tuple[np.ndarray | None, str, str]] = []
        self.redo_stack: List[Tuple[np.ndarray | None, str, str]] = []
        self.last_classification: str | None = None
        self.current_labels: np.ndarray | None = None
        self.current_ranges: Dict[int, Tuple[int, int]] = {}
        self.algorithm_ranges: Dict[int, Tuple[int, int]] = {}
        self.last_image_flat: np.ndarray = np.array([], dtype=np.uint8)
        self.cluster_assignments: Dict[int, Dict[str, object]] = {}
        self.classify_dialog: ClassifyClustersDialog | None = None
        self.syncing_views = False
        self.distance_mode = False
        self.distance_source_name = ""
        self.distance_source_image: np.ndarray | None = None
        self.distance_points: List[Tuple[int, int]] = []
        self.distance_unit = "pixels"
        self.distance_pixels_per_unit = 1
        self._build_toolbars()
        self._build_central_ui()
        self._build_run_details_dock()
        # self._build_ai_panel()
        self._build_status_bar()
        self.ai_widget = FloatingAIWidget(self)
        self.ai_panel = AIPanel(self)
        self.ai_widget.move(
            self.width() - 90,
            self.height() - 120,
        )
        self.ai_widget.clicked_signal.connect(
            self.toggle_ai_panel
        )
        self.load_image(DEFAULT_IMAGE)
        self.set_pan_mode()
        self.ai_panel.send_button.clicked.connect(
            self.handle_ai_prompt
        )

        self.ai_panel.chat_input.returnPressed.connect(
            self.handle_ai_prompt
        )
    def resizeEvent(self, event):
        super().resizeEvent(event)
        if hasattr(self, "ai_widget"):
            self.ai_widget.move(
                self.width() - 90,
                self.height() - 120,
            )

    def handle_ai_prompt(self):
        """Handle AI prompt from the chat panel."""
        prompt = self.ai_panel.chat_input.text().strip()
        if not prompt:
            return

        # Add user message
        self.ai_panel.chat_history.append(f"<b>You:</b> {prompt}")
        self.ai_panel.chat_input.clear()
        self.ai_panel.chat_history.append("<b>AI:</b> Thinking...")
        QApplication.processEvents()

        try:
            # Route the command
            result = self.router.route(prompt)

            print("\n========== ROUTER ==========")
            print(result)
            print("============================\n")

            intent = result.get("intent")

            # Remove "Thinking..." message
            cursor = self.ai_panel.chat_history.textCursor()
            cursor.movePosition(cursor.End)
            cursor.select(cursor.BlockUnderCursor)
            cursor.removeSelectedText()
            cursor.deletePreviousChar()

            # Handle different intents
            if intent == "fetch_satellite":
                location = result.get("location")
                self.ai_panel.chat_history.append(
                    f"<b>AI:</b> 📡 Fetching Sentinel-2 imagery for '{location}'..."
                )
                QApplication.processEvents()

                try:
                    from frontend.sentinel_client import fetch_sector_image

                    image_path = fetch_sector_image(location)

                    print(image_path)      # optional, for debugging

                    self.load_image(Path(image_path))
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Loaded imagery for {location}."
                    )
                except Exception as e:
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ❌ Failed to fetch {location}: {str(e)}"
                    )

            elif intent == "process_image":
                operation = result.get("operation")
                self.ai_panel.chat_history.append(
                    f"<b>AI:</b> 🔄 Applying {operation}..."
                )
                QApplication.processEvents()

                # Execute the operation
                if operation == "kmeans":
                    self.execute_operation("kmeans")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Applied K-Means clustering."
                    )
                elif operation == "meanfilter":
                    self.execute_operation("meanfilter")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Applied Mean Filter."
                    )
                elif operation == "threshold":
                    self.execute_operation("threshold")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Applied Threshold."
                    )
                elif operation == "brightness":
                    self.execute_operation("brightness")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Adjusted Brightness."
                    )
                elif operation == "negative":
                    self.execute_operation("negative")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Applied Negative."
                    )
                elif operation == "histogram":
                    self.execute_operation("histogram")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Generated Histogram."
                    )
                elif operation == "compress":
                    self.execute_operation("compress")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Compressed Image."
                    )
                elif operation == "distance":
                    self.execute_operation("distance")
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ✅ Measured Distance."
                    )
                else:
                    self.ai_panel.chat_history.append(
                        f"<b>AI:</b> ❌ Unknown operation: {operation}"
                    )

            elif intent == "ask_question":
                # Send to AI
                answer = self.ai.ask(result.get("question"))
                self.ai_panel.chat_history.append(f"<b>AI:</b> {answer}")

            else:
                # General - send to AI
                answer = self.ai.ask(prompt)
                self.ai_panel.chat_history.append(f"<b>AI:</b> {answer}")

        except Exception as e:
            self.ai_panel.chat_history.append(
                f"<font color='red'>Error: {str(e)}</font>"
            )

    def toggle_ai_panel(self):
        print("AI button clicked")

        if self.ai_panel.isVisible():
            self.ai_panel.hide()
            return

        x = self.ai_widget.x() - self.ai_panel.width() - 15
        y = self.ai_widget.y() - self.ai_panel.height() + 60

        if x < 10:
            x = self.ai_widget.x() + self.ai_widget.width() + 15

        if y < 10:
            y = 10

        self.ai_panel.move(x, y)
        self.ai_panel.show()
        self.ai_panel.raise_()

    def _build_toolbars(self) -> None:
        processing_toolbar = QToolBar("Processing Tools", self)
        processing_toolbar.setMovable(False)
        self.addToolBar(Qt.TopToolBarArea, processing_toolbar)
        tool_btn_style = """
QToolButton {
    color: #d8e7f2;
    background-color: #11131a;
    border: 1px solid #22263a;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12pt;
}
QToolButton::menu-indicator {
    subcontrol-origin: padding;
    subcontrol-position: right center;
    width: 18px;
}
QToolButton:hover {
    background-color: #121826;
    border: 1px solid #00f0ff;
    color: #f5fbff;
}
QToolButton:pressed {
    background-color: #1a1430;
    border: 1px solid #ff00ff;
    color: #f5fbff;
}
QMenu {
    background-color: #11131a;
    color: #d8e7f2;
    border: 1px solid #22263a;
    padding: 6px;
}
QMenu::item {
    padding: 8px 24px;
    border-radius: 4px;
    font-size: 12pt;
}
QMenu::item:selected {
    background-color: #18152a;
    border: 1px solid #8a2be2;
    color: #f5fbff;
}
QMenu::item:disabled {
    color: #6d7689;
}
QMenu::separator {
    height: 1px;
    background: #22263a;
    margin: 4px 0px;
}
"""

        file_menu = QMenu(self)
        file_menu.addAction("Load Image", self.pick_image)
        file_menu.addAction("Save Result", self.save_result)

        file_btn = QToolButton()
        file_btn.setMenu(file_menu)
        file_btn.setPopupMode(QToolButton.InstantPopup)
        file_btn.setStyleSheet(tool_btn_style)
        file_btn.setText("File")
        processing_toolbar.addWidget(file_btn)

        satellite_menu = QMenu(self)
        satellite_menu.addAction(
            "Fetch Sentinel-2 Image",
            self.fetch_satellite_image,
        )

        satellite_btn = QToolButton()
        satellite_btn.setMenu(satellite_menu)
        satellite_btn.setPopupMode(QToolButton.InstantPopup)
        satellite_btn.setStyleSheet(tool_btn_style)
        satellite_btn.setText("Satellite")
        processing_toolbar.addWidget(satellite_btn)

        spatial_menu = QMenu(self)
        spatial_menu.addAction("Grayscale", self.apply_grayscale)
        spatial_menu.addAction("Negative", self.apply_negative)
        spatial_menu.addAction("Mean Filter", self.apply_mean_filter)
        spatial_menu.addAction("Laplacian", self.apply_laplacian)
        spatial_btn = QToolButton()
        spatial_btn.setText("Spatial Filters â–¾")
        spatial_btn.setMenu(spatial_menu)
        spatial_btn.setPopupMode(QToolButton.InstantPopup)
        spatial_btn.setStyleSheet(tool_btn_style)
        spatial_btn.setText("Spatial Filters")
        processing_toolbar.addWidget(spatial_btn)

        radio_menu = QMenu(self)
        radio_menu.addAction("Brightness", self.apply_brightness)
        radio_menu.addAction("Threshold", self.apply_threshold)
        radio_btn = QToolButton()
        radio_btn.setText("Radiometric Enhancement â–¾")
        radio_btn.setMenu(radio_menu)
        radio_btn.setPopupMode(QToolButton.InstantPopup)
        radio_btn.setStyleSheet(tool_btn_style)
        radio_btn.setText("Radiometric Enhancement")
        processing_toolbar.addWidget(radio_btn)

        cluster_menu = QMenu(self)
        cluster_menu.addAction("K-Means Clustering", self.run_kmeans)
        cluster_menu.addSeparator()
        self.classify_action = cluster_menu.addAction("Classify Clusters", self.open_classify_dialog)
        self.generate_map_action = cluster_menu.addAction("Generate Map", self.generate_map)
        self.classify_action.setEnabled(False)
        self.generate_map_action.setEnabled(False)
        cluster_btn = QToolButton()
        cluster_btn.setText("Clustering â–¾")
        cluster_btn.setMenu(cluster_menu)
        cluster_btn.setPopupMode(QToolButton.InstantPopup)
        cluster_btn.setStyleSheet(tool_btn_style)
        cluster_btn.setText("Clustering")
        processing_toolbar.addWidget(cluster_btn)

        meta_menu = QMenu(self)
        meta_menu.addAction("Statistics", self.show_statistics)
        meta_menu.addAction("Histogram", self.show_histogram)
        meta_btn = QToolButton()
        meta_btn.setText("Metadata â–¾")
        meta_btn.setMenu(meta_menu)
        meta_btn.setPopupMode(QToolButton.InstantPopup)
        meta_btn.setStyleSheet(tool_btn_style)
        meta_btn.setText("Metadata")
        processing_toolbar.addWidget(meta_btn)

        huffman_menu = QMenu(self)
        huffman_menu.addAction("Huffman Compress", self.huffman_compress)
        huffman_menu.addAction("Huffman Decompress", self.huffman_decompress)
        huffman_btn = QToolButton()
        huffman_btn.setText("Huffman â–¾")
        huffman_btn.setMenu(huffman_menu)
        huffman_btn.setPopupMode(QToolButton.InstantPopup)
        huffman_btn.setStyleSheet(tool_btn_style)
        huffman_btn.setText("Huffman")
        processing_toolbar.addWidget(huffman_btn)

        processing_toolbar.addSeparator()

        distance_action = QAction("Distance Tool", self)
        distance_action.setCheckable(True)
        distance_action.toggled.connect(self.toggle_distance_tool)
        processing_toolbar.addAction(distance_action)

        navigation_toolbar = QToolBar("Navigation", self)
        navigation_toolbar.setMovable(False)
        self.addToolBar(Qt.TopToolBarArea, navigation_toolbar)

        zoom_in_action = QAction("Zoom In", self)
        zoom_in_action.triggered.connect(self.zoom_in_active)
        navigation_toolbar.addAction(zoom_in_action)

        zoom_out_action = QAction("Zoom Out", self)
        zoom_out_action.triggered.connect(self.zoom_out_active)
        navigation_toolbar.addAction(zoom_out_action)

        fit_action = QAction("Fit", self)
        fit_action.triggered.connect(self.fit_views)
        navigation_toolbar.addAction(fit_action)

        pan_action = QAction("Pan", self)
        pan_action.setCheckable(True)
        pan_action.setChecked(True)
        pan_action.triggered.connect(self.set_pan_mode)
        navigation_toolbar.addAction(pan_action)

        self.pan_action = pan_action
        self.select_action = None
        self.distance_action = distance_action
        self.classify_clusters_action = self.classify_action

    def _build_central_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(10)

        self.path_label = QLabel(str(DEFAULT_IMAGE))
        self.path_label.setWordWrap(True)
        self.path_label.setStyleSheet("padding: 8px 10px; background: #111827; border: 1px solid #374151; border-radius: 6px;")
        layout.addWidget(self.path_label)

        previews = QHBoxLayout()
        previews.setSpacing(10)

        original_group = QGroupBox("Original Image")
        original_layout = QVBoxLayout(original_group)
        self.original_view = ImageViewer("Load an image to view the original scene.")
        original_layout.addWidget(self.original_view)

        result_group = QGroupBox("Output Image")
        result_layout = QVBoxLayout(result_group)
        self.result_view = ImageViewer("Run a processing tool to see the result.")
        result_layout.addWidget(self.result_view)

        previews.addWidget(original_group, 1)
        previews.addWidget(result_group, 1)
        layout.addLayout(previews, 1)

        footer = QHBoxLayout()
        footer.setSpacing(10)
        footer.addStretch(1)

        self.undo_button = QPushButton()
        self.undo_button.setIcon(self.style().standardIcon(QStyle.SP_ArrowBack))
        self.undo_button.setToolTip("Undo")
        self.undo_button.clicked.connect(self.undo_last_operation)
        footer.addWidget(self.undo_button, 0, Qt.AlignRight)

        self.redo_button = QPushButton()
        self.redo_button.setIcon(self.style().standardIcon(QStyle.SP_ArrowForward))
        self.redo_button.setToolTip("Redo")
        self.redo_button.clicked.connect(self.redo_last_operation)
        footer.addWidget(self.redo_button, 0, Qt.AlignRight)

        self.run_details_button = QPushButton("Run Details")
        self.run_details_button.clicked.connect(self.toggle_run_details)
        footer.addWidget(self.run_details_button, 0, Qt.AlignRight)
        layout.addLayout(footer)

        self.original_view.view_changed.connect(self._sync_views)
        self.result_view.view_changed.connect(self._sync_views)
        self.original_view.cursor_changed.connect(self.update_cursor_status)
        self.result_view.cursor_changed.connect(self.update_cursor_status)
        self.original_view.focus_gained.connect(self._set_active_view)
        self.result_view.focus_gained.connect(self._set_active_view)
        self.original_view.image_clicked.connect(self._handle_image_click)
        self.result_view.image_clicked.connect(self._handle_image_click)

    def _build_run_details_dock(self) -> None:
        self.run_details_dock = QDockWidget("Run Details", self)
        self.run_details_dock.setAllowedAreas(Qt.BottomDockWidgetArea)
        self.run_details_dock.setFeatures(QDockWidget.DockWidgetClosable)
        self.meta_box = QTextEdit()
        self.meta_box.setReadOnly(True)
        self.run_details_dock.setWidget(self.meta_box)
        self.addDockWidget(Qt.BottomDockWidgetArea, self.run_details_dock)
        self.run_details_dock.hide()
        self.run_details_dock.visibilityChanged.connect(self._sync_run_details_button)

    def _build_status_bar(self) -> None:
        status = QStatusBar()
        self.setStatusBar(status)
        self.status_label = QLabel("Ready.")
        self.status_label.setMinimumWidth(420)
        status.addWidget(self.status_label, 1)
        self.progress_bar = QProgressBar()
        self.progress_bar.setFixedWidth(220)
        self.progress_bar.setVisible(False)
        status.addPermanentWidget(self.progress_bar)
        self.cursor_label = QLabel("x: -, y: -, value: -")
        self.cursor_label.setMinimumWidth(300)
        status.addPermanentWidget(self.cursor_label)
    def _build_ai_panel(self):

        dock = QDockWidget("AI Assistant", self)
        dock.setAllowedAreas(
            Qt.RightDockWidgetArea
        )

        container = QWidget()

        layout = QVBoxLayout(container)

        self.chat_history = QTextEdit()
        self.chat_history.setReadOnly(True)

        self.chat_input = QLineEdit()
        self.chat_input.setPlaceholderText(
            "Ask GEOCLUSTER..."
        )

        send_btn = QPushButton("Send")

        send_btn.clicked.connect(
            self.handle_ai_prompt
        )
 
        self.chat_input.returnPressed.connect(
            self.handle_ai_prompt
        )

        layout.addWidget(self.chat_history)
        layout.addWidget(self.chat_input)
        layout.addWidget(send_btn)

        dock.setWidget(container)

        self.addDockWidget(
            Qt.RightDockWidgetArea,
            dock,
        )
    def _sync_run_details_button(self, visible: bool) -> None:
        self.run_details_button.setText("Hide Run Details" if visible else "Run Details")

    def toggle_run_details(self) -> None:
        if self.run_details_dock.isVisible():
            self.run_details_dock.hide()
        else:
            self.run_details_dock.show()
            self.run_details_dock.raise_()

    def _set_active_view(self, viewer: ImageViewer) -> None:
        self.active_view = viewer

    def update_cursor_status(self, text: str) -> None:
        self.cursor_label.setText(text)

    def _clear_distance_overlay(self) -> None:
        self.original_view.clear_measurement_overlay()
        self.result_view.clear_measurement_overlay()

    def _update_distance_overlay(self) -> None:
        self._clear_distance_overlay()
        if not self.distance_mode or not self.distance_source_name:
            return
        target_view = self.original_view if self.distance_source_name == "Original Image" else self.result_view
        target_view.show_measurement_overlay(self.distance_points)

    def _sync_views(self, source: ImageViewer) -> None:
        if self.syncing_views:
            return
        self.syncing_views = True
        target = self.result_view if source is self.original_view else self.original_view
        target.apply_view_from(source)
        self.syncing_views = False

    def pick_image(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "Choose an input image",
            str(self.current_path.parent if self.current_path else PROJECT_ROOT),
            (
                "All Supported Images ("
                "*.jpg *.jpeg *.png *.bmp *.tif *.tiff "
                "*.jp2 *.img *.vrt *.ecw *.sid *.hdr "
                "*.ppm *.pgm *.pbm *.webp *.ico "
                "*.raw *.dat);;"
                "JPEG (*.jpg *.jpeg);;"
                "PNG (*.png);;"
                "TIFF (*.tif *.tiff);;"
                "JPEG2000 (*.jp2);;"
                "ERDAS IMAGINE (*.img);;"
                "BMP (*.bmp);;"
                "All Files (*.*)"
            ),
        )
        if path:
            self.load_image(Path(path))

    def fetch_satellite_image(self) -> None:
        """
        Downloads Sentinel-2 imagery for an Islamabad sector.
        If the image already exists in the cache,
        it is loaded immediately instead of downloading again.
        """

        location, ok = QInputDialog.getText(
            self,
            "Fetch Sentinel-2",
            "Enter sector or place name (Example: F-8, Centaurus, NUST):",
        )

        if not ok or not location.strip():
            return

        try:
            bbox = get_sector_bbox(location)

            cache_dir = PROJECT_ROOT / "data" / "cache"
            cache_dir.mkdir(parents=True, exist_ok=True)

            filename = (
                location.strip()
                .upper()
                .replace(" ", "_")
                .replace("-", "_")
                + ".png"
            )

            output_path = cache_dir / filename

            # ----------------------------
            # Use cached image if available
            # ----------------------------
            if output_path.exists():
                QMessageBox.information(
                    self,
                    "Cache",
                    f"Loaded cached image:\n{filename}",
                )

                self.load_image(output_path)
                return

            # ----------------------------
            # Otherwise download it
            # ----------------------------
            fetch_sentinel_image(
                bbox=bbox,
                output_path=str(output_path),
            )

            QMessageBox.information(
                self,
                "Download Complete",
                f"Downloaded and cached:\n{filename}",
            )

            self.load_image(output_path)

        except Exception as e:
            QMessageBox.critical(
                self,
                "Satellite Fetch Error",
                str(e),
            )


    # [KEY] load_image
    # Why important: this initializes the processing session; if image loading or reset logic is wrong, later operations act on stale state.
    # Logic: safely load large or normal images, normalize channel layout, then reset history, clustering state, and viewer widgets.
    # Complexity: O(r*c) time | O(r*c) space
    # Watch out: large images may be resized through Pillow first to keep the UI responsive.
    def load_image(self, path: Path | str) -> None:
        path = Path(path)
        loaded = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
        if loaded is None:
            QMessageBox.critical(
                self,
                "Image Load Error",
                f"Could not load image:\n{path}",
            )
            return

        self.current_path = path
        self.original_image = loaded
        self.result_image = None
        self.undo_stack.clear()
        self.redo_stack.clear()
        self.last_classification = None
        self.current_labels = None
        self.current_ranges = {}
        self.algorithm_ranges = {}
        self.last_image_flat = np.array([], dtype=np.uint8)
        self.cluster_assignments = {}
        self.generate_map_action.setEnabled(False)
        self.classify_clusters_action.setEnabled(False)
        self.path_label.setText(str(path))
        self.original_view.set_image(loaded)
        self.result_view.set_image(None)
        self.meta_box.clear()
        self.status_label.setText(f"Loaded {path.name} | Resolution: {loaded.shape[1]} x {loaded.shape[0]}")
        self.cursor_label.setText("x: -, y: -, value: -")
        self.active_view = self.original_view

    def _snapshot_state(self) -> Tuple[np.ndarray | None, str, str]:
        image = None if self.result_image is None else self.result_image.copy()
        return image, self.meta_box.toPlainText(), self.status_label.text()

    def _apply_history_state(self, state: Tuple[np.ndarray | None, str, str]) -> None:
        image, details, status = state
        self.result_image = None if image is None else image.copy()
        self.result_view.set_image(self.result_image)
        self.meta_box.setPlainText(details)
        self.status_label.setText(status)

    def _push_undo_state(self) -> None:
        self.undo_stack.append(self._snapshot_state())
        self.redo_stack.clear()

    def undo_last_operation(self) -> None:
        if not self.undo_stack:
            return
        self.redo_stack.append(self._snapshot_state())
        self._apply_history_state(self.undo_stack.pop())

    def redo_last_operation(self) -> None:
        if not self.redo_stack:
            return
        self.undo_stack.append(self._snapshot_state())
        self._apply_history_state(self.redo_stack.pop())

    # [KEY] generate_map
    # Why important: this produces the final land-cover deliverable users care about.
    # Logic: derive a display image and legend percentages from the latest classification state, then open a dedicated map window.
    # Complexity: O(k*n) time | O(n + k) space
    # Watch out: percentage labels are computed from `last_image_flat`, so ranges must already match the active classification.
    # [DSA] Range Counting - computes legend percentages by counting pixels that fall inside each cluster interval
    def generate_map(self) -> None:
        if self.last_classification is None or not self.current_ranges:
            return
        title_input, ok = QInputDialog.getText(self, "Generate Map", 'Enter map title (e.g. "IGIS Campus"):')
        if not ok or not title_input.strip():
            return
        assignments = self.cluster_assignments or default_cluster_assignments(self.last_classification, sorted(self.current_ranges))
        if self.result_image is not None and self.result_image.ndim == 3:
            rgb_map = cv2.cvtColor(self.result_image, cv2.COLOR_BGR2RGB)
        elif self.current_labels is not None:
            rgb_map = build_cluster_map_image(self.current_labels, assignments)
        else:
            return
        total_pixels = len(self.last_image_flat)
        legend_items = []
        for cluster in sorted(assignments):
            name = str(assignments[cluster]["name"])
            color = tuple(assignments[cluster]["color"])
            min_val, max_val = self.current_ranges[cluster]
            count = int(np.sum((self.last_image_flat >= min_val) & (self.last_image_flat <= max_val))) if total_pixels else 0
            percentage = (count / total_pixels * 100.0) if total_pixels else 0.0
            legend_items.append((f"{name}-{percentage:.1f}%", color))

        display_title = f'Land Cover Map of "{title_input.strip()}"'
        method_text = f"{self.last_classification} Clustering"
        window = MapWindow(display_title, rgb_map, legend_items, method_text, self)
        window.show()
        self.map_windows.append(window)
        self.status_label.setText("Map generated successfully")

    # [KEY] _load_cluster_backend_result
    # Why important: this bridges raw backend files into the frontend's live clustering state.
    # Logic: read labels/ranges/centroids from disk, build the colorized preview image, and cache everything needed for editing or map export.
    # Complexity: O(n + k log k) time | O(n + k) space
    # Watch out: single-row label files arrive as 1D arrays from NumPy and must be reshaped back to 2D.
    def _load_cluster_backend_result(self, method: str) -> np.ndarray:
        labels = np.loadtxt(OUTPUT_CSV, delimiter=",").astype(int)
        if labels.ndim == 1:
            labels = labels.reshape(1, -1)
        ranges = read_ranges(RANGES_TXT)
        assignments = default_cluster_assignments(method, sorted(ranges))
        centroids = read_centroids(CENTROIDS_TXT)
        gray = to_grayscale(self.original_image) if self.original_image is not None else np.zeros(labels.shape, dtype=np.uint8)
        display_img = build_cluster_display_image(labels, centroids, assignments)
        self.current_labels = labels
        self.algorithm_ranges = dict(sorted(ranges.items()))
        if len(ranges) == 6:
            self.current_ranges = default_cluster_ranges(sorted(ranges))
        else:
            self.current_ranges = default_cluster_ranges(sorted(ranges))
        self.last_image_flat = gray.flatten()
        self.cluster_assignments = assignments
        self.last_classification = method
        self.classify_clusters_action.setEnabled(True)
        self.generate_map_action.setEnabled(True)
        return display_img

    # [KEY] apply_cluster_assignments
    # Why important: manual relabeling changes the visible classification result without rerunning k-means.
    # Logic: rebuild a color display image by masking grayscale pixels against each configured interval and painting the chosen color.
    # Complexity: O(k*n) time | O(n) space
    # Watch out: the displayed colors are written in BGR order because OpenCV/Qt image data is stored that way here.
    # [DSA] Masked Assignment - recolors all pixels in each interval using vectorized Boolean masks
    def apply_cluster_assignments(self, ranges: Dict[int, Tuple[int, int]], assignments: Dict[int, Dict[str, object]]) -> None:
        if self.current_labels is None or not self.current_ranges or self.original_image is None:
            return
        self.current_ranges = dict(sorted(ranges.items()))
        self.cluster_assignments = {
            k: {"name": str(v["name"]), "color": tuple(v["color"])} for k, v in assignments.items()
        }
        gray = to_grayscale(self.original_image)
        display_img = np.zeros((gray.shape[0], gray.shape[1], 3), dtype=np.uint8)
        for k, (min_val, max_val) in self.current_ranges.items():
            color = tuple(int(c) for c in self.cluster_assignments[k]["color"])
            mask = (gray >= min_val) & (gray <= max_val)
            display_img[mask] = (color[2], color[1], color[0])
        self.result_image = display_img
        self.result_view.set_image(self.result_image)
        self.status_label.setText(f"Classification applied | {len(self.cluster_assignments)} clusters labeled")

    def reset_cluster_assignments(self) -> Tuple[Dict[int, Tuple[int, int]], Dict[int, Dict[str, object]]]:
        if len(self.algorithm_ranges) == 6:
            self.current_ranges = default_cluster_ranges(sorted(self.algorithm_ranges))
        else:
            self.current_ranges = default_cluster_ranges(sorted(self.current_ranges))
        self.cluster_assignments = default_cluster_assignments(self.last_classification or "K-Means", sorted(self.current_ranges))
        self.apply_cluster_assignments(self.current_ranges, self.cluster_assignments)
        self.result_view.set_image(self.result_image)
        return self.current_ranges, self.cluster_assignments

    # [KEY] rerun_cluster_algorithm
    # Why important: edited intervals only take effect permanently after this reclassification pass updates backend outputs.
    # Logic: serialize the current ranges, run backend k-means again, then reload the generated labels and preview image.
    # Complexity: O(backend k-means work) time | O(image size) space
    # Watch out: this preserves the user's label/color assignments while refreshing only the algorithmic cluster boundaries.
    def rerun_cluster_algorithm(self, ranges: Dict[int, Tuple[int, int]], assignments: Dict[int, Dict[str, object]]) -> None:
        if self.original_image is None or self.last_classification is None:
            return
        self.current_ranges = dict(sorted(ranges.items()))
        self.cluster_assignments = assignments
        params = {
            "operation": "kmeans",
            "K": len(self.current_ranges),
            "ranges": ranges_to_string([self.current_ranges[k] for k in sorted(self.current_ranges)]),
        }
        self.status_label.setText("Running K-Means... please wait")
        QApplication.processEvents()
        started = time.perf_counter()
        output = self._run_backend_operation(params, source_image=self.original_image)
        elapsed = time.perf_counter() - started
        if output is None:
            return
        self.result_image = self._load_cluster_backend_result(self.last_classification)
        self.result_view.set_image(self.result_image)
        self.status_label.setText(f"K-Means complete | K={len(self.current_ranges)} clusters | {elapsed:.1f}s")

    def open_classify_clusters_dialog(self) -> None:
        if not self.current_ranges:
            return
        self.classify_dialog = ClassifyClustersDialog(
            self.current_ranges,
            self.cluster_assignments or default_cluster_assignments(self.last_classification or "K-Means", sorted(self.current_ranges)),
            self.last_image_flat,
            self.apply_cluster_assignments,
            self.reset_cluster_assignments,
            self.rerun_cluster_algorithm,
            self.generate_map,
            self,
        )
        self.classify_dialog.show()

    def _write_run_details(self, title: str, log_text: str, metadata: Dict[str, str] | None = None) -> None:
        lines = [title, ""]
        if log_text.strip():
            lines.append("Log:")
            lines.extend(log_text.strip().splitlines())
            lines.append("")
        if metadata:
            lines.append("Metadata:")
            for key, value in metadata.items():
                lines.append(f"{key}: {value}")
        self.meta_box.setPlainText("\n".join(lines))

    def _source_image_for_backend(self) -> np.ndarray | None:
        if self.original_image is not None:
            return self.original_image
        return self.result_image

    # [KEY] _run_backend_operation
    # Why important: every backend-powered tool funnels through this direct Python dispatcher.
    # Logic: prepare grayscale input, call the Python backend functions directly, capture logs/metadata, and return the output.
    # Complexity: O(image size + selected operation work) time | O(image size) space
    # Watch out: distance mode and Huffman decompression are special cases that do not require a source image.
    def _run_backend_operation(self, params: Dict[str, str | int], source_image: np.ndarray | None = None) -> np.ndarray | None:
        image = source_image if source_image is not None else self._source_image_for_backend()
        operation = str(params.get("operation", ""))
        if image is None and operation not in {"distance", "huffman_decompress"}:
            return None

        grayscale = None if operation in {"distance", "huffman_decompress"} else to_grayscale(image)
        write_params(PARAMS_TXT, params)
        self.progress_bar.setVisible(True)
        self.progress_bar.setRange(0, 0)
        QApplication.processEvents()
        try:
            output, log_text, metadata = process_operation(
                grayscale,
                params,
                CENTROIDS_TXT,
                RANGES_TXT,
                META_TXT,
                HUFFMAN_BIN,
                OUTPUT_CSV,
            )
        except Exception as exc:
            self.progress_bar.setVisible(False)
            self.progress_bar.setRange(0, 100)
            self.progress_bar.setValue(0)
            QMessageBox.critical(self, "Backend Error", str(exc))
            return None
        self.progress_bar.setVisible(False)
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)

        self._write_run_details(f"Run Details - {params['operation']}", log_text, metadata)
        if operation == "distance":
            return None
        return output if output is not None else read_csv_matrix(OUTPUT_CSV)

    # [KEY] _handle_image_click
    # Why important: distance measurement depends on collecting exactly two valid points from one consistent image source.
    # Logic: track the active source view, reset mismatched selections, store up to two points, and finish measurement on the second click.
    # Complexity: O(1) time | O(1) space
    # Watch out: switching from original to output view mid-measurement clears the previous point to avoid mixed-coordinate distances.
    def _handle_image_click(self, viewer: ImageViewer, x: int, y: int) -> None:
        if not self.distance_mode:
            return

        image = self.original_image if viewer is self.original_view else self.result_image
        source_name = "Original Image" if viewer is self.original_view else "Output Image"
        if image is None or x < 0 or y < 0 or y >= image.shape[0] or x >= image.shape[1]:
            return

        if not self.distance_points:
            self.distance_source_name = source_name
            self.distance_source_image = image
        elif source_name != self.distance_source_name:
            QMessageBox.information(self, "Distance Tool", "Pick both points on the same image view.")
            self.distance_points = []
            self.distance_source_name = source_name
            self.distance_source_image = image
            self._update_distance_overlay()

        if len(self.distance_points) >= 2:
            self.distance_points = []
            self._update_distance_overlay()

        self.distance_points.append((x, y))
        self._update_distance_overlay()
        if len(self.distance_points) == 1:
            self.status_label.setText(f"{self.distance_source_name} | First point selected at ({x}, {y}). Pick the second point.")
            return

        self._finish_distance_measurement()

    def toggle_distance_tool(self, checked: bool) -> None:
        if checked:
            self.start_distance_tool()
        else:
            self.stop_distance_tool()

    def start_distance_tool(self) -> None:
        if self.original_image is None and self.result_image is None:
            self.distance_action.setChecked(False)
            QMessageBox.information(self, "No Image", "Load an image before using the distance tool.")
            return
        self.distance_mode = True
        self.distance_source_name = ""
        self.distance_source_image = None
        self.distance_points = []
        self._clear_distance_overlay()
        self.set_select_mode()
        QMessageBox.information(
            self,
            "Distance Tool",
            "Select two points on the same image view. You can still zoom while measuring.",
        )
        self.status_label.setText("Distance tool active | Select the first point.")

    def stop_distance_tool(self) -> None:
        self.distance_mode = False
        self.distance_source_name = ""
        self.distance_source_image = None
        self.distance_points = []
        self._clear_distance_overlay()
        self.set_pan_mode()

    # [KEY] _finish_distance_measurement
    # Why important: this converts two clicked points into the final user-visible distance result.
    # Logic: delegate Euclidean distance computation to the backend, read the metadata result, then optionally convert pixels into user units.
    # Complexity: O(1) time | O(1) space
    # Watch out: canceling the unit dialog leaves the current measurement points in place but skips the result popup.
    def _finish_distance_measurement(self) -> None:
        if len(self.distance_points) < 2:
            return
        x1, y1 = self.distance_points[0]
        x2, y2 = self.distance_points[1]
        self._run_backend_operation(
            {
                "operation": "distance",
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
            },
            source_image=self.distance_source_image,
        )
        metadata = parse_metadata(META_TXT)
        distance_value = metadata.get("distance", "")
        if not distance_value:
            self.distance_action.setChecked(False)
            return
        pixel_distance = float(distance_value)
        unit_dialog = DistanceUnitDialog(pixel_distance, self)
        if unit_dialog.exec_() != QDialog.Accepted:
            return

        unit = unit_dialog.unit
        pixels_per_unit = 1 if unit == "pixels" else unit_dialog.pixels_per_unit
        display_distance = pixel_distance if unit == "pixels" else pixel_distance / float(pixels_per_unit)
        self.distance_unit = unit
        self.distance_pixels_per_unit = pixels_per_unit
        message = (
            f"Source: {self.distance_source_name}\n"
            f"Point 1: ({x1}, {y1})\n"
            f"Point 2: ({x2}, {y2})\n"
            f"Distance: {display_distance:.3f} {unit}\n"
            f"Pixel Distance: {pixel_distance:.3f} pixels"
        )
        QMessageBox.information(self, "Distance Result", message)
        self.status_label.setText(
            f"{self.distance_source_name} | Distance = {display_distance:.3f} {unit} | Click a new first point to measure again"
        )

    def run_huffman_compress(self) -> None:
        if self.original_image is None:
            QMessageBox.information(self, "No Image", "Load an image before compression.")
            return
        save_path, _ = QFileDialog.getSaveFileName(
            self,
            "Save compressed file",
            str(DATA_DIR / "compressed_image.gch"),
            "GeoCluster Huffman (*.gch)",
        )
        if not save_path:
            return
        metadata = compress_color_image_huffman(self.original_image, Path(save_path))
        self._write_run_details("Run Details - huffman_compress", "Handled in Python on the original loaded image.", metadata)
        self.status_label.setText(f"Original Image | Huffman compressed to {Path(save_path).name}")

    def run_huffman_decompress(self) -> None:
        input_path, _ = QFileDialog.getOpenFileName(
            self,
            "Select compressed file",
            str(DATA_DIR),
            "GeoCluster Huffman (*.gch)",
        )
        if not input_path:
            return
        output_path, _ = QFileDialog.getSaveFileName(
            self,
            "Save decompressed image",
            str(IMAGES_DIR / "decompressed_image.png"),
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;Bitmap (*.bmp)",
        )
        if not output_path:
            return
        image, metadata = decompress_color_image_huffman(Path(input_path))
        self._push_undo_state()
        self.result_image = image
        self.result_view.set_image(image)
        cv2.imwrite(output_path, image)
        metadata["saved_image"] = output_path
        self._write_run_details("Run Details - huffman_decompress", "Handled in Python on the saved compressed image.", metadata)
        self.status_label.setText(f"{Path(input_path).name} | Decompressed to {Path(output_path).name}")

    # [KEY] execute_operation
    # Why important: this is the frontend dispatcher for every processing action.
    # Logic: handle pure-Python operations directly, gather any user parameters, and fall back to `_run_backend_operation` for backend tasks.
    # Complexity: O(work of chosen operation) time | O(image size) space
    # Watch out: some operations push undo state before computing output, while histogram/statistics only inspect data and do not mutate state.
    def execute_operation(self, operation: str) -> None:
        if self.original_image is None:
            QMessageBox.information(self, "No Image", "Load an image before running a processing tool.")
            return

        if operation == "grayscale":
            self._push_undo_state()
            self.result_image = to_grayscale(self.original_image)
            self.result_view.set_image(self.result_image)
            self._write_run_details("Run Details - grayscale", "Handled in Python using OpenCV grayscale conversion.")
            self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | Grayscale complete")
            return

        if operation == "negative":
            self._push_undo_state()
            output = self.original_image.copy()
            if output.ndim == 2:
                output = cv2.bitwise_not(output)
            elif output.shape[2] == 4:
                output[:, :, :3] = cv2.bitwise_not(output[:, :, :3])
            else:
                output = cv2.bitwise_not(output)
            self.result_image = output
            self.result_view.set_image(output)
            self._write_run_details("Run Details - negative", "Handled in Python on the original image.")
            self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | Negative complete")
            return

        if operation == "laplacian":
            self._push_undo_state()
            gray = to_grayscale(self.original_image)
            output = cv2.convertScaleAbs(cv2.Laplacian(gray, cv2.CV_64F))
            self.result_image = output
            self.result_view.set_image(output)
            self._write_run_details("Run Details - laplacian", "Handled in Python on the original image using cv2.Laplacian.")
            self.status_label.setText("Laplacian complete")
            return

        if operation == "statistics":
            QApplication.beep()
            dialog = StatisticsTargetDialog(has_output=self.result_image is not None, parent=self)
            if dialog.exec_() != QDialog.Accepted:
                return
            if dialog.selection == "output":
                image = self.result_image
            else:
                image = self.original_image
            if image is None:
                QMessageBox.information(self, "No Output", "There is no output image yet.")
                return
            gray = to_grayscale(image)
            message = (
                "Image Statistics\n"
                f"Min Value:  {int(np.min(gray))}\n"
                f"Max Value:  {int(np.max(gray))}\n"
                f"Mean:       {float(np.mean(gray)):.2f}\n"
                f"Std Dev:    {float(np.std(gray)):.2f}"
            )
            QMessageBox.information(self, "Statistics", message)
            return

        params: Dict[str, str | int] = {"operation": operation}

        if operation == "brightness":
            dialog = BrightnessDialog(self)
            if dialog.exec_() != QDialog.Accepted:
                return
            value = dialog.value
            self._push_undo_state()
            if self.original_image.ndim == 2:
                adjusted = np.clip(self.original_image.astype(np.int16) + value, 0, 255).astype(np.uint8)
            elif self.original_image.shape[2] == 4:
                adjusted = self.original_image.copy()
                adjusted[:, :, :3] = np.clip(adjusted[:, :, :3].astype(np.int16) + value, 0, 255).astype(np.uint8)
            else:
                adjusted = np.clip(self.original_image.astype(np.int16) + value, 0, 255).astype(np.uint8)
            self.result_image = adjusted
            self.result_view.set_image(adjusted)
            self._write_run_details("Run Details - brightness", f"Handled in Python on the original image with brightness value {value:+d}.")
            self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | Brightness complete")
            return
        elif operation == "threshold":
            value, ok = QInputDialog.getInt(self, "Threshold", "Enter threshold value (0 to 255):", 127, 0, 255, 1)
            if not ok:
                return
            self._push_undo_state()
            output = threshold_image(self.original_image, value)
            self.result_image = output
            self.result_view.set_image(output)
            self._write_run_details("Run Details - threshold", f"Handled in Python on the original image with threshold value {value}.")
            self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | threshold complete")
            return
        elif operation == "meanfilter":
            value, ok = QInputDialog.getInt(self, "Mean Filter", "Enter odd window size:", 3, 3, 31, 2)
            if not ok:
                return
            window = value if value % 2 == 1 else value + 1
            self._push_undo_state()
            if self.original_image.ndim == 2:
                output = cv2.blur(self.original_image, (window, window))
            elif self.original_image.shape[2] == 4:
                output = self.original_image.copy()
                output[:, :, :3] = cv2.blur(self.original_image[:, :, :3], (window, window))
            else:
                output = cv2.blur(self.original_image, (window, window))
            self.result_image = output
            self.result_view.set_image(output)
            self._write_run_details("Run Details - meanfilter", f"Handled in Python on the original image with window size {window}.")
            self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | meanfilter complete")
            return
        elif operation == "kmeans":
            dialog = KMeansDialog(self)
            if dialog.exec_() != QDialog.Accepted:
                return
            value = dialog.value
            default_ranges = calculate_default_ranges(value)
            params = {"operation": "kmeans", "K": value, "ranges": ranges_to_string(default_ranges)}
            self.status_label.setText("Running K-Means... please wait")
            QApplication.processEvents()
            started = time.perf_counter()
            output = self._run_backend_operation(params, source_image=self.original_image)
            elapsed = time.perf_counter() - started
            if output is None:
                self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | Operation failed")
                return
            self._push_undo_state()
            self.result_image = self._load_cluster_backend_result("K-Means")
            self.result_view.set_image(self.result_image)
            self.status_label.setText(f"K-Means complete | K={value} clusters | {elapsed:.1f}s")
            return

        output = self._run_backend_operation(params)
        if output is None:
            self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | Operation failed")
            return

        self._push_undo_state()
        self.result_image = output
        self.result_view.set_image(output)
        self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | {operation} complete")

    def show_histogram_workflow(self) -> None:
        if self.original_image is None:
            QMessageBox.information(self, "No Image", "Load an image before generating a histogram.")
            return

        dialog = HistogramTargetDialog(has_output=self.result_image is not None, parent=self)
        if dialog.exec_() != QDialog.Accepted:
            return

        if dialog.selection == "output":
            image = self.result_image
            title = "Histogram - Output Image"
        else:
            image = self.original_image
            title = "Histogram - Original Image"

        if image is None:
            QMessageBox.information(self, "No Output", "There is no output image yet.")
            return

        histogram_image = image[:, :, :3] if image.ndim == 3 and image.shape[2] == 4 else image
        window = HistogramWindow(title, histogram_image, self)
        window.show()
        self.histogram_windows.append(window)
        self.status_label.setText(f"{self.current_path.name} | Resolution: {self.original_image.shape[1]} x {self.original_image.shape[0]} | Histogram opened")

    def apply_grayscale(self) -> None:
        self.execute_operation("grayscale")

    def apply_negative(self) -> None:
        self.execute_operation("negative")

    def apply_mean_filter(self) -> None:
        self.execute_operation("meanfilter")

    def apply_laplacian(self) -> None:
        self.execute_operation("laplacian")

    def apply_brightness(self) -> None:
        self.execute_operation("brightness")

    def apply_threshold(self) -> None:
        self.execute_operation("threshold")

    def run_kmeans(self) -> None:
        self.execute_operation("kmeans")

    def open_classify_dialog(self) -> None:
        self.open_classify_clusters_dialog()

    def show_statistics(self) -> None:
        self.execute_operation("statistics")

    def show_histogram(self) -> None:
        self.show_histogram_workflow()

    def huffman_compress(self) -> None:
        self.run_huffman_compress()

    def huffman_decompress(self) -> None:
        self.run_huffman_decompress()

    def zoom_in_active(self) -> None:
        self.original_view.zoom_in()
        self.result_view.zoom_in()

    def zoom_out_active(self) -> None:
        self.original_view.zoom_out()
        self.result_view.zoom_out()

    def fit_views(self) -> None:
        self.original_view.fit_to_view()
        self.result_view.fit_to_view()

    def set_pan_mode(self) -> None:
        if self.distance_mode and hasattr(self, "distance_action") and self.distance_action.isChecked():
            self.distance_action.setChecked(False)
            return
        self.original_view.set_pan_mode()
        self.result_view.set_pan_mode()
        self.pan_action.setChecked(True)

    def set_select_mode(self) -> None:
        self.original_view.set_select_mode()
        self.result_view.set_select_mode()
        if self.select_action is not None:
            self.select_action.setChecked(True)

    def save_result(self) -> None:
        if self.result_image is None:
            QMessageBox.information(self, "No Result", "Run an algorithm before saving.")
            return
        path, _ = QFileDialog.getSaveFileName(
            self,
            "Save processed result",
            str(IMAGES_DIR / "geocluster_result.png"),
            "PNG (*.png);;JPEG (*.jpg *.jpeg);;Bitmap (*.bmp)",
        )
        if not path:
            return
        cv2.imwrite(path, self.result_image)
        self.status_label.setText(f"Saved result to {path}")


def apply_geotech_theme(app: QApplication) -> None:
    app.setStyle("Fusion")
    app.setStyleSheet(
        """
        QWidget {
            background-color: #0a0a0f;
            color: #d8e7f2;
            font-size: 11pt;
        }
        QMainWindow, QDialog {
            background-color: #0a0a0f;
        }
        QMenuBar, QMenu, QToolBar {
            background-color: #11131a;
            color: #d8e7f2;
            font-size: 12pt;
        }
        QStatusBar {
            background-color: #0d1017;
            color: #8fa3bf;
            border-top: 1px solid #22263a;
            font-size: 12pt;
        }
        QLabel {
            color: #d8e7f2;
        }
        QGroupBox {
            border: 1px solid #22263a;
            border-radius: 8px;
            margin-top: 10px;
            padding-top: 10px;
            background-color: #0d1017;
        }
        QGroupBox::title {
            subcontrol-origin: margin;
            left: 10px;
            padding: 0 4px;
            color: #00f0ff;
            font-weight: 600;
        }
        QPushButton, QSpinBox, QTextEdit, QComboBox, QLineEdit {
            background-color: #11131a;
            color: #d8e7f2;
            border: 1px solid #22263a;
            border-radius: 6px;
            padding: 6px;
            font-size: 12pt;
        }
        QPushButton {
            background-color: #11131a;
        }
        QPushButton:hover, QToolButton:hover {
            border: 1px solid #00f0ff;
            background-color: #121826;
            color: #f5fbff;
        }
        QPushButton:pressed, QToolButton:pressed, QPushButton:checked, QToolButton:checked {
            border: 1px solid #ff00ff;
            background-color: #1a1430;
            color: #f5fbff;
        }
        QComboBox {
            padding-right: 28px;
        }
        QComboBox::drop-down {
            width: 30px;
            border: none;
            background-color: #11131a;
        }
        QComboBox::down-arrow {
            image: none;
            width: 0px;
            height: 0px;
            border-left: 6px solid transparent;
            border-right: 6px solid transparent;
            border-top: 8px solid #00f0ff;
            margin-right: 8px;
        }
        QComboBox:on {
            border: 1px solid #8a2be2;
            background-color: #141322;
        }
        QComboBox QAbstractItemView {
            background-color: #11131a;
            color: #d8e7f2;
            border: 1px solid #22263a;
            selection-background-color: #1a1430;
            selection-color: #f5fbff;
            font-size: 12pt;
        }
        QTextEdit {
            padding: 8px;
            background-color: #0d1017;
            color: #8fefff;
            border: 1px solid #22263a;
            font-family: Consolas, "Courier New", monospace;
        }
        QHeaderView::section {
            background-color: #141826;
            color: #00f0ff;
            border: 1px solid #22263a;
            padding: 6px;
            font-weight: 700;
        }
        QTableWidget {
            background-color: #0d1017;
            alternate-background-color: #11131a;
            gridline-color: #22263a;
            selection-background-color: #1a1430;
            selection-color: #f5fbff;
            border: 1px solid #22263a;
        }
        QTableCornerButton::section {
            background-color: #141826;
            border: 1px solid #22263a;
        }
        QCheckBox, QRadioButton {
            spacing: 8px;
        }
        QCheckBox::indicator, QRadioButton::indicator {
            width: 16px;
            height: 16px;
            border: 1px solid #3a4054;
            background-color: #11131a;
        }
        QCheckBox::indicator:checked, QRadioButton::indicator:checked {
            background-color: #00f0ff;
            border: 1px solid #00f0ff;
        }
        QSlider::groove:horizontal {
            height: 6px;
            background: #1a1f2c;
            border-radius: 3px;
        }
        QSlider::handle:horizontal {
            width: 14px;
            margin: -5px 0;
            border-radius: 7px;
            background: #ff00ff;
            border: 1px solid #8a2be2;
        }
        QProgressBar {
            background-color: #11131a;
            color: #d8e7f2;
            border: 1px solid #22263a;
            border-radius: 6px;
            text-align: center;
        }
        QProgressBar::chunk {
            background-color: #00f0ff;
        }
        """
    )

