"""Pydantic request/response models."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

if TYPE_CHECKING:  # pragma: no cover - typing only
    from sessions import StoredImage

FORBID_EXTRA = ConfigDict(extra="forbid")


class SessionOut(BaseModel):
    session_id: str
    ttl_minutes: float
    max_images: int


class ImageOut(BaseModel):
    image_id: str
    session_id: str
    name: str
    source: str
    width: int
    height: int
    channels: int
    megapixels: float
    bytes: int
    original_width: int
    original_height: int
    original_megapixels: float
    scale: float
    downscaled: bool
    # ground scale (satellite imagery): [west, south, east, north] and the
    # metres one stored pixel covers. None for uploads / unknown scales.
    bbox: Optional[list[float]] = None
    meters_per_pixel: Optional[float] = None

    @classmethod
    def from_stored(cls, session_id: str, stored: "StoredImage") -> "ImageOut":
        return cls(
            image_id=stored.image_id,
            session_id=session_id,
            name=stored.name,
            source=stored.source,
            width=stored.width,
            height=stored.height,
            channels=stored.channels,
            megapixels=round(stored.megapixels, 4),
            bytes=stored.nbytes,
            original_width=stored.original_size[0],
            original_height=stored.original_size[1],
            original_megapixels=round(stored.original_size[0] * stored.original_size[1] / 1_000_000.0, 4),
            scale=round(stored.scale, 6),
            downscaled=stored.scale != 1.0,
            bbox=list(stored.bbox) if stored.bbox else None,
            meters_per_pixel=(
                round(float(stored.meters_per_pixel), 6)
                if stored.meters_per_pixel is not None
                else None
            ),
        )


class EmptyRequest(BaseModel):
    model_config = FORBID_EXTRA


class BrightnessRequest(BaseModel):
    model_config = FORBID_EXTRA
    value: int = Field(..., ge=-255, le=255, description="Brightness delta (-255..255)")


class ThresholdRequest(BaseModel):
    model_config = FORBID_EXTRA
    value: int = Field(..., ge=0, le=255, description="Threshold value (0..255)")


class MeanFilterRequest(BaseModel):
    model_config = FORBID_EXTRA
    window: int = Field(3, ge=3, le=31, description="Odd window size (3..31)")

    @field_validator("window")
    @classmethod
    def _odd_window(cls, value: int) -> int:
        if value % 2 == 0:
            raise ValueError("window must be an odd number")
        return value


class KMeansRequest(BaseModel):
    model_config = FORBID_EXTRA
    k: int = Field(..., ge=2, le=20, description="Number of clusters (2..20)")
    max_iter: int = Field(
        30,
        ge=1,
        le=200,
        validation_alias=AliasChoices("max_iter", "maxIter"),
        description="Maximum Lloyd iterations (desktop default: 30)",
    )


class ClusterAssignment(BaseModel):
    model_config = FORBID_EXTRA
    name: str = Field(..., min_length=1, max_length=64)
    color: list[int] = Field(..., min_length=3, max_length=3, description="RGB triplet 0..255")

    @field_validator("color")
    @classmethod
    def _valid_color(cls, value: list[int]) -> list[int]:
        if any(component < 0 or component > 255 for component in value):
            raise ValueError("color components must be between 0 and 255")
        return value


class ClassifyRequest(BaseModel):
    model_config = FORBID_EXTRA
    ranges: dict[int, list[int]] = Field(..., description="cluster id -> [min, max]")
    assignments: dict[int, ClusterAssignment] = Field(..., description="cluster id -> name/color")

    @field_validator("ranges")
    @classmethod
    def _valid_ranges(cls, value: dict[int, list[int]]) -> dict[int, list[int]]:
        if not value:
            raise ValueError("at least one range is required")
        for cluster, pair in value.items():
            if len(pair) != 2:
                raise ValueError(f"cluster {cluster} range must be [min, max]")
            low, high = pair
            if not 0 <= low <= 255 or not 0 <= high <= 255 or low > high:
                raise ValueError(f"cluster {cluster} range must satisfy 0 <= min <= max <= 255")
        return value


class RangeOut(BaseModel):
    cluster: int
    min: int
    max: int
    count: int


class KMeansResponse(BaseModel):
    k: int
    iterations: int
    converged: bool
    centroids: list[float]
    ranges: list[RangeOut]
    counts: list[int]
    labels_image_id: str
    display_image_id: str
    assignments: dict[int, ClusterAssignment]


class LegendEntry(BaseModel):
    cluster: int
    name: str
    color: list[int]
    min: int
    max: int
    count: int
    percentage: float
    label: str


class ClassifyResponse(BaseModel):
    image_id: str
    legend: list[LegendEntry]


class HistogramResponse(BaseModel):
    bins: list[int]


class StatsResponse(BaseModel):
    min: int
    max: int
    mean: float
    std: float


class SatelliteFetchRequest(BaseModel):
    model_config = FORBID_EXTRA
    session_id: str = Field(..., min_length=1)
    location: str = Field(..., min_length=1, max_length=120)
    start: Optional[str] = Field(None, description="Optional ISO date (YYYY-MM-DD)")
    end: Optional[str] = Field(None, description="Optional ISO date (YYYY-MM-DD)")


class ChatRequest(BaseModel):
    model_config = FORBID_EXTRA
    message: str = Field(..., min_length=1, max_length=2000)


class ChatResponse(BaseModel):
    intent: str
    reply: Optional[str] = None
    commands: list[dict[str, Any]] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    ai_configured: bool
    satellite_configured: bool
    max_image_megapixels: float


class HuffmanMeta(BaseModel):
    rows: int
    cols: int
    channels: int
    payload_bits: int
    original_bytes: int
    compressed_bytes: int
    unique_values: int


class ErrorResponse(BaseModel):
    detail: str
