"""Cluster ranges, default assignments and recoloring.

Ported from desktop/frontend/ui.py:
  * calculate_default_ranges      (even 0..255 partition)
  * default_cluster_assignments   (curated six-cluster preset, otherwise HSV)
  * default_cluster_ranges        (curated six-cluster ranges, otherwise even)
  * build_cluster_display_image   (label -> color preview, BGR byte order)
  * apply_cluster_assignments     (range -> color recolor, BGR byte order)
  * _recalculate_counts / generate_map legend math

Qt is replaced by plain RGB tuples; `qt_hsv_to_rgb` reproduces
QColor.fromHsv(h, 180, 220) exactly (verified against PyQt5 for every hue
0..359 during fixture generation), because the desktop uses that call for
non-six-cluster palettes.
"""

from __future__ import annotations

from typing import Mapping, Sequence

import numpy as np

from .errors import ClassificationError

Array = np.ndarray

SIX_CLUSTER_DEFAULTS = [
    {"cluster": 0, "min": 0, "max": 69, "land_cover": "Shadows", "color": (0, 0, 0)},
    {"cluster": 1, "min": 70, "max": 85, "land_cover": "Dark Trees / Forest", "color": (0, 180, 0)},
    {"cluster": 2, "min": 86, "max": 130, "land_cover": "Buildings / Rooftops", "color": (128, 128, 128)},
    {"cluster": 3, "min": 131, "max": 145, "land_cover": "Bare Soil / Ground", "color": (100, 200, 0)},
    {"cluster": 4, "min": 146, "max": 216, "land_cover": "Grass / Lawn", "color": (180, 180, 180)},
    {"cluster": 5, "min": 217, "max": 255, "land_cover": "Buildings / Rooftops", "color": (255, 255, 255)},
]

CLUSTER_NAMES = [
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


def calculate_default_ranges(k: int) -> list[tuple[int, int]]:
    """ui.calculate_default_ranges: split 0..255 into k contiguous buckets."""
    k = int(k)
    if k < 1:
        raise ClassificationError("Cluster count must be positive.")
    ranges: list[tuple[int, int]] = []
    step = 256 / k
    for index in range(k):
        min_value = int(index * step)
        max_value = int((index + 1) * step) - 1
        if index == k - 1:
            max_value = 255
        ranges.append((min_value, max_value))
    return ranges


def qt_hsv_to_rgb(hue: int, saturation: int = 180, value: int = 220) -> tuple[int, int, int]:
    """Exactly reproduce QColor.fromHsv(hue, saturation, value)."""
    if saturation == 0:
        return (value, value, value)
    hue = int(hue) % 360
    if hue < 0:
        hue += 360
    hd = hue / 60.0
    sector = int(hd)
    frac = hd - sector
    p = int(round(value * (255 - saturation) / 255.0))
    q = int(round(value * (255 - saturation * frac) / 255.0))
    t = int(round(value * (255 - saturation * (1 - frac)) / 255.0))
    return [
        (value, t, p),
        (q, value, p),
        (p, value, t),
        (p, q, value),
        (t, p, value),
        (value, p, q),
    ][sector % 6]


def default_cluster_assignments(cluster_keys: Sequence[int]) -> dict[int, dict[str, object]]:
    """ui.default_cluster_assignments (the unused `method` parameter was dropped)."""
    sorted_clusters = sorted(int(key) for key in cluster_keys)
    if len(sorted_clusters) == 6:
        return {
            cluster: {
                "name": SIX_CLUSTER_DEFAULTS[index]["land_cover"],
                "color": SIX_CLUSTER_DEFAULTS[index]["color"],
            }
            for index, cluster in enumerate(sorted_clusters)
        }
    assignments: dict[int, dict[str, object]] = {}
    count = len(sorted_clusters)
    for index, cluster in enumerate(sorted_clusters):
        color = qt_hsv_to_rgb(int(index * 255 / max(count, 1)))
        assignments[cluster] = {
            "name": CLUSTER_NAMES[index] if index < len(CLUSTER_NAMES) else "Other",
            "color": color,
        }
    return assignments


def default_cluster_ranges(cluster_keys: Sequence[int]) -> dict[int, tuple[int, int]]:
    """ui.default_cluster_ranges: curated ranges for six clusters, else even split."""
    sorted_clusters = sorted(int(key) for key in cluster_keys)
    if len(sorted_clusters) == 6:
        return {
            cluster: (SIX_CLUSTER_DEFAULTS[index]["min"], SIX_CLUSTER_DEFAULTS[index]["max"])
            for index, cluster in enumerate(sorted_clusters)
        }
    calculated = calculate_default_ranges(max(1, len(sorted_clusters)))
    return {cluster: calculated[index] for index, cluster in enumerate(sorted_clusters)}


def _normalize_assignments(assignments: Mapping[int, Mapping[str, object]]) -> dict[int, dict[str, object]]:
    normalized: dict[int, dict[str, object]] = {}
    for key, value in assignments.items():
        name = str(value.get("name", "Other"))
        raw_color = value.get("color")
        if not isinstance(raw_color, (list, tuple)) or len(raw_color) != 3:
            raise ClassificationError(f"Cluster {key} has an invalid color; expected [r, g, b].")
        try:
            color = tuple(int(channel) for channel in raw_color)  # type: ignore[arg-type]
        except (TypeError, ValueError) as exc:
            raise ClassificationError(f"Cluster {key} has a non-integer color.") from exc
        if any(not 0 <= channel <= 255 for channel in color):
            raise ClassificationError(f"Cluster {key} color components must be between 0 and 255.")
        normalized[int(key)] = {"name": name, "color": color}
    return normalized


def _normalize_ranges(ranges: Mapping[int, Sequence[int]]) -> dict[int, tuple[int, int]]:
    normalized: dict[int, tuple[int, int]] = {}
    for key, value in ranges.items():
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise ClassificationError(f"Cluster {key} range must be [min, max].")
        low, high = int(value[0]), int(value[1])  # type: ignore[index]
        if not 0 <= low <= 255 or not 0 <= high <= 255:
            raise ClassificationError(f"Cluster {key} range must stay within 0..255.")
        if low > high:
            raise ClassificationError(f"Cluster {key} has min greater than max.")
        normalized[int(key)] = (low, high)
    return normalized


def recolor_by_labels(labels: Array, assignments: Mapping[int, Mapping[str, object]]) -> Array:
    """ui.build_cluster_display_image: label map -> BGR preview image."""
    normalized = _normalize_assignments(assignments)
    if labels.ndim != 2:
        raise ClassificationError("Labels must be a 2-D array.")
    height, width = labels.shape
    display = np.zeros((height, width, 3), dtype=np.uint8)
    for cluster, config in normalized.items():
        color = config["color"]
        display[labels == cluster] = (color[2], color[1], color[0])  # type: ignore[index]
    return display


def recolor_by_ranges(
    gray: Array,
    ranges: Mapping[int, Sequence[int]],
    assignments: Mapping[int, Mapping[str, object]],
) -> Array:
    """ui.apply_cluster_assignments: grayscale pixels -> BGR classification image."""
    normalized_ranges = _normalize_ranges(ranges)
    normalized_assignments = _normalize_assignments(assignments)
    if gray.ndim != 2:
        raise ClassificationError("Classification expects a 2-D grayscale image.")
    display = np.zeros((gray.shape[0], gray.shape[1], 3), dtype=np.uint8)
    for cluster in sorted(normalized_ranges):
        if cluster not in normalized_assignments:
            raise ClassificationError(f"Cluster {cluster} has a range but no assignment.")
        low, high = normalized_ranges[cluster]
        color = normalized_assignments[cluster]["color"]
        mask = (gray >= low) & (gray <= high)
        display[mask] = (color[2], color[1], color[0])  # type: ignore[index]
    return display


def legend_percentages(
    gray_flat: Array,
    ranges: Mapping[int, Sequence[int]],
    assignments: Mapping[int, Mapping[str, object]],
) -> list[dict[str, object]]:
    """ui._recalculate_counts / ui.generate_map legend math, as structured data."""
    normalized_ranges = _normalize_ranges(ranges)
    normalized_assignments = _normalize_assignments(assignments)
    total = int(gray_flat.size)
    legend: list[dict[str, object]] = []
    for cluster in sorted(normalized_ranges):
        if cluster not in normalized_assignments:
            raise ClassificationError(f"Cluster {cluster} has a range but no assignment.")
        low, high = normalized_ranges[cluster]
        count = int(np.sum((gray_flat >= low) & (gray_flat <= high)))
        percentage = round(count / total * 100, 1) if total else 0.0
        entry = normalized_assignments[cluster]
        legend.append(
            {
                "cluster": cluster,
                "name": entry["name"],
                "color": list(entry["color"]),  # type: ignore[arg-type]
                "min": low,
                "max": high,
                "count": count,
                "percentage": percentage,
                "label": f"{entry['name']}-{count / total * 100.0:.1f}%" if total else f"{entry['name']}-0.0%",
            }
        )
    return legend
