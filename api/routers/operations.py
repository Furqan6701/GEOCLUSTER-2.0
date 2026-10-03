"""Per-image operations: filters, K-Means, classification, histogram, stats."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, ValidationError

import schemas
from dependencies import get_store, require_auth
from geocluster import filters, kmeans
from geocluster.classify import default_cluster_assignments, legend_percentages, recolor_by_labels, recolor_by_ranges
from geocluster.errors import ClassificationError, FilterError, GeoclusterError, KMeansError
from geocluster.stats import histogram256, statistics
from sessions import SessionStore, derive_ground_metadata

router = APIRouter(
    prefix="/sessions/{session_id}/images/{image_id}",
    tags=["operations"],
    dependencies=[Depends(require_auth)],
)

PARAMETERLESS = {"grayscale", "negative", "laplacian"}
MODEL_BY_OPERATION: dict[str, type[BaseModel] | None] = {
    "grayscale": None,
    "negative": None,
    "laplacian": None,
    "brightness": schemas.BrightnessRequest,
    "threshold": schemas.ThresholdRequest,
    "meanfilter": schemas.MeanFilterRequest,
}


@router.post("/operations/{operation}", status_code=201, response_model=schemas.ImageOut)
def run_operation(
    session_id: str,
    image_id: str,
    operation: str,
    raw_body: dict[str, Any] | None = Body(default=None),
    store: SessionStore = Depends(get_store),
) -> schemas.ImageOut:
    """Apply one filter. Body per operation: brightness {"value"}, threshold
    {"value"}, meanfilter {"window"}; grayscale/negative/laplacian take no body.
    """
    if operation not in MODEL_BY_OPERATION:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown operation '{operation}'. Supported: {sorted(MODEL_BY_OPERATION)}.",
        )
    expected = MODEL_BY_OPERATION[operation]
    payload: BaseModel | None = None
    if expected is None:
        if raw_body:
            raise HTTPException(status_code=422, detail=f"Operation '{operation}' takes no parameters.")
    else:
        if raw_body is None:
            raise HTTPException(
                status_code=422,
                detail=f"Operation '{operation}' requires a JSON body matching {expected.__name__}.",
            )
        try:
            payload = expected.model_validate(raw_body)
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail=exc.errors(include_url=False, include_context=False, include_input=False),
            ) from exc

    stored = store.get_image(session_id, image_id)
    try:
        if operation == "brightness":
            result = filters.brightness(stored.image, payload.value)
        elif operation == "threshold":
            result = filters.threshold(stored.image, payload.value)
        elif operation == "meanfilter":
            result = filters.mean_filter(stored.image, payload.window)  # type: ignore[union-attr]
        elif operation == "grayscale":
            result = filters.to_grayscale(stored.image)
        elif operation == "negative":
            result = filters.negative(stored.image)
        else:
            result = filters.laplacian(stored.image)
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    new_image = store.add_image(
        session_id,
        result,
        name=f"{stored.name}#{operation}",
        source=f"operation:{operation}",
        **derive_ground_metadata(stored, result.shape[1]),
    )
    return schemas.ImageOut.from_stored(session_id, new_image)


@router.post("/kmeans", response_model=schemas.KMeansResponse)
def run_kmeans(
    session_id: str,
    image_id: str,
    request: schemas.KMeansRequest,
    store: SessionStore = Depends(get_store),
) -> schemas.KMeansResponse:
    stored = store.get_image(session_id, image_id)
    gray = filters.to_grayscale(stored.image)
    try:
        outcome = kmeans.run_kmeans(gray, request.k, max_iter=request.max_iter)
    except KMeansError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    assignments = default_cluster_assignments(range(outcome.labels.max() + 1 if outcome.labels.size else 0))
    assignments = {
        cluster: assignments[cluster]
        for cluster in sorted(assignments)
    }
    display = recolor_by_labels(outcome.labels, assignments)

    labels_image = store.add_image(
        session_id,
        outcome.labels,
        name=f"{stored.name}#kmeans-labels",
        source="kmeans:labels",
        **derive_ground_metadata(stored, outcome.labels.shape[1]),
    )
    display_image = store.add_image(
        session_id,
        display,
        name=f"{stored.name}#kmeans-display",
        source="kmeans:display",
        **derive_ground_metadata(stored, display.shape[1]),
    )
    return schemas.KMeansResponse(
        k=request.k,
        iterations=outcome.iterations,
        converged=outcome.converged,
        centroids=outcome.centroids,
        ranges=[
            schemas.RangeOut(cluster=index, min=low, max=high, count=outcome.counts[index])
            for index, (low, high) in enumerate(outcome.ranges)
        ],
        counts=outcome.counts,
        labels_image_id=labels_image.image_id,
        display_image_id=display_image.image_id,
        assignments={
            cluster: schemas.ClusterAssignment(name=str(config["name"]), color=list(config["color"]))
            for cluster, config in assignments.items()
        },
    )


@router.post("/classify", response_model=schemas.ClassifyResponse)
def classify_image(
    session_id: str,
    image_id: str,
    request: schemas.ClassifyRequest,
    store: SessionStore = Depends(get_store),
) -> schemas.ClassifyResponse:
    stored = store.get_image(session_id, image_id)
    gray = filters.to_grayscale(stored.image)
    ranges = {cluster: tuple(pair) for cluster, pair in request.ranges.items()}
    assignments = {
        cluster: {"name": entry.name, "color": tuple(entry.color)}
        for cluster, entry in request.assignments.items()
    }
    try:
        display = recolor_by_ranges(gray, ranges, assignments)
        legend = legend_percentages(gray.reshape(-1), ranges, assignments)
    except ClassificationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    new_image = store.add_image(
        session_id,
        display,
        name=f"{stored.name}#classify",
        source="classify",
        **derive_ground_metadata(stored, display.shape[1]),
    )
    return schemas.ClassifyResponse(
        image_id=new_image.image_id,
        legend=[schemas.LegendEntry(**entry) for entry in legend],
    )


@router.get("/histogram", response_model=schemas.HistogramResponse)
def get_histogram(
    session_id: str,
    image_id: str,
    store: SessionStore = Depends(get_store),
) -> schemas.HistogramResponse:
    stored = store.get_image(session_id, image_id)
    gray = filters.to_grayscale(stored.image)
    return schemas.HistogramResponse(bins=histogram256(gray))


@router.get("/stats", response_model=schemas.StatsResponse)
def get_stats(
    session_id: str,
    image_id: str,
    store: SessionStore = Depends(get_store),
) -> schemas.StatsResponse:
    stored = store.get_image(session_id, image_id)
    gray = filters.to_grayscale(stored.image)
    try:
        values = statistics(gray)
    except GeoclusterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return schemas.StatsResponse(**values)
