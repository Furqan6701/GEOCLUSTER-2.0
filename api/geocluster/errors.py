"""Shared exception types for the geocluster package."""

from __future__ import annotations


class GeoclusterError(Exception):
    """Base class for processing errors that map to HTTP 4xx/5xx responses."""


class ImageValidationError(GeoclusterError):
    """Uploaded data is not a supported/decodable image."""


class FilterError(GeoclusterError):
    """Invalid parameters or layout for a filter operation."""


class KMeansError(GeoclusterError):
    """Invalid K-Means input."""


class ClassificationError(GeoclusterError):
    """Invalid classification ranges/assignments."""


class HuffmanError(GeoclusterError):
    """Invalid or corrupted GCH2 payload."""


class AssistantUnavailable(GeoclusterError):
    """GROQ_API_KEY is not configured (the legacy FIREWORKS_API_KEY name is also read)."""


class AssistantProviderError(GeoclusterError):
    """The AI provider call failed."""


class SatelliteUnavailable(GeoclusterError):
    """Copernicus credentials are not configured."""


class SatelliteError(GeoclusterError):
    """A Copernicus request failed."""


class SatelliteNetworkError(SatelliteError):
    """Copernicus could not be reached: connection failures and timeouts, after retries."""


class SatelliteCredentialsError(SatelliteError):
    """Copernicus rejected the client ID or client secret."""


class SessionNotFound(GeoclusterError):
    """Unknown or expired session id."""


class ImageNotFound(GeoclusterError):
    """Unknown image id within a session."""


class SessionLimitError(GeoclusterError):
    """A session/memory limit would be exceeded and cannot be evicted."""
