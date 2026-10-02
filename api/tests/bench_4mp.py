"""Timing report on a synthetic 4 MP image (not collected by pytest).

Run:  cd api && python tests/bench_4mp.py [output.json]
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from geocluster import filters, huffman, kmeans  # noqa: E402
from geocluster.classify import default_cluster_assignments, legend_percentages, recolor_by_ranges  # noqa: E402
from geocluster.stats import histogram256, statistics  # noqa: E402

SIZE = 2000  # 2000 x 2000 = 4.0 MP


def make_image(size: int = SIZE) -> np.ndarray:
    xx = np.linspace(0, 255, size, dtype=np.float32)[None, :]
    yy = np.linspace(0, 255, size, dtype=np.float32)[:, None]
    blue = ((xx + yy) / 2).astype(np.uint8)
    green = np.broadcast_to(yy, blue.shape).astype(np.uint8)
    red = np.broadcast_to(xx, blue.shape).astype(np.uint8)
    noise = (np.arange(size * size, dtype=np.uint8).reshape(size, size) % 17) * 3
    return np.dstack([blue, green, red + noise])


def timeit(func, *args, **kwargs):
    start = time.perf_counter()
    result = func(*args, **kwargs)
    return (time.perf_counter() - start) * 1000.0, result


def main() -> None:
    image = make_image()
    gray = filters.to_grayscale(image)
    timings: dict[str, float] = {}

    for name, func in [
        ("grayscale", lambda: filters.to_grayscale(image)),
        ("negative", lambda: filters.negative(image)),
        ("brightness", lambda: filters.brightness(image, 40)),
        ("threshold", lambda: filters.threshold(image, 128)),
        ("meanfilter_3", lambda: filters.mean_filter(image, 3)),
        ("meanfilter_5", lambda: filters.mean_filter(image, 5)),
        ("laplacian", lambda: filters.laplacian(image)),
    ]:
        timings[name], _ = timeit(func)

    timings["statistics"], _ = timeit(statistics, gray)
    timings["histogram256"], _ = timeit(histogram256, gray)

    timings["kmeans_k5"], outcome = timeit(kmeans.run_kmeans, gray, 5)
    ranges = outcome.ranges_dict
    assignments = default_cluster_assignments(range(5))
    timings["classify_recolor"], _ = timeit(recolor_by_ranges, gray, ranges, assignments)
    timings["classify_legend"], _ = timeit(legend_percentages, gray.reshape(-1), ranges, assignments)

    timings["huffman_compress"], (payload, meta) = timeit(huffman.compress, image)
    timings["huffman_decompress"], _ = timeit(huffman.decompress, payload)

    report = {
        "image": f"{SIZE}x{SIZE} ({SIZE * SIZE / 1e6:.1f} MP, 3-channel)",
        "timings_ms": {key: round(value, 1) for key, value in timings.items()},
        "kmeans": {
            "iterations": outcome.iterations,
            "converged": outcome.converged,
            "centroids": [round(value, 6) for value in outcome.centroids],
        },
        "huffman": {
            "payload_bits": meta["payload_bits"],
            "original_bytes": meta["original_bytes"],
            "compressed_bytes": meta["compressed_bytes"],
            "ratio": round(meta["original_bytes"] / meta["compressed_bytes"], 3),
        },
    }
    payload_json = json.dumps(report, indent=2)
    print(payload_json)
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(payload_json, encoding="utf-8")

    # round-trip sanity
    decoded, _ = huffman.decompress(payload)
    assert np.array_equal(decoded, image)
    assert np.array_equal(cv2.imdecode(cv2.imencode(".png", image)[1], cv2.IMREAD_UNCHANGED), image)


if __name__ == "__main__":
    main()
