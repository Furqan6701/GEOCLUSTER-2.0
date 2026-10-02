"""Golden tests: classification recolor, legend percentages and defaults."""

from __future__ import annotations

import numpy as np
import pytest

from geocluster.classify import (
    SIX_CLUSTER_DEFAULTS,
    calculate_default_ranges,
    default_cluster_assignments,
    default_cluster_ranges,
    legend_percentages,
    recolor_by_ranges,
    qt_hsv_to_rgb,
)


def _inputs(expected):
    ranges = {int(key): tuple(value) for key, value in expected["classify"]["ranges"].items()}
    assignments = {
        int(key): {"name": value["name"], "color": tuple(value["color"])}
        for key, value in expected["classify"]["assignments"].items()
    }
    return ranges, assignments


def test_recolor_matches_desktop_fixture(fixtures_dir, gray_sample, expected):
    import cv2

    ranges, assignments = _inputs(expected)
    produced = recolor_by_ranges(gray_sample, ranges, assignments)
    golden = cv2.imread(str(fixtures_dir / "classify_display.png"), cv2.IMREAD_UNCHANGED)
    assert np.array_equal(produced, golden)


def test_legend_matches_desktop_fixture(gray_sample, expected):
    ranges, assignments = _inputs(expected)
    legend = legend_percentages(gray_sample.reshape(-1), ranges, assignments)
    assert legend == expected["classify"]["legend"]


def test_legend_percentages_sum_to_about_100(gray_sample, expected):
    ranges, assignments = _inputs(expected)
    legend = legend_percentages(gray_sample.reshape(-1), ranges, assignments)
    assert sum(entry["count"] for entry in legend) == gray_sample.size
    assert abs(sum(entry["percentage"] for entry in legend) - 100.0) < 0.5


def test_default_ranges_for_six_clusters_use_the_curated_preset():
    ranges = default_cluster_ranges(range(6))
    assert ranges[0] == (0, 69)
    assert ranges[5] == (217, 255)
    assert [SIX_CLUSTER_DEFAULTS[key]["land_cover"] for key in range(6)] == [
        "Shadows",
        "Dark Trees / Forest",
        "Buildings / Rooftops",
        "Bare Soil / Ground",
        "Grass / Lawn",
        "Buildings / Rooftops",
    ]


def test_default_ranges_for_other_counts_are_even():
    assert default_cluster_ranges(range(5)) == {0: (0, 50), 1: (51, 101), 2: (102, 152), 3: (153, 203), 4: (204, 255)}
    assert calculate_default_ranges(2) == [(0, 127), (128, 255)]


def test_hsv_conversion_matches_qt_values():
    # Values cross-checked against PyQt5 QColor.fromHsv during fixture generation.
    assert qt_hsv_to_rgb(0) == (220, 65, 65)
    assert qt_hsv_to_rgb(51) == (220, 197, 65)
    assert qt_hsv_to_rgb(102) == (111, 220, 65)
    assert qt_hsv_to_rgb(204) == (65, 158, 220)


def test_recolor_uses_bgr_byte_order():
    gray = np.array([[0, 255]], dtype=np.uint8)
    ranges = {0: (0, 100), 1: (101, 255)}
    assignments = {0: {"name": "dark", "color": (10, 20, 30)}, 1: {"name": "light", "color": (40, 50, 60)}}
    produced = recolor_by_ranges(gray, ranges, assignments)
    # desktop stores colors as BGR in the display image: (b, g, r)
    assert produced[0, 0].tolist() == [30, 20, 10]
    assert produced[0, 1].tolist() == [60, 50, 40]


def test_classification_validation_errors(gray_sample):
    from geocluster.errors import ClassificationError

    with pytest.raises(ClassificationError):
        recolor_by_ranges(gray_sample, {0: (100, 50)}, {0: {"name": "x", "color": (1, 2, 3)}})
    with pytest.raises(ClassificationError):
        recolor_by_ranges(gray_sample, {0: (0, 100)}, {0: {"name": "x", "color": (300, 0, 0)}})
    with pytest.raises(ClassificationError):
        recolor_by_ranges(gray_sample, {0: (0, 100)}, {})
