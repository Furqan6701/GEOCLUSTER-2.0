from __future__ import annotations

import heapq
import math
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

import numpy as np


@dataclass
class DistanceResult:
    x1: int = 0
    y1: int = 0
    x2: int = 0
    y2: int = 0
    distance: float = 0.0


@dataclass
class HistogramResult:
    counts: List[int]


@dataclass
class HuffmanCompressionResult:
    original_bytes: int = 0
    compressed_bytes: int = 0
    payload_bits: int = 0
    non_zero_frequencies: List[int] = field(default_factory=list)


@dataclass
class KMeansParams:
    k: int = 5
    max_iter: int = 30
    tolerance: float = 1e-3
    seed: int = 42
    ranges: List[Tuple[int, int]] = field(default_factory=list)
    centroids_path: Path = Path("../data/centroids.txt")
    ranges_path: Path = Path("../data/ranges.txt")


@dataclass
class KMeansResult:
    output: np.ndarray
    centroids: List[float]
    centroid_dimensions: int = 1
    iterations_run: int = 0
    converged: bool = False
    counts: List[int] = field(default_factory=list)
    log_lines: List[str] = field(default_factory=list)


class Timer:
    def __init__(self, label: str, log_lines: List[str] | None = None) -> None:
        self.label = label
        self.log_lines = log_lines
        self.started = time.perf_counter()

    def __enter__(self) -> "Timer":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        elapsed_ms = (time.perf_counter() - self.started) * 1000.0
        line = f"[{self.label}] took {elapsed_ms:.2f} ms"
        if self.log_lines is not None:
            self.log_lines.append(line)
        else:
            print(line)


def clamp_int(value: int, lo: int, hi: int) -> int:
    return max(lo, min(int(value), hi))


def _cpp_round(value: float) -> int:
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def saturate_to_byte(value: float) -> np.uint8:
    return np.uint8(clamp_int(_cpp_round(value), 0, 255))


def to_gray_doubles(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image.astype(np.float64, copy=True)
    channels = image.shape[2]
    blue = image[:, :, 0].astype(np.float64)
    green = image[:, :, min(1, channels - 1)].astype(np.float64)
    red = image[:, :, min(2, channels - 1)].astype(np.float64)
    return 0.114 * blue + 0.587 * green + 0.299 * red


def gray_image_from_doubles(rows: int, cols: int, values: Sequence[float]) -> np.ndarray:
    rounded = np.floor(np.asarray(values, dtype=np.float64).reshape(rows, cols) + 0.5)
    return np.clip(rounded, 0, 255).astype(np.uint8)


def join_ints(values: Sequence[int]) -> str:
    return ",".join(str(int(value)) for value in values)


def join_doubles(values: Sequence[float]) -> str:
    return ",".join(f"{float(value):.3f}" for value in values)


def compute_distance(x1: int, y1: int, x2: int, y2: int) -> DistanceResult:
    dx = float(x2 - x1)
    dy = float(y2 - y1)
    return DistanceResult(x1=x1, y1=y1, x2=x2, y2=y2, distance=math.sqrt(dx * dx + dy * dy))


def format_distance(value: float, precision: int = 3) -> str:
    return f"{value:.{precision}f}"


def grayscale_copy(image: np.ndarray) -> np.ndarray:
    return np.asarray(image).copy()


def image_negative(image: np.ndarray) -> np.ndarray:
    return 255 - np.asarray(image, dtype=np.uint8)


def adjust_brightness(image: np.ndarray, value: int) -> np.ndarray:
    return np.clip(np.asarray(image, dtype=np.int32) + int(value), 0, 255).astype(np.uint8)


def apply_threshold(image: np.ndarray, threshold: int) -> np.ndarray:
    return np.where(np.asarray(image) > int(threshold), 255, 0).astype(np.uint8)


def _reflected_indices(length: int, radius: int) -> np.ndarray:
    base = np.arange(length)
    offsets = np.arange(-radius, radius + 1)
    indices = base[:, None] + offsets[None, :]
    if length <= 1:
        return np.zeros_like(indices)
    indices = np.where(indices < 0, -indices, indices)
    indices = np.where(indices >= length, length - (indices - length) - 2, indices)
    return indices


def mean_filter(image: np.ndarray, window_size: int) -> np.ndarray:
    matrix = np.asarray(image, dtype=np.int32)
    radius = int(window_size) // 2
    row_indices = _reflected_indices(matrix.shape[0], radius)
    col_indices = _reflected_indices(matrix.shape[1], radius)
    neighborhoods = matrix[row_indices[:, :, None, None], col_indices[None, None, :, :]]
    averaged = neighborhoods.sum(axis=(1, 3)) // ((2 * radius + 1) * (2 * radius + 1))
    return averaged.astype(np.uint8)


def compute_histogram(image: np.ndarray) -> HistogramResult:
    values = np.clip(np.asarray(image, dtype=np.int32), 0, 255).astype(np.uint8)
    return HistogramResult(np.bincount(values.ravel(), minlength=256).astype(int).tolist())


def read_csv_matrix(path: str | Path) -> np.ndarray:
    rows: List[List[int]] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if line:
                rows.append([clamp_int(int(cell), 0, 255) for cell in line.split(",")])
    if not rows:
        raise RuntimeError(f"Input CSV is empty: {path}")
    return np.asarray(rows, dtype=np.uint8)


def write_csv_matrix(path: str | Path, matrix: np.ndarray) -> None:
    np.savetxt(Path(path), np.clip(np.asarray(matrix, dtype=np.int32), 0, 255), fmt="%d", delimiter=",")


def read_params(path: str | Path) -> Dict[str, str]:
    params: Dict[str, str] = {}
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if "=" in line:
                key, value = line.split("=", 1)
                params[key] = value
    return params


def write_metadata(path: str | Path, lines: Iterable[str]) -> None:
    Path(path).write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


def default_ranges(k: int) -> List[Tuple[int, int]]:
    ranges: List[Tuple[int, int]] = []
    step = 256.0 / k
    for index in range(k):
        min_value = int(index * step)
        max_value = int((index + 1) * step) - 1
        if index == k - 1:
            max_value = 255
        ranges.append((min_value, max_value))
    return ranges


def parse_ranges(range_str: str) -> List[Tuple[int, int]]:
    ranges: List[Tuple[int, int]] = []
    for token in range_str.split(","):
        if "-" in token:
            min_value, max_value = token.split("-", 1)
            ranges.append((int(min_value), int(max_value)))
    return ranges


def run_kmeans(image: np.ndarray, params: KMeansParams) -> KMeansResult:
    import torch

    log_lines: List[str] = []
    with Timer("KMeans", log_lines):
        source = np.asarray(image, dtype=np.uint8)
        rows, cols = source.shape
        cluster_count = max(2, int(params.k))
        ranges = params.ranges or default_ranges(cluster_count)
        centroids = torch.tensor([(low + high) / 2.0 for low, high in ranges], dtype=torch.float64)
        try:
            device = torch.device("cuda")
            centroids = centroids.to("cuda")
            pixels = torch.from_numpy(source.astype(np.float64, copy=False)).to("cuda")
            lut_values = torch.arange(256, dtype=torch.float64).to("cuda")
        except Exception as exc:
            log_lines.append(f"CUDA unavailable; using CPU tensors instead: {exc}")
            device = torch.device("cpu")
            centroids = centroids.to(device)
            pixels = torch.from_numpy(source.astype(np.float64, copy=False)).to(device)
            lut_values = torch.arange(256, dtype=torch.float64).to(device)

        iterations_run = 0
        converged = False
        for iteration in range(int(params.max_iter)):
            iterations_run = iteration + 1
            lut = torch.argmin(torch.abs(lut_values[:, None] - centroids[None, :]), dim=1)
            labels = lut[pixels.to(torch.long)]
            flat_labels = labels.reshape(-1)
            flat_pixels = pixels.reshape(-1)
            counts = torch.bincount(flat_labels, minlength=cluster_count)
            sums = torch.zeros(cluster_count, dtype=torch.float64, device=device)
            sums.scatter_add_(0, flat_labels, flat_pixels)
            non_empty = counts > 0
            new_centroids = centroids.clone()
            new_centroids[non_empty] = sums[non_empty] / counts[non_empty].to(torch.float64)
            max_shift = torch.max(torch.abs(new_centroids - centroids)) if torch.any(non_empty) else torch.tensor(0.0, device=device)
            centroids = new_centroids
            if float(max_shift.detach().cpu()) < 0.5:
                log_lines.append(f"Converged at iteration {iteration + 1}")
                converged = True
                break

        centroids_cpu = sorted(float(value) for value in centroids.detach().cpu().tolist())
        final_ranges: List[Tuple[int, int]] = []
        for index in range(cluster_count):
            min_value = 0 if index == 0 else int((centroids_cpu[index - 1] + centroids_cpu[index]) / 2.0) + 1
            max_value = 255 if index == cluster_count - 1 else int((centroids_cpu[index] + centroids_cpu[index + 1]) / 2.0)
            final_ranges.append((min_value, max_value))

        output = np.zeros((rows, cols), dtype=np.uint8)
        count_values = [0] * cluster_count
        for cluster_index, (min_value, max_value) in enumerate(final_ranges):
            mask = (source >= min_value) & (source <= max_value)
            output[mask] = cluster_index
            count_values[cluster_index] = int(mask.sum())

    Path(params.centroids_path).write_text("".join(f"{i}={_cpp_round(c)}\n" for i, c in enumerate(centroids_cpu)), encoding="utf-8")
    Path(params.ranges_path).write_text("".join(f"{i}={low}-{high}\n" for i, (low, high) in enumerate(final_ranges)), encoding="utf-8")
    log_lines += ["K-Means complete", f"Clusters: {cluster_count}", f"Iterations: {iterations_run}"]
    log_lines += [f"Cluster {i}: centroid={_cpp_round(c)} pixels={count_values[i]}" for i, c in enumerate(centroids_cpu)]
    return KMeansResult(output, centroids_cpu, 1, iterations_run, converged, count_values, log_lines)


K_MAGIC = b"GCH1"


@dataclass(order=True)
class _HeapEntry:
    frequency: int
    value: int
    node: object = field(compare=False)


@dataclass
class _HuffmanNode:
    value: int
    frequency: int
    left: "_HuffmanNode | None" = None
    right: "_HuffmanNode | None" = None

    def is_leaf(self) -> bool:
        return self.left is None and self.right is None


def _build_tree(frequencies: Sequence[int]) -> _HuffmanNode:
    queue = [_HeapEntry(int(freq), value, _HuffmanNode(value, int(freq))) for value, freq in enumerate(frequencies) if int(freq) > 0]
    if not queue:
        raise RuntimeError("Cannot build Huffman tree from empty data.")
    heapq.heapify(queue)
    while len(queue) > 1:
        left = heapq.heappop(queue).node
        right = heapq.heappop(queue).node
        parent = _HuffmanNode(min(left.value, right.value), left.frequency + right.frequency, left, right)
        heapq.heappush(queue, _HeapEntry(parent.frequency, parent.value, parent))
    return queue[0].node


def _build_codes(node: _HuffmanNode, prefix: str, codes: Dict[int, str]) -> None:
    if node.is_leaf():
        codes[node.value] = prefix or "0"
        return
    if node.left is not None:
        _build_codes(node.left, prefix + "0", codes)
    if node.right is not None:
        _build_codes(node.right, prefix + "1", codes)


def compress_image_huffman(image: np.ndarray, path: str | Path) -> HuffmanCompressionResult:
    matrix = np.asarray(image)
    if matrix.size == 0 or matrix.ndim != 2 or matrix.shape[1] == 0:
        raise RuntimeError("Cannot compress an empty image.")
    values = np.clip(matrix.astype(np.int32), 0, 255).astype(np.uint8)
    rows, cols = values.shape
    frequencies = np.bincount(values.ravel(), minlength=256).astype(np.uint32)
    codes: Dict[int, str] = {}
    _build_codes(_build_tree(frequencies), "", codes)
    packed = bytearray()
    current_byte = 0
    bit_count = 0
    payload_bits = 0
    for value in values.ravel():
        for bit in codes[int(value)]:
            current_byte = (current_byte << 1) | (1 if bit == "1" else 0)
            bit_count += 1
            payload_bits += 1
            if bit_count == 8:
                packed.append(current_byte)
                current_byte = 0
                bit_count = 0
    if bit_count:
        packed.append(current_byte << (8 - bit_count))
    output_path = Path(path)
    with output_path.open("wb") as handle:
        handle.write(K_MAGIC)
        handle.write(struct.pack("<III", rows, cols, payload_bits))
        for frequency in frequencies:
            handle.write(struct.pack("<I", int(frequency)))
        handle.write(packed)
    return HuffmanCompressionResult(rows * cols, output_path.stat().st_size, payload_bits, [v for v, f in enumerate(frequencies) if int(f) > 0])


def decompress_image_huffman(path: str | Path) -> np.ndarray:
    data = Path(path).read_bytes()
    if len(data) < 16 or data[:4] != K_MAGIC:
        raise RuntimeError("Invalid Huffman file format.")
    rows, cols, payload_bits = struct.unpack("<III", data[4:16])
    if rows == 0 or cols == 0:
        raise RuntimeError("Compressed file contains invalid image dimensions.")
    offset = 16
    frequencies = list(struct.unpack("<256I", data[offset:offset + 1024]))
    tree = _build_tree(frequencies)
    image = np.zeros((rows, cols), dtype=np.uint8)
    if tree.is_leaf():
        image[:, :] = tree.value
        return image
    current = tree
    pixel_index = 0
    consumed_bits = 0
    for byte in data[offset + 1024:]:
        for bit in range(7, -1, -1):
            if consumed_bits >= payload_bits:
                break
            current = current.right if ((byte >> bit) & 1) else current.left
            consumed_bits += 1
            if current is None:
                raise RuntimeError("Corrupted Huffman payload.")
            if current.is_leaf():
                if pixel_index >= rows * cols:
                    raise RuntimeError("Decoded more pixels than expected from Huffman payload.")
                image[pixel_index // cols, pixel_index % cols] = current.value
                pixel_index += 1
                current = tree
    if pixel_index != rows * cols:
        raise RuntimeError("Decoded pixel count does not match the stored image dimensions.")
    return image


def _read_int(params: Dict[str, str | int], key: str, fallback: int) -> int:
    return int(params.get(key, fallback))


def _metadata_dict(lines: Sequence[str]) -> Dict[str, str]:
    return dict(line.split("=", 1) for line in lines if "=" in line)


def process_operation(image: np.ndarray | None, params: Dict[str, str | int], centroids_path: str | Path, ranges_path: str | Path, meta_path: str | Path, huffman_path: str | Path, output_path: str | Path | None = None) -> tuple[np.ndarray | None, str, Dict[str, str]]:
    operation = str(params.get("operation", ""))
    if not operation:
        raise RuntimeError("No operation specified in params.txt")
    log_lines = ["GEOCLUSTER Backend Starting...", f"Operation: {operation}"]
    metadata_lines = [f"operation={operation}"]
    if operation == "distance":
        result = compute_distance(_read_int(params, "x1", 0), _read_int(params, "y1", 0), _read_int(params, "x2", 0), _read_int(params, "y2", 0))
        metadata_lines += [f"x1={result.x1}", f"y1={result.y1}", f"x2={result.x2}", f"y2={result.y2}", f"distance={format_distance(result.distance)}"]
        write_metadata(meta_path, metadata_lines)
        log_lines.append(f"Distance: {format_distance(result.distance)} pixels")
        return None, "\n".join(log_lines), _metadata_dict(metadata_lines)
    if operation == "huffman_decompress":
        working = decompress_image_huffman(huffman_path)
    else:
        if image is None:
            raise RuntimeError(f"Operation requires an image: {operation}")
        working = np.asarray(image, dtype=np.uint8)
    metadata_lines += [f"rows={working.shape[0]}", f"cols={working.shape[1] if working.ndim >= 2 else 0}"]
    if operation == "grayscale":
        output = grayscale_copy(working)
    elif operation == "negative":
        output = image_negative(working)
    elif operation == "brightness":
        value = _read_int(params, "value", 0)
        output = adjust_brightness(working, value)
        metadata_lines.append(f"value={value}")
    elif operation == "threshold":
        threshold = _read_int(params, "value", 127)
        output = apply_threshold(working, threshold)
        metadata_lines.append(f"value={threshold}")
    elif operation == "meanfilter":
        window = max(3, _read_int(params, "window", 3) | 1)
        output = mean_filter(working, window)
        metadata_lines.append(f"window={window}")
    elif operation == "kmeans":
        cluster_count = clamp_int(_read_int(params, "K", _read_int(params, "value", 5)), 2, 60)
        kmeans_params = KMeansParams(k=cluster_count, max_iter=_read_int(params, "maxIter", 30), ranges=parse_ranges(str(params["ranges"])) if "ranges" in params else [], centroids_path=Path(centroids_path), ranges_path=Path(ranges_path))
        result = run_kmeans(working, kmeans_params)
        output = result.output
        log_lines += result.log_lines
        metadata_lines += [f"clusters={cluster_count}", f"centroids_path={centroids_path}", f"ranges_path={ranges_path}"]
    elif operation == "huffman_compress":
        compression = compress_image_huffman(working, huffman_path)
        output = working
        metadata_lines += [f"compressed_path={huffman_path}", f"original_bytes={compression.original_bytes}", f"compressed_bytes={compression.compressed_bytes}", f"payload_bits={compression.payload_bits}", f"unique_values={len(compression.non_zero_frequencies)}"]
    elif operation == "huffman_decompress":
        output = working
        metadata_lines.append(f"source_path={huffman_path}")
    else:
        raise RuntimeError(f"Unsupported operation: {operation}")
    if output_path is not None:
        write_csv_matrix(output_path, output)
    write_metadata(meta_path, metadata_lines)
    log_lines.append("Done!")
    return output, "\n".join(log_lines), _metadata_dict(metadata_lines)
