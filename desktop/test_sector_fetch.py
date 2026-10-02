from frontend.location_database import get_sector_bbox
from frontend.sentinel_client import fetch_sentinel_image

bbox = get_sector_bbox("F-8")

print("Generated BBox:")
print(bbox)

saved_path = fetch_sentinel_image(
    bbox=bbox,
    output_path="data/f8_sentinel.png"
)

print(f"\nImage saved to: {saved_path}")