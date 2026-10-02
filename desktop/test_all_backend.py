import numpy as np
from pathlib import Path
from frontend import backend_py

print("=== Testing compute_distance ===")
result = backend_py.compute_distance(0, 0, 3, 4)
print(result)
assert abs(result.distance - 5.0) < 1e-9, "Distance should be exactly 5.0 (3-4-5 triangle)"
print("PASS: distance is correct (3-4-5 triangle)\n")

print("=== Testing image_negative ===")
test_img = np.array([[0, 100, 255]], dtype=np.uint8)
negative = backend_py.image_negative(test_img)
print("Input: ", test_img)
print("Output:", negative)
assert list(negative[0]) == [255, 155, 0], "Negative should flip each value (255 - x)"
print("PASS: negative is correct\n")

print("=== Testing adjust_brightness ===")
bright = backend_py.adjust_brightness(test_img, 50)
print("Input: ", test_img)
print("Output (+50):", bright)
assert list(bright[0]) == [50, 150, 255], "Brightness should add 50, clamped at 255"
print("PASS: brightness is correct\n")

print("=== Testing apply_threshold ===")
thresh = backend_py.apply_threshold(test_img, 127)
print("Input: ", test_img)
print("Output (threshold=127):", thresh)
assert list(thresh[0]) == [0, 0, 255], "Values >127 become 255, else 0"
print("PASS: threshold is correct\n")

print("=== Testing mean_filter ===")
flat_img = np.full((10, 10), 100, dtype=np.uint8)
filtered = backend_py.mean_filter(flat_img, 3)
print("Flat image (all 100s) after mean filter should still be ~100")
print(filtered)
assert filtered.mean() == 100, "Mean filter on a flat image should not change values"
print("PASS: mean filter is correct on flat input\n")

print("=== Testing Huffman compress/decompress round-trip ===")
huff_img = np.random.randint(0, 256, size=(20, 20), dtype=np.uint8)
huff_path = Path("data/test_huffman.bin")
compress_result = backend_py.compress_image_huffman(huff_img, huff_path)
print("Compression result:", compress_result)
decompressed = backend_py.decompress_image_huffman(huff_path)
assert np.array_equal(huff_img, decompressed), "Decompressed image should exactly match the original"
print("PASS: Huffman round-trip is lossless\n")

print("=== ALL TESTS PASSED ===")