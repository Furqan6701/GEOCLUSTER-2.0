import numpy as np
from pathlib import Path
from frontend import backend_py

fake_image = np.random.randint(0, 256, size=(50, 50), dtype=np.uint8)

params = backend_py.KMeansParams(
    k=5,
    max_iter=30,
    tolerance=0.001,
    seed=42,
    ranges=backend_py.default_ranges(5),
    centroids_path=Path("data/centroids.txt"),
    ranges_path=Path("data/ranges.txt"),
)

result = backend_py.run_kmeans(fake_image, params)
print("K-Means ran successfully")
print("Result type:", type(result))
print(result)