"""GeoCluster processing package.

Framework-independent image processing ported from the desktop application
(desktop/frontend/ui.py is the canonical behavior). Contains no PyQt, no
torch, no matplotlib and no file-based IPC.
"""

from __future__ import annotations

__all__ = [
    "classify",
    "filters",
    "huffman",
    "images",
    "kmeans",
    "stats",
]
