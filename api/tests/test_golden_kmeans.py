"""Golden tests: K-Means K=5 must reproduce the reference fixture.

Fixture provenance: torch is not installable in the build sandbox, so the
fixture was produced by a deliberately naive reference implementation of
backend_py.run_kmeans (see tests/fixtures/generate_fixtures.py and
expected_values.json -> kmeans_k5.generator). The port itself is a different,
vectorized implementation.
"""

from __future__ import annotations

import numpy as np

from geocluster import kmeans
from geocluster.classify import default_cluster_assignments, recolor_by_labels


def test_labels_match_fixture_on_every_pixel(fixtures_dir, gray_sample):
    outcome = kmeans.run_kmeans(gray_sample, 5)
    golden = np.load(fixtures_dir / "kmeans_k5_labels.npy")
    assert outcome.labels.shape == golden.shape
    matching = float(np.mean(outcome.labels == golden))
    assert matching >= 0.999, f"label agreement {matching:.4f} < 99.9%"
    assert matching == 1.0  # stronger than required: they are identical


def test_centroids_ranges_counts_match_fixture(expected, gray_sample):
    outcome = kmeans.run_kmeans(gray_sample, 5)
    golden = expected["kmeans_k5"]
    assert len(outcome.centroids) == 5
    for produced, reference in zip(outcome.centroids, golden["centroids"]):
        assert abs(produced - reference) < 1e-9
    assert [list(r) for r in outcome.ranges] == golden["ranges"]
    assert outcome.counts == golden["counts"]
    assert outcome.iterations == golden["iterations"]
    assert outcome.converged == golden["converged"]
    assert sum(outcome.counts) == gray_sample.size


def test_display_image_matches_fixture(fixtures_dir, gray_sample):
    import cv2

    outcome = kmeans.run_kmeans(gray_sample, 5)
    display = recolor_by_labels(outcome.labels, default_cluster_assignments(range(5)))
    golden = cv2.imread(str(fixtures_dir / "kmeans_k5_display.png"), cv2.IMREAD_UNCHANGED)
    assert np.array_equal(display, golden)


def test_assignments_use_the_qt_hsv_palette(expected):
    assignments = default_cluster_assignments(range(5))
    for cluster in range(5):
        assert list(assignments[cluster]["color"]) == expected["kmeans_k5_assignments"][str(cluster)]["color"]
        assert assignments[cluster]["name"] == expected["kmeans_k5_assignments"][str(cluster)]["name"]


def test_kmeans_is_deterministic(gray_sample):
    first = kmeans.run_kmeans(gray_sample, 5)
    second = kmeans.run_kmeans(gray_sample, 5)
    assert np.array_equal(first.labels, second.labels)
    assert first.centroids == second.centroids


def test_six_clusters_use_the_curated_preset(gray_sample):
    outcome = kmeans.run_kmeans(gray_sample, 6)
    assignments = default_cluster_assignments(range(6))
    assert assignments[0]["name"] == "Shadows"
    assert assignments[0]["color"] == (0, 0, 0)
    assert assignments[5]["color"] == (255, 255, 255)
    assert outcome.labels.max() == 5


def test_initial_ranges_are_the_desktop_defaults():
    assert kmeans.calculate_default_ranges(5) == [(0, 50), (51, 101), (102, 152), (153, 203), (204, 255)]


def test_kmeans_rejects_bad_input(gray_sample):
    import pytest

    from geocluster.errors import KMeansError

    with pytest.raises(KMeansError):
        kmeans.run_kmeans(gray_sample, 1)
    with pytest.raises(KMeansError):
        kmeans.run_kmeans(gray_sample, 21)
    with pytest.raises(KMeansError):
        kmeans.run_kmeans(np.zeros((4, 4), dtype=np.uint16), 3)
