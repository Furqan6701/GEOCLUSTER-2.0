import torch  # Import first to avoid DLL conflicts with PyQt5/OpenCV on Windows
import os
import sys

# Add frontend directory to path so config.py is always found
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PyQt5.QtWidgets import QApplication

from ui import GeoClusterWindow, apply_geotech_theme


# [KEY] main
# Why important: this bootstraps the whole desktop app; if startup wiring is wrong the UI never appears.
# Logic: create a QApplication, apply the shared theme, build the main window, and enter the Qt event loop.
# Complexity: O(1) time | O(1) space
# Watch out: QApplication must exist before constructing any visible Qt widgets.
def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    apply_geotech_theme(app)
    window = GeoClusterWindow()
    window.show()
    return app.exec_()


if __name__ == "__main__":
    raise SystemExit(main())

