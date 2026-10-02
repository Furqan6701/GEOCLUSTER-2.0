"""Golden tests: every filter must be pixel-identical to the desktop output."""

from __future__ import annotations

import numpy as np
import pytest

from geocluster import filters


def load(fixtures_dir, name):
    import cv2

    image = cv2.imread(str(fixtures_dir / name), cv2.IMREAD_UNCHANGED)
    assert image is not None
    return image


@pytest.mark.parametrize(
    "fixture,produce",
    [
        ("gray_sample.png", lambda img: filters.to_grayscale(img)),
        ("negative_sample.png", lambda img: filters.negative(img)),
        ("brightness_p40_sample.png", lambda img: filters.brightness(img, 40)),
        ("brightness_m40_sample.png", lambda img: filters.brightness(img, -40)),
        ("threshold128_sample.png", lambda img: filters.threshold(img, 128)),
        ("mean3_sample.png", lambda img: filters.mean_filter(img, 3)),
        ("mean5_sample.png", lambda img: filters.mean_filter(img, 5)),
        ("laplacian_sample.png", lambda img: filters.laplacian(img)),
    ],
)
def test_sample_filters_match_desktop(fixtures_dir, sample, fixture, produce):
    produced = produce(sample)
    golden = load(fixtures_dir, fixture)
    assert produced.shape == golden.shape
    assert produced.dtype == golden.dtype
    assert np.array_equal(produced, golden), f"{fixture} differs from the desktop output"


@pytest.mark.parametrize(
    "fixture,produce",
    [
        ("alpha_gray.png", lambda img: filters.to_grayscale(img)),
        ("alpha_negative.png", lambda img: filters.negative(img)),
        ("alpha_brightness_p40.png", lambda img: filters.brightness(img, 40)),
        ("alpha_threshold128.png", lambda img: filters.threshold(img, 128)),
        ("alpha_mean3.png", lambda img: filters.mean_filter(img, 3)),
        ("alpha_laplacian.png", lambda img: filters.laplacian(img)),
    ],
)
def test_alpha_filters_match_desktop(fixtures_dir, alpha_sample, fixture, produce):
    produced = produce(alpha_sample)
    golden = load(fixtures_dir, fixture)
    assert np.array_equal(produced, golden), f"{fixture} differs from the desktop output"


def test_alpha_channel_is_preserved(alpha_sample):
    alpha_channel = alpha_sample[:, :, 3]
    assert np.array_equal(filters.negative(alpha_sample)[:, :, 3], alpha_channel)
    assert np.array_equal(filters.brightness(alpha_sample, 40)[:, :, 3], alpha_channel)
    assert np.array_equal(filters.threshold(alpha_sample, 128)[:, :, 3], alpha_channel)
    assert np.array_equal(filters.mean_filter(alpha_sample, 3)[:, :, 3], alpha_channel)


def test_brightness_saturates_and_never_wraps():
    image = np.array([[0, 200], [250, 255]], dtype=np.uint8)
    assert filters.brightness(image, 40).tolist() == [[40, 240], [255, 255]]
    assert filters.brightness(image, -40).tolist() == [[0, 160], [210, 215]]


def test_threshold_is_strictly_greater():
    image = np.array([[127, 128]], dtype=np.uint8)
    assert filters.threshold(image, 127).tolist() == [[0, 255]]


def test_mean_filter_validates_window():
    from geocluster.errors import FilterError

    image = np.zeros((4, 4), dtype=np.uint8)
    with pytest.raises(FilterError):
        filters.mean_filter(image, 4)
    with pytest.raises(FilterError):
        filters.mean_filter(image, 1)


def test_laplacian_outputs_grayscale(sample):
    assert filters.laplacian(sample).ndim == 2
