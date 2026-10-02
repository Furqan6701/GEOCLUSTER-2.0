"""Statistics and histogram, matching the desktop's math.

Desktop references (desktop/frontend/ui.py):
  * statistics      -> np.min / np.max / np.mean / np.std on to_grayscale(image)
  * histogram       -> HistogramWindow._gray_values (grayscale intensities)
                       with the default 256 bins
"""

from __future__ import annotations

import numpy as np

from .errors import GeoclusterError
from .filters import to_grayscale

Array = np.ndarray


def statistics(gray: Array) -> dict[str, float | int]:
    if not isinstance(gray, np.ndarray) or gray.ndim != 2:
        raise GeoclusterError("Statistics expect a 2-D grayscale image.")
    return {
        "min": int(np.min(gray)),
        "max": int(np.max(gray)),
        "mean": float(np.mean(gray)),
        "std": float(np.std(gray)),
    }


def histogram256(gray: Array) -> list[int]:
    if not isinstance(gray, np.ndarray) or gray.ndim != 2:
        raise GeoclusterError("Histogram expects a 2-D grayscale image.")
    return np.bincount(gray.reshape(-1), minlength=256).astype(np.int64).tolist()


def analyze(image: Array) -> tuple[Array, dict[str, float | int], list[int]]:
    """Convenience helper: grayscale view + statistics + histogram."""
    gray = to_grayscale(image)
    return gray, statistics(gray), histogram256(gray)
