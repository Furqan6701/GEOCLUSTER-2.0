"""GCH2 cross-compatibility tests against desktop-produced fixtures."""

from __future__ import annotations

import struct

import numpy as np
import pytest

from geocluster import huffman


def test_desktop_fixture_decompresses_losslessly(fixtures_dir, sample):
    data = (fixtures_dir / "sample_color.gch").read_bytes()
    decoded, meta = huffman.decompress(data)
    assert np.array_equal(decoded, sample)
    assert meta["channels"] == 3
    assert (meta["rows"], meta["cols"]) == sample.shape[:2]


def test_api_output_is_byte_identical_to_the_desktop_file(fixtures_dir, sample):
    desktop = (fixtures_dir / "sample_color.gch").read_bytes()
    produced, meta = huffman.compress(sample)
    assert produced == desktop
    assert meta["compressed_bytes"] == len(desktop)


def test_api_compressed_header_matches_expected(expected, sample):
    produced, _meta = huffman.compress(sample)
    golden = expected["huffman"]
    assert produced[:4] == b"GCH2"
    rows, cols, channels, payload_bits, version = struct.unpack("<IIIII", produced[4:24])
    assert (rows, cols, channels, payload_bits, version) == (
        golden["rows"],
        golden["cols"],
        golden["channels"],
        golden["payload_bits"],
        golden["version"],
    )
    assert produced[:24].hex() == golden["header_hex"]


def test_api_round_trip_is_lossless(sample):
    produced, _meta = huffman.compress(sample)
    decoded, _ = huffman.decompress(produced)
    assert np.array_equal(decoded, sample)


def test_grayscale_variant_matches_desktop_fixture(fixtures_dir, gray_sample, expected):
    desktop = (fixtures_dir / "gray_sample.gch").read_bytes()
    produced, _ = huffman.compress(gray_sample)
    assert produced == desktop
    decoded, meta = huffman.decompress(desktop)
    assert np.array_equal(decoded, gray_sample)
    assert meta["channels"] == 1
    assert produced[:24].hex() == expected["huffman_gray"]["header_hex"]


def test_bgra_round_trip(alpha_sample):
    produced, meta = huffman.compress(alpha_sample)
    assert meta["channels"] == 4
    decoded, _ = huffman.decompress(produced)
    assert np.array_equal(decoded, alpha_sample)


def test_single_symbol_stream_round_trip():
    flat = np.full((16, 16), 42, dtype=np.uint8)
    produced, meta = huffman.compress(flat)
    assert meta["unique_values"] == 1
    decoded, _ = huffman.decompress(produced)
    assert np.array_equal(decoded, flat)


def test_rejects_corrupt_and_truncated_input(fixtures_dir):
    from geocluster.errors import HuffmanError

    with pytest.raises(HuffmanError):
        huffman.decompress(b"GCH1" + b"\x00" * 2000)
    desktop = (fixtures_dir / "sample_color.gch").read_bytes()
    with pytest.raises(HuffmanError):
        huffman.decompress(desktop[:100])
    corrupted = bytearray(desktop)
    corrupted[24] ^= 0xFF  # break the frequency table -> different tree
    with pytest.raises(HuffmanError):
        huffman.decompress(bytes(corrupted))


def test_compress_rejects_empty_image():
    from geocluster.errors import HuffmanError

    with pytest.raises(HuffmanError):
        huffman.compress(np.zeros((0, 0), dtype=np.uint8))
