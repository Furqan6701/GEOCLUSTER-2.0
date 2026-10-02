"""Generate golden fixtures from the DESKTOP code (Provenance script).

This script is NOT collected by pytest and MUST NOT be imported by tests.
It is kept so the fixtures can be regenerated and audited.

How to run (from the repository root, with a throwaway venv that has the
desktop pins installed and PyQt5 importable):

    cd desktop
    LD_LIBRARY_PATH=/path/to/glstub QT_QPA_PLATFORM=offscreen \
        /path/to/fixvenv/bin/python ../api/tests/fixtures/generate_fixtures.py

Everything it writes goes to api/tests/fixtures/ (never under desktop/).

K-Means note: torch is not installable in the sandbox where these fixtures
were produced, so the K-Means fixture was generated with a deliberately naive
reference implementation of backend_py.run_kmeans (same LUT/centroid-update/
convergence semantics, independent code path). It is marked
"reference-implementation" in expected_values.json.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

# --- locate repo layout -----------------------------------------------------
FIXTURES = Path(__file__).resolve().parent
REPO_ROOT = FIXTURES.parent.parent.parent  # api/tests/fixtures -> repo root
DESKTOP = REPO_ROOT / "desktop"
sys.path.insert(0, str(DESKTOP))
sys.path.insert(0, str(DESKTOP / "frontend"))

from frontend import ui  # noqa: E402  (desktop canonical behavior)


def save_png(name: str, array: np.ndarray) -> None:
    path = FIXTURES / name
    if not cv2.imwrite(str(path), array):
        raise RuntimeError(f"failed to write {path}")


def save_npy(name: str, array: np.ndarray) -> None:
    np.save(FIXTURES / name, array)


def load_png(name: str) -> np.ndarray:
    return cv2.imread(str(FIXTURES / name), cv2.IMREAD_UNCHANGED)


# --- canonical desktop operations (replicated verbatim from ui.py) ----------

def ui_negative(image: np.ndarray) -> np.ndarray:
    """ui.py execute_operation 'negative' branch."""
    output = image.copy()
    if output.ndim == 2:
        output = cv2.bitwise_not(output)
    elif output.shape[2] == 4:
        output[:, :, :3] = cv2.bitwise_not(output[:, :, :3])
    else:
        output = cv2.bitwise_not(output)
    return output


def ui_brightness(image: np.ndarray, value: int) -> np.ndarray:
    """ui.py execute_operation 'brightness' branch."""
    if image.ndim == 2:
        return np.clip(image.astype(np.int16) + value, 0, 255).astype(np.uint8)
    if image.shape[2] == 4:
        adjusted = image.copy()
        adjusted[:, :, :3] = np.clip(adjusted[:, :, :3].astype(np.int16) + value, 0, 255).astype(np.uint8)
        return adjusted
    return np.clip(image.astype(np.int16) + value, 0, 255).astype(np.uint8)


def ui_mean_filter(image: np.ndarray, window: int) -> np.ndarray:
    """ui.py execute_operation 'meanfilter' branch."""
    if image.ndim == 2:
        return cv2.blur(image, (window, window))
    if image.shape[2] == 4:
        output = image.copy()
        output[:, :, :3] = cv2.blur(image[:, :, :3], (window, window))
        return output
    return cv2.blur(image, (window, window))


def ui_laplacian(image: np.ndarray) -> np.ndarray:
    """ui.py execute_operation 'laplacian' branch."""
    gray = ui.to_grayscale(image)
    return cv2.convertScaleAbs(cv2.Laplacian(gray, cv2.CV_64F))


# --- naive K-Means reference (see module docstring) ------------------------

def reference_kmeans(
    gray: np.ndarray,
    k: int,
    ranges: list[tuple[int, int]],
    max_iter: int = 30,
    tolerance: float = 0.5,
) -> tuple[np.ndarray, list[float], list[tuple[int, int]], list[int], int, bool, bool]:
    src = np.asarray(gray, dtype=np.uint8)
    centroids = np.array([(lo + hi) / 2.0 for lo, hi in ranges], dtype=np.float64)
    iterations = 0
    converged = False
    for iteration in range(max_iter):
        iterations = iteration + 1
        # naive per-intensity nearest-centroid scan (first-minimum tie-break)
        lut = np.zeros(256, dtype=np.int64)
        for value in range(256):
            best = 0
            best_dist = abs(value - centroids[0])
            for cluster in range(1, k):
                dist = abs(value - centroids[cluster])
                if dist < best_dist:
                    best_dist = dist
                    best = cluster
            lut[value] = best
        labels = lut[src.ravel()]
        flat = src.reshape(-1)
        new_centroids = centroids.copy()
        any_non_empty = False
        for cluster in range(k):
            mask = labels == cluster
            count = int(mask.sum())
            if count > 0:
                any_non_empty = True
                total = float(np.sum(flat[mask], dtype=np.float64))
                new_centroids[cluster] = total / count
        max_shift = float(np.max(np.abs(new_centroids - centroids))) if any_non_empty else 0.0
        centroids = new_centroids
        if max_shift < tolerance:
            converged = True
            break

    centroid_list = sorted(float(c) for c in centroids)
    final_ranges: list[tuple[int, int]] = []
    for index in range(k):
        lo = 0 if index == 0 else int((centroid_list[index - 1] + centroid_list[index]) / 2.0) + 1
        hi = 255 if index == k - 1 else int((centroid_list[index] + centroid_list[index + 1]) / 2.0)
        final_ranges.append((lo, hi))

    output = np.zeros(src.shape, dtype=np.uint8)
    counts: list[int] = [0] * k
    for cluster_index, (lo, hi) in enumerate(final_ranges):
        mask = (src >= lo) & (src <= hi)
        output[mask] = cluster_index
        counts[cluster_index] = int(mask.sum())
    return output, centroid_list, final_ranges, counts, iterations, converged


def main() -> None:
    expected: dict = {}

    # ---------------- input images ----------------
    sample = cv2.imread(str(DESKTOP / "images" / "sample.jpg"), cv2.IMREAD_COLOR)
    if sample is None:
        raise SystemExit("could not read sample.jpg")
    # copy the JPEG bytes verbatim: re-encoding would be lossy and every
    # fixture computed from the original would stop matching the fixture copy
    shutil.copyfile(DESKTOP / "images" / "sample.jpg", FIXTURES / "sample.jpg")
    assert np.array_equal(sample, cv2.imread(str(FIXTURES / "sample.jpg"), cv2.IMREAD_COLOR))

    # small synthetic BGRA image with a gradient alpha channel
    h, w = 48, 64
    alpha = np.linspace(0, 255, w, dtype=np.uint8)[None, :].repeat(h, axis=0)
    yy, xx = np.mgrid[0:h, 0:w]
    synthetic = np.dstack(
        [
            ((xx * 4) % 256).astype(np.uint8),
            ((yy * 5) % 256).astype(np.uint8),
            (((xx + yy) * 3) % 256).astype(np.uint8),
            alpha,
        ]
    )
    save_png("alpha_synthetic.png", synthetic)

    gray = ui.to_grayscale(sample)
    save_png("gray_sample.png", gray)
    expected["gray_sample_shape"] = list(gray.shape)
    expected["gray_sample_pixel_0_0"] = int(gray[0, 0])

    alpha_gray = ui.to_grayscale(synthetic)
    save_png("alpha_gray.png", alpha_gray)

    # ---------------- filters on sample.jpg ----------------
    save_png("negative_sample.png", ui_negative(sample))
    save_png("brightness_p40_sample.png", ui_brightness(sample, 40))
    save_png("brightness_m40_sample.png", ui_brightness(sample, -40))
    save_png("threshold128_sample.png", ui.threshold_image(sample, 128))
    save_png("mean3_sample.png", ui_mean_filter(sample, 3))
    save_png("mean5_sample.png", ui_mean_filter(sample, 5))
    save_png("laplacian_sample.png", ui_laplacian(sample))

    # ---------------- filters on the alpha image ----------------
    save_png("alpha_negative.png", ui_negative(synthetic))
    save_png("alpha_brightness_p40.png", ui_brightness(synthetic, 40))
    save_png("alpha_threshold128.png", ui.threshold_image(synthetic, 128))
    save_png("alpha_mean3.png", ui_mean_filter(synthetic, 3))
    save_png("alpha_laplacian.png", ui_laplacian(synthetic))
    expected["alpha_alpha_channel_preserved_in_negative"] = bool(
        np.array_equal(ui_negative(synthetic)[:, :, 3], synthetic[:, :, 3])
    )
    expected["alpha_alpha_channel_preserved_in_brightness"] = bool(
        np.array_equal(ui_brightness(synthetic, 40)[:, :, 3], synthetic[:, :, 3])
    )
    expected["alpha_alpha_channel_preserved_in_threshold"] = bool(
        np.array_equal(ui.threshold_image(synthetic, 128)[:, :, 3], synthetic[:, :, 3])
    )
    expected["alpha_alpha_channel_preserved_in_mean"] = bool(
        np.array_equal(ui_mean_filter(synthetic, 3)[:, :, 3], synthetic[:, :, 3])
    )

    # ---------------- statistics (desktop: np.* on to_grayscale) ----------------
    expected["stats_sample"] = {
        "min": int(np.min(gray)),
        "max": int(np.max(gray)),
        "mean": float(np.mean(gray)),
        "std": float(np.std(gray)),
    }
    expected["stats_alpha"] = {
        "min": int(np.min(alpha_gray)),
        "max": int(np.max(alpha_gray)),
        "mean": float(np.mean(alpha_gray)),
        "std": float(np.std(alpha_gray)),
    }
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.int64)
    expected["histogram_sample_first32"] = hist[:32].tolist()
    expected["histogram_sample_total"] = int(hist.sum())

    # ---------------- K-Means K=5 ----------------
    k = 5
    init_ranges = ui.calculate_default_ranges(k)
    labels, centroids, final_ranges, counts, iterations, converged = reference_kmeans(gray, k, init_ranges)
    np.save(FIXTURES / "kmeans_k5_labels.npy", labels)  # authoritative label fixture
    save_png("kmeans_k5_display.png", ui.build_cluster_display_image(labels, ui.default_cluster_assignments("K-Means", list(range(k)))))
    expected["kmeans_k5"] = {
        "generator": "reference-implementation (torch not installable in the build sandbox)",
        "k": k,
        "init_ranges": [list(r) for r in init_ranges],
        "max_iter": 30,
        "tolerance": 0.5,
        "iterations": iterations,
        "converged": converged,
        "centroids": centroids,
        "ranges": [list(r) for r in final_ranges],
        "counts": counts,
    }
    expected["kmeans_k5_assignments"] = {
        str(key): {"name": value["name"], "color": list(value["color"])}
        for key, value in ui.default_cluster_assignments("K-Means", list(range(k))).items()
    }

    # ---------------- classification recolor + legend ----------------
    classify_ranges = {i: tuple(r) for i, r in enumerate(ui.calculate_default_ranges(5))}
    classify_assignments = {c: dict(v) for c, v in ui.default_cluster_assignments("K-Means", sorted(classify_ranges)).items()}
    gray_flat = gray.flatten()
    total = gray_flat.size
    legend = []
    labels_from_ranges = np.zeros(gray.shape, dtype=np.uint8)
    for cluster in sorted(classify_ranges):
        lo, hi = classify_ranges[cluster]
        mask = (gray_flat >= lo) & (gray_flat <= hi)
        count = int(np.sum(mask))
        percentage = round(count / total * 100, 1) if total else 0.0
        legend.append(
            {
                "cluster": cluster,
                "name": str(classify_assignments[cluster]["name"]),
                "color": list(classify_assignments[cluster]["color"]),
                "min": lo,
                "max": hi,
                "count": count,
                "percentage": percentage,
                "label": f"{classify_assignments[cluster]['name']}-{count / total * 100.0:.1f}%",
            }
        )
        labels_from_ranges[(gray >= lo) & (gray <= hi)] = cluster
    # display image exactly as ui.apply_cluster_assignments builds it (BGR order),
    # cross-checked against the pure desktop helper build_cluster_display_image
    display = np.zeros((gray.shape[0], gray.shape[1], 3), dtype=np.uint8)
    for cluster, (lo, hi) in classify_ranges.items():
        color = tuple(int(c) for c in classify_assignments[cluster]["color"])
        display[(gray >= lo) & (gray <= hi)] = (color[2], color[1], color[0])
    assert np.array_equal(display, ui.build_cluster_display_image(labels_from_ranges, classify_assignments))
    save_png("classify_display.png", display)
    expected["classify"] = {
        "ranges": {str(c): list(r) for c, r in classify_ranges.items()},
        "assignments": {str(c): {"name": v["name"], "color": list(v["color"])} for c, v in classify_assignments.items()},
        "legend": legend,
    }

    # ---------------- GCH2 Huffman ----------------
    gch_path = FIXTURES / "sample_color.gch"
    info = ui.compress_color_image_huffman(sample, gch_path)
    data = gch_path.read_bytes()
    import struct

    rows, cols, channels, payload_bits, version = struct.unpack("<IIIII", data[4:24])
    freqs = list(struct.unpack("<256I", data[24:24 + 1024]))
    roundtrip, meta = ui.decompress_color_image_huffman(gch_path)
    assert np.array_equal(roundtrip, sample), "desktop GCH2 round-trip failed"
    expected["huffman"] = {
        "rows": rows,
        "cols": cols,
        "channels": channels,
        "payload_bits": payload_bits,
        "version": version,
        "magic": data[:4].decode("ascii"),
        "header_hex": data[:24].hex(),
        "file_bytes": len(data),
        "original_bytes": int(info["original_bytes"]),
        "compressed_bytes": int(info["compressed_bytes"]),
        "frequencies_sha256_input": None,
        "unique_values": int(sum(1 for f in freqs if f > 0)),
        "roundtrip_ok": True,
    }

    # grayscale GCH2 variant (single-channel path)
    gch_gray = FIXTURES / "gray_sample.gch"
    ui.compress_color_image_huffman(gray, gch_gray)
    gray_data = gch_gray.read_bytes()
    rows_g, cols_g, channels_g, bits_g, version_g = struct.unpack("<IIIII", gray_data[4:24])
    expected["huffman_gray"] = {
        "rows": rows_g,
        "cols": cols_g,
        "channels": channels_g,
        "payload_bits": bits_g,
        "version": version_g,
        "header_hex": gray_data[:24].hex(),
        "file_bytes": len(gray_data),
    }
    assert np.array_equal(ui.decompress_color_image_huffman(gch_gray)[0], gray)

    with (FIXTURES / "expected_values.json").open("w", encoding="utf-8") as fh:
        json.dump(expected, fh, indent=2, sort_keys=True)
    print("fixtures written to", FIXTURES)
    print("kmeans k5:", expected["kmeans_k5"]["ranges"], expected["kmeans_k5"]["centroids"])


if __name__ == "__main__":
    main()
