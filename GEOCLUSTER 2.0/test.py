import cv2

from backend_py import process_operation
from config import CENTROIDS_TXT, HUFFMAN_BIN, PARAMS_TXT, RANGES_TXT, verify_paths
from ui import DEFAULT_IMAGE, META_TXT, OUTPUT_CSV, parse_metadata, read_csv_matrix, to_grayscale, write_params


def main() -> None:
    verify_paths()
    image = cv2.imread(str(DEFAULT_IMAGE), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not load sample image: {DEFAULT_IMAGE}")

    gray = to_grayscale(image)
    params = {"operation": "kmeans", "value": 5}
    write_params(PARAMS_TXT, params)
    _output, log_text, _metadata = process_operation(
        gray,
        params,
        CENTROIDS_TXT,
        RANGES_TXT,
        META_TXT,
        HUFFMAN_BIN,
        OUTPUT_CSV,
    )
    print(log_text)

    output = read_csv_matrix(OUTPUT_CSV)
    metadata = parse_metadata(META_TXT)
    cv2.imwrite(str(META_TXT.parent.parent / "images" / "test_kmeans_output.png"), output)
    print(output.shape, metadata)


if __name__ == "__main__":
    main()
