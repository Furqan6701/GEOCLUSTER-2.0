from __future__ import annotations

import re
from typing import Dict, Any


class CommandRouter:
    """
    Simple rule-based router for GEOCLUSTER.

    Supported intents:
    - fetch_satellite
    - process_image
    - ask_question
    """

    def route(self, prompt: str) -> Dict[str, Any]:

        text = prompt.strip()

        if not text:
            return {
                "intent": "ask_question",
                "question": ""
            }

        lower = text.lower()

        # ---------------------------------------------------
        # SATELLITE REQUESTS
        # ---------------------------------------------------

        satellite_verbs = [
            "show me",
            "show",
            "load",
            "fetch",
            "display",
            "open",
            "view",
            "get",
        ]

        if any(lower.startswith(v) for v in satellite_verbs):

            location = text

            # Remove starting verb
            for verb in satellite_verbs:
                if lower.startswith(verb):
                    location = text[len(verb):]
                    break

            # Remove common filler words
            location = re.sub(
                r"\b(satellite|imagery|image|sentinel|picture|of|for)\b",
                "",
                location,
                flags=re.IGNORECASE,
            )

            location = re.sub(r"\s+", " ", location).strip()

            return {
                "intent": "fetch_satellite",
                "location": location,
            }

        # ---------------------------------------------------
        # IMAGE PROCESSING
        # ---------------------------------------------------

        operation_map = {
            "kmeans": "kmeans",
            "k-means": "kmeans",
            "mean filter": "meanfilter",
            "threshold": "threshold",
            "brightness": "brightness",
            "negative": "negative",
            "histogram": "histogram",
            "compress": "compress",
            "compression": "compress",
            "distance": "distance",
        }

        for key, value in operation_map.items():
            if key in lower:
                return {
                    "intent": "process_image",
                    "operation": value,
                }

        # Some natural language shortcuts

        if "cluster" in lower:
            return {
                "intent": "process_image",
                "operation": "kmeans",
            }

        if "classify" in lower:
            return {
                "intent": "process_image",
                "operation": "kmeans",
            }

        # ---------------------------------------------------
        # EVERYTHING ELSE
        # ---------------------------------------------------

        return {
            "intent": "ask_question",
            "question": text,
        }