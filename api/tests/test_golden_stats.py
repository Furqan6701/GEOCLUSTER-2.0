"""Golden tests: statistics and the 256-bin histogram."""

from __future__ import annotations

import numpy as np

from geocluster.stats import histogram256, statistics


def test_sample_statistics_match_desktop(expected, gray_sample):
    values = statistics(gray_sample)
    golden = expected["stats_sample"]
    assert values["min"] == golden["min"]
    assert values["max"] == golden["max"]
    assert abs(values["mean"] - golden["mean"]) < 1e-9
    assert abs(values["std"] - golden["std"]) < 1e-9


def test_alpha_statistics_match_desktop(expected, alpha_sample):
    from geocluster.filters import to_grayscale

    values = statistics(to_grayscale(alpha_sample))
    golden = expected["stats_alpha"]
    assert values["min"] == golden["min"]
    assert values["max"] == golden["max"]
    assert abs(values["mean"] - golden["mean"]) < 1e-9
    assert abs(values["std"] - golden["std"]) < 1e-9


def test_histogram_is_256_bins_and_matches_desktop(expected, gray_sample):
    bins = histogram256(gray_sample)
    assert len(bins) == 256
    assert all(isinstance(value, int) for value in bins)
    assert sum(bins) == expected["histogram_sample_total"]
    assert bins[:32] == expected["histogram_sample_first32"]


def test_statistics_rejects_color_images(sample):
    from geocluster.errors import GeoclusterError

    import pytest

    with pytest.raises(GeoclusterError):
        statistics(sample)
