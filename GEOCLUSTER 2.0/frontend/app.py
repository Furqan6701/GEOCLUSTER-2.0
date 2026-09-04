import torch  # Import first to avoid DLL conflicts with PyQt5/OpenCV on Windows
import os
import sys

# Add frontend directory to path so config.py is always found
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import verify_paths
from PyQt5.QtWidgets import QApplication, QMessageBox

from ui import GeoClusterWindow, apply_geotech_theme

# Verify paths before launching
issues = verify_paths()
if issues:
    _app = QApplication.instance() or QApplication(sys.argv)
    msg = QMessageBox()
    msg.setWindowTitle("GEOCLUSTER 2.0 - Setup Issue")
    msg.setIcon(QMessageBox.Warning)
    msg.setText(
        "Setup issues found:\n\n"
        + "\n".join(issues)
        + "\n\nThe app will still launch but some features may not work until these are resolved."
    )
    msg.exec_()


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

