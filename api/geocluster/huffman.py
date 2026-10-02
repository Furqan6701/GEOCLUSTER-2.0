"""GCH2 Huffman compression, byte-compatible with the desktop format.

Format (desktop/frontend/ui.py::compress_color_image_huffman):
    magic  b"GCH2"
    header struct "<IIIII": rows, cols, channels, payload_bits, version=1
    256 little-endian uint32 frequencies
    packed payload: Huffman codes, MSB-first, zero-padded final byte

The prefix codes are built with the exact heap/ordering semantics of the
desktop implementation, so a file compressed here is byte-identical to a file
compressed by the desktop for the same input (locked by a golden test).

Bit packing and decoding are vectorized with NumPy; the GCH1 format is not
ported (it remains desktop-only).
"""

from __future__ import annotations

import heapq
import struct

import numpy as np

from .errors import HuffmanError

MAGIC = b"GCH2"
HEADER_SIZE = 24
FREQUENCY_TABLE_SIZE = 1024

Array = np.ndarray


class _HuffmanNode:
    __slots__ = ("frequency", "value", "left", "right")

    def __init__(
        self,
        frequency: int,
        value: int | None = None,
        left: "_HuffmanNode | None" = None,
        right: "_HuffmanNode | None" = None,
    ) -> None:
        self.frequency = int(frequency)
        self.value = value
        self.left = left
        self.right = right

    def __lt__(self, other: "_HuffmanNode") -> bool:
        left_value = -1 if self.value is None else self.value
        right_value = -1 if other.value is None else other.value
        return (self.frequency, left_value) < (other.frequency, right_value)


def _build_tree(frequencies: list[int]) -> _HuffmanNode:
    heap = [_HuffmanNode(freq, value=index) for index, freq in enumerate(frequencies) if freq > 0]
    if not heap:
        raise HuffmanError("Cannot build a Huffman tree from empty data.")
    heapq.heapify(heap)
    while len(heap) > 1:
        left = heapq.heappop(heap)
        right = heapq.heappop(heap)
        parent = _HuffmanNode(
            left.frequency + right.frequency,
            value=min(value for value in (left.value, right.value) if value is not None),
            left=left,
            right=right,
        )
        heapq.heappush(heap, parent)
    return heap[0]


def build_huffman_codes(frequencies: list[int]) -> dict[int, str]:
    """ui._build_huffman_codes, semantics preserved exactly."""
    heap = [_HuffmanNode(freq, value=index) for index, freq in enumerate(frequencies) if freq > 0]
    if not heap:
        raise HuffmanError("Cannot compress empty image data.")
    heapq.heapify(heap)
    if len(heap) == 1:
        return {heap[0].value: "0"}  # type: ignore[dict-item]

    while len(heap) > 1:
        left = heapq.heappop(heap)
        right = heapq.heappop(heap)
        heapq.heappush(
            heap,
            _HuffmanNode(
                left.frequency + right.frequency,
                value=min(value for value in (left.value, right.value) if value is not None),
                left=left,
                right=right,
            ),
        )

    codes: dict[int, str] = {}

    def walk(node: _HuffmanNode, prefix: str) -> None:
        if node.value is not None and node.left is None and node.right is None:
            codes[node.value] = prefix or "0"
            return
        walk(node.left, prefix + "0")  # type: ignore[arg-type]
        walk(node.right, prefix + "1")  # type: ignore[arg-type]

    walk(heap[0], "")
    return codes


def _pack_payload(flat: Array, codes: dict[int, str]) -> tuple[bytes, int]:
    """Vectorized bit packing: returns (packed bytes, payload bit count)."""
    lengths = np.zeros(256, dtype=np.int64)
    table = np.zeros((256, max(len(code) for code in codes.values())), dtype=np.uint8)
    for value, code in codes.items():
        lengths[value] = len(code)
        table[value, : len(code)] = np.frombuffer(code.encode("ascii"), dtype=np.uint8) - ord("0")

    pixel_lengths = lengths[flat]
    payload_bits = int(pixel_lengths.sum())
    chunks: list[Array] = []
    columns = np.arange(table.shape[1], dtype=np.int64)
    block = 1 << 21
    for start in range(0, flat.size, block):
        block_values = flat[start : start + block]
        codes_block = table[block_values]
        valid = columns[None, :] < lengths[block_values][:, None]
        chunks.append(codes_block[valid])
    if len(chunks) != 1:
        bits = np.concatenate(chunks)
    else:
        bits = chunks[0]
    if bits.size != payload_bits:
        raise HuffmanError("Internal error while packing Huffman payload.")
    byte_count = (payload_bits + 7) // 8
    padded = np.zeros(byte_count * 8, dtype=np.uint8)
    padded[:payload_bits] = bits
    return np.packbits(padded, bitorder="big").tobytes(), payload_bits


def compress(image: Array) -> tuple[bytes, dict[str, int]]:
    """Compress any uint8 image (1, 3 or 4 channels) into GCH2 bytes."""
    matrix = np.asarray(image)
    if matrix.size == 0 or matrix.ndim == 1 or (matrix.ndim == 2 and matrix.shape[1] == 0):
        raise HuffmanError("Cannot compress an empty image.")
    if matrix.ndim not in (2, 3):
        raise HuffmanError("Unsupported image layout for Huffman compression.")
    values = np.clip(matrix.astype(np.int32), 0, 255).astype(np.uint8)
    rows = values.shape[0]
    cols = values.shape[1]
    channels = 1 if values.ndim == 2 else values.shape[2]
    if channels not in (1, 3, 4):
        raise HuffmanError("GCH2 supports 1, 3 or 4 channels.")

    flat = values.reshape(-1)
    frequencies = np.bincount(flat, minlength=256).astype(np.uint32)
    codes = build_huffman_codes(frequencies.tolist())
    packed, payload_bits = _pack_payload(flat, codes)

    header = MAGIC + struct.pack("<IIIII", rows, cols, channels, payload_bits, 1)
    body = b"".join(struct.pack("<I", int(freq)) for freq in frequencies)
    data = header + body + packed
    meta = {
        "rows": rows,
        "cols": cols,
        "channels": channels,
        "payload_bits": payload_bits,
        "original_bytes": int(flat.size),
        "compressed_bytes": len(data),
        "unique_values": int(np.count_nonzero(frequencies)),
    }
    return data, meta


def _tree_lists(root: _HuffmanNode) -> tuple[list[int], list[int], list[int]]:
    """Flatten the tree into left/right/value Python lists indexed by node id.

    Python lists (not NumPy arrays) are deliberate: the decoder's inner loop
    indexes them per payload byte and list indexing is faster there.
    """
    nodes = [root]
    left: list[int] = []
    right: list[int] = []
    value: list[int] = []
    index = 0
    while index < len(nodes):
        node = nodes[index]
        if node.left is None and node.right is None:
            left.append(-1)
            right.append(-1)
            value.append(int(node.value))  # type: ignore[arg-type]
        else:
            children = []
            for child in (node.left, node.right):
                if child is None:
                    raise HuffmanError("Internal error: incomplete Huffman tree.")
                children.append(len(nodes))
                nodes.append(child)
            left.append(children[0])
            right.append(children[1])
            value.append(-1)
        index += 1
    return left, right, value


def _decode_payload(
    payload: bytes,
    payload_bits: int,
    left: list[int],
    right: list[int],
    value: list[int],
    expected: int,
) -> list[int]:
    """Decode MSB-first packed Huffman bits into a list of symbol values.

    A per-state byte transition table turns 8 bit-steps into one table lookup
    (rows are built lazily, once per visited state), so only payload bytes are
    iterated - not individual bits and not individual symbols. The final
    partial byte is walked bit-by-bit so padding bits are never emitted.
    """
    row_cache: list[list[tuple[bytes, int]] | None] = [None] * len(left)

    def build_row(state: int) -> list[tuple[bytes, int]]:
        row: list[tuple[bytes, int]] = []
        for byte in range(256):
            node = state
            emitted = bytearray()
            for bit in range(7, -1, -1):
                node = right[node] if (byte >> bit) & 1 else left[node]
                if value[node] >= 0:
                    emitted.append(value[node])
                    node = 0
            row.append((bytes(emitted), node))
        return row

    out: list[int] = []
    node = 0
    consumed = 0
    data = memoryview(payload)
    full_bytes = payload_bits // 8
    for offset in range(full_bytes):
        row = row_cache[node]
        if row is None:
            row = build_row(node)
            row_cache[node] = row
        emitted, node = row[data[offset]]
        if emitted:
            out.extend(emitted)
        consumed += 8
        if len(out) >= expected + 8:  # guard against corrupt streams
            raise HuffmanError("Invalid or corrupted Huffman payload.")

    if payload_bits % 8:
        byte = data[full_bytes] if full_bytes < len(payload) else 0
        for bit in range(7, 7 - (payload_bits % 8), -1):
            node = right[node] if (byte >> bit) & 1 else left[node]
            if value[node] >= 0:
                out.append(value[node])
                node = 0
            consumed += 1
    return out


def decompress(data: bytes) -> tuple[Array, dict[str, int]]:
    """Decode GCH2 bytes back into a uint8 image."""
    if len(data) < HEADER_SIZE + FREQUENCY_TABLE_SIZE or data[:4] != MAGIC:
        raise HuffmanError("Invalid Huffman file format.")
    rows, cols, channels, payload_bits, version = struct.unpack("<IIIII", data[4:HEADER_SIZE])
    if rows == 0 or cols == 0:
        raise HuffmanError("Compressed file contains invalid image dimensions.")
    if channels not in (1, 3, 4):
        raise HuffmanError("Compressed file declares an unsupported channel count.")
    frequencies = list(struct.unpack("<256I", data[HEADER_SIZE : HEADER_SIZE + FREQUENCY_TABLE_SIZE]))
    payload = data[HEADER_SIZE + FREQUENCY_TABLE_SIZE :]
    if len(payload) * 8 < payload_bits:
        raise HuffmanError("Truncated Huffman payload.")

    expected = rows * cols * channels
    root = _build_tree(frequencies)

    if root.left is None and root.right is None:
        # single-symbol stream: every payload bit must be 0 (code "0")
        if payload_bits != expected:
            raise HuffmanError("Decoded pixel count does not match the stored image dimensions.")
        bits = np.unpackbits(np.frombuffer(payload, dtype=np.uint8), bitorder="big")
        if bool(np.any(bits[:payload_bits])):
            raise HuffmanError("Invalid or corrupted Huffman payload.")
        flat = np.full(expected, root.value, dtype=np.uint8)
    else:
        left_list, right_list, value_list = _tree_lists(root)
        symbols = _decode_payload(payload, payload_bits, left_list, right_list, value_list, expected)
        if len(symbols) != expected:
            raise HuffmanError("Decoded pixel count does not match the stored image dimensions.")
        flat = np.asarray(symbols, dtype=np.uint8)

    shape = (rows, cols) if channels == 1 else (rows, cols, channels)
    image = flat.reshape(shape)
    meta = {
        "rows": rows,
        "cols": cols,
        "channels": channels,
        "version": version,
        "payload_bits": payload_bits,
        "compressed_bytes": len(data),
    }
    return image, meta
