from pathlib import Path

from PyQt5.QtCore import Qt, QPoint, QSize, pyqtSignal
from PyQt5.QtGui import QIcon
from PyQt5.QtWidgets import QPushButton


class FloatingAIWidget(QPushButton):
    """Floating AI button that can be dragged and clicked."""

    clicked_signal = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)

        self.setFixedSize(84, 84)

        icon_path = (
            Path(__file__).parent
            / "assets"
            / "ai_icon.png"
        )

        self.setIcon(QIcon(str(icon_path)))
        self.setIconSize(QSize(100, 100))

        self.setStyleSheet("""
            QPushButton {
                background-color: #00bcd4;
                border: 2px solid #00f0ff;
                border-radius: 42px;
            }

            QPushButton:hover {
                background-color: #00d9ff;
                border: 2px solid #66f0ff;
            }

            QPushButton:pressed {
                background-color: #0097a7;
            }
            """)

        self.raise_()

        self.dragging = False
        self.drag_position = QPoint()
        self.press_position = QPoint()
        self.was_dragged = False

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.dragging = True
            self.was_dragged = False
            self.press_position = event.globalPos()
            self.drag_position = event.globalPos() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if not self.dragging:
            return

        distance = (event.globalPos() - self.press_position).manhattanLength()

        if distance > 8:
            self.was_dragged = True

            new_pos = self.parent().mapFromGlobal(
                event.globalPos() - self.drag_position
            )

            new_pos.setX(
                max(0, min(new_pos.x(), self.parent().width() - self.width()))
            )
            new_pos.setY(
                max(0, min(new_pos.y(), self.parent().height() - self.height()))
            )

            self.move(new_pos)

        event.accept()

    def mouseReleaseEvent(self, event):
        self.dragging = False

        if not self.was_dragged:
            self.clicked_signal.emit()

        event.accept()