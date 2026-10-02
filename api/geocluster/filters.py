"""Image filters, ported pixel-for-pixel from the desktop UI.

Source of truth: desktop/frontend/ui.py
  * to_grayscale        (ui.py  -> def to_grayscale)
  * negative            (ui.py  -> execute_operation "negative" branch)
  * brightness          (ui.py  -> execute_operation "brightness" branch)
  * threshold           (ui.py  -> def threshold_image)
  * mean_filter         (ui.py  -> execute_operation "meanfilter" branch)
  * laplacian           (ui.py  -> execute_operation "laplacian" branch)

The desktop has a second, subtly different implementation in
desktop/frontend/backend_py.py; where they disagree, ui.py wins.

Alpha handling (the important quirk): for 4-channel (BGRA) images the alpha
channel is *never* modified - only the first three channels are filtered.
"""

from __future__ import annotations

import cv2
import numpy as np

from .errors import FilterError

Array = np.ndarray


def to_grayscale(image: Array) -> Array:
    """ui.to_grayscale: 2-D passes through, BGRA drops alpha, then BGR2GRAY."""
    if image.ndim == 2:
        return image.copy()
    if image.ndim != 3:
        raise FilterError("Unsupported image layout for grayscale conversion.")
    if image.shape[2] == 4:
        base = image[:, :, :3]
    elif image.shape[2] == 3:
        base = image
    else:
        raise FilterError("Unsupported channel count for grayscale conversion.")
    return cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)


def negative(image: Array) -> Array:
    """ui.execute_operation("negative"): bitwise NOT, alpha preserved."""
    output = image.copy()
    if output.ndim == 2:
        return cv2.bitwise_not(output)
    if output.ndim == 3 and output.shape[2] == 4:
        output[:, :, :3] = cv2.bitwise_not(output[:, :, :3])
        return output
    if output.ndim == 3 and output.shape[2] == 3:
        return cv2.bitwise_not(output)
    raise FilterError("Unsupported image layout for negative.")


def brightness(image: Array, value: int) -> Array:
    """ui.execute_operation("brightness"): add value, clip to 0..255."""
    value = int(value)
    if image.ndim == 2:
        return np.clip(image.astype(np.int16) + value, 0, 255).astype(np.uint8)
    if image.ndim == 3 and image.shape[2] == 4:
        adjusted = image.copy()
        adjusted[:, :, :3] = np.clip(adjusted[:, :, :3].astype(np.int16) + value, 0, 255).astype(np.uint8)
        return adjusted
    if image.ndim == 3 and image.shape[2] == 3:
        return np.clip(image.astype(np.int16) + value, 0, 255).astype(np.uint8)
    raise FilterError("Unsupported image layout for brightness.")


def threshold(image: Array, value: int) -> Array:
    """ui.threshold_image: cv2.THRESH_BINARY, alpha preserved."""
    value = int(value)
    if not 0 <= value <= 255:
        raise FilterError("Threshold value must be between 0 and 255.")
    if image.ndim == 2:
        _, output = cv2.threshold(image, value, 255, cv2.THRESH_BINARY)
        return output
    if image.ndim == 3 and image.shape[2] == 4:
        output = image.copy()
        _, output[:, :, :3] = cv2.threshold(image[:, :, :3], value, 255, cv2.THRESH_BINARY)
        return output
    if image.ndim == 3 and image.shape[2] == 3:
        _, output = cv2.threshold(image, value, 255, cv2.THRESH_BINARY)
        return output
    raise FilterError("Unsupported image layout for threshold.")


def mean_filter(image: Array, window: int) -> Array:
    """ui.execute_operation("meanfilter"): cv2.blur, alpha preserved."""
    window = int(window)
    if window < 3 or window % 2 == 0:
        raise FilterError("Mean filter window must be an odd number >= 3.")
    if image.ndim == 2:
        return cv2.blur(image, (window, window))
    if image.ndim == 3 and image.shape[2] == 4:
        output = image.copy()
        output[:, :, :3] = cv2.blur(image[:, :, :3], (window, window))
        return output
    if image.ndim == 3 and image.shape[2] == 3:
        return cv2.blur(image, (window, window))
    raise FilterError("Unsupported image layout for mean filter.")


def laplacian(image: Array) -> Array:
    """ui.execute_operation("laplacian"): convertScaleAbs(Laplacian(gray))."""
    gray = to_grayscale(image)
    return cv2.convertScaleAbs(cv2.Laplacian(gray, cv2.CV_64F))
