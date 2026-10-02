"""NumPy implementation of the desktop K-Means (intensity-histogram LUT).

Ported from desktop/frontend/backend_py.py::run_kmeans, with torch replaced by
NumPy. The algorithm is otherwise identical:

  * initialization: centroid of every initial range, i.e. (low + high) / 2
    (the desktop UI passes calculate_default_ranges(K) as `ranges`)
  * assignment:     each of the 256 possible intensities is assigned to the
    nearest centroid (first-minimum tie-break) via a LUT, then pixels look up
    their label - this is exactly what makes it an intensity histogram method
  * update:         centroid := mean intensity of its members (empty clusters
    keep their previous centroid)
  * convergence:    max |new - old| < 0.5, maximum 30 iterations by default
  * output ranges:  midpoints between sorted final centroids; first range
    starts at 0, last range ends at 255
  * output labels:  pixels are labeled by the final RANGES (not by the LUT),
    matching backend_py.run_kmeans's final masking pass

The floating-point work is all float64 over integer sums, so the results are
independent of accumulation order (torch and NumPy agree bit-for-bit).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .classify import calculate_default_ranges
from .errors import KMeansError

DEFAULT_MAX_ITER = 30
TOLERANCE = 0.5
MIN_CLUSTERS = 2
MAX_CLUSTERS = 20  # the desktop K-Means dialog offers 2..20

Array = np.ndarray


@dataclass(frozen=True)
class KMeansOutcome:
    labels: Array
    centroids: list[float]
    ranges: list[tuple[int, int]]
    counts: list[int]
    iterations: int
    converged: bool

    @property
    def ranges_dict(self) -> dict[int, tuple[int, int]]:
        return {index: value for index, value in enumerate(self.ranges)}


def run_kmeans(
    gray: Array,
    k: int,
    ranges: Sequence[tuple[int, int]] | None = None,
    max_iter: int = DEFAULT_MAX_ITER,
    tolerance: float = TOLERANCE,
) -> KMeansOutcome:
    """Cluster a 2-D uint8 grayscale image into `k` intensity clusters."""
    if not isinstance(gray, np.ndarray) or gray.ndim != 2:
        raise KMeansError("K-Means expects a 2-D grayscale image.")
    if gray.dtype != np.uint8:
        raise KMeansError("K-Means expects uint8 pixel data.")
    k = int(k)
    if not MIN_CLUSTERS <= k <= MAX_CLUSTERS:
        raise KMeansError(f"Cluster count must be between {MIN_CLUSTERS} and {MAX_CLUSTERS}.")
    max_iter = int(max_iter)
    if max_iter < 1:
        raise KMeansError("max_iter must be at least 1.")

    init_ranges = list(ranges) if ranges else calculate_default_ranges(k)
    if len(init_ranges) != k:
        raise KMeansError("Number of ranges must match the cluster count.")

    source = gray
    centroids = np.asarray([(low + high) / 2.0 for low, high in init_ranges], dtype=np.float64)
    intensities = np.arange(256, dtype=np.float64)

    iterations_run = 0
    converged = False
    for iteration in range(max_iter):
        iterations_run = iteration + 1
        lut = np.argmin(np.abs(intensities[:, None] - centroids[None, :]), axis=1)
        labels = lut[source.astype(np.int64)]
        flat_labels = labels.reshape(-1)
        counts = np.bincount(flat_labels, minlength=k).astype(np.float64)
        sums = np.bincount(flat_labels, weights=source.reshape(-1).astype(np.float64), minlength=k)
        new_centroids = centroids.copy()
        non_empty = counts > 0
        new_centroids[non_empty] = sums[non_empty] / counts[non_empty]
        max_shift = float(np.max(np.abs(new_centroids - centroids))) if bool(np.any(non_empty)) else 0.0
        centroids = new_centroids
        if max_shift < float(tolerance):
            converged = True
            break

    centroids_sorted = sorted(float(value) for value in centroids)
    final_ranges: list[tuple[int, int]] = []
    for index in range(k):
        low = 0 if index == 0 else int((centroids_sorted[index - 1] + centroids_sorted[index]) / 2.0) + 1
        high = 255 if index == k - 1 else int((centroids_sorted[index] + centroids_sorted[index + 1]) / 2.0)
        final_ranges.append((low, high))

    output = np.zeros(source.shape, dtype=np.uint8)
    counts_final: list[int] = [0] * k
    for cluster_index, (low, high) in enumerate(final_ranges):
        mask = (source >= low) & (source <= high)
        output[mask] = cluster_index
        counts_final[cluster_index] = int(mask.sum())

    return KMeansOutcome(
        labels=output,
        centroids=centroids_sorted,
        ranges=final_ranges,
        counts=counts_final,
        iterations=iterations_run,
        converged=converged,
    )
