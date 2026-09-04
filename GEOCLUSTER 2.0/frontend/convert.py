import cv2
import numpy as np

from config import (
    PARAMS_TXT,
    CENTROIDS_TXT, RANGES_TXT,
    IMAGES_DIR, DATA_DIR, verify_paths,
    DEFAULT_IMAGE, INPUT_CSV,
)

verify_paths()

img = cv2.imread(DEFAULT_IMAGE, 0)

# [DSA] Matrix Serialization - writes the grayscale image as a 2D CSV grid for backend consumption
np.savetxt(INPUT_CSV, img, fmt="%d", delimiter=",")

print("Image converted and saved to input.csv!")
print("Shape:", img.shape)

