from __future__ import annotations

from PyQt5.QtCore import Qt
from PyQt5.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QTextEdit,
    QLineEdit,
    QPushButton,
    QLabel,
)


class AIPanel(QWidget):
    """AI Chat Panel."""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.parent_window = parent

        self.setWindowFlags(Qt.SubWindow | Qt.FramelessWindowHint)
        self.setFixedSize(500, 650)
        
        # Main layout
        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 15, 15, 15)
        layout.setSpacing(10)

        # Header
        header = QHBoxLayout()
        title = QLabel("🤖 GEOCLUSTER AI")
        title.setStyleSheet("font-size:18px; font-weight:bold; color:#00f0ff;")
        
        close_btn = QPushButton("✕")
        close_btn.setFixedSize(30, 30)
        close_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: #888;
                border: none;
                font-size: 16px;
                border-radius: 15px;
            }
            QPushButton:hover {
                background: #ff4444;
                color: white;
            }
        """)
        close_btn.clicked.connect(self.hide)
        
        header.addWidget(title)
        header.addStretch()
        header.addWidget(close_btn)
        layout.addLayout(header)

        # Chat history
        self.chat_history = QTextEdit()
        self.chat_history.setReadOnly(True)
        self.chat_history.setStyleSheet("""
            QTextEdit {
                background: #1b2030;
                color: white;
                border: 1px solid #333;
                border-radius: 6px;
                padding: 8px;
            }
            QTextEdit * {
                color: white;
            }
        """)
        layout.addWidget(self.chat_history)

        # Input area
        input_layout = QHBoxLayout()
        input_layout.setSpacing(8)

        self.chat_input = QLineEdit()
        self.chat_input.setPlaceholderText("Ask or command...")
        self.chat_input.setStyleSheet("""
            QLineEdit {
                background: #1b2030;
                color: white;
                border: 1px solid #333;
                border-radius: 20px;
                padding: 8px 15px;
                font-size: 13px;
            }
            QLineEdit:focus {
                border-color: #00f0ff;
            }
        """)
        input_layout.addWidget(self.chat_input)

        self.send_button = QPushButton("➤")
        self.send_button.setFixedSize(40, 40)
        self.send_button.setStyleSheet("""
            QPushButton {
                background: #00bcd4;
                color: white;
                border: none;
                border-radius: 20px;
                font-size: 18px;
            }
            QPushButton:hover {
                background: #00d9ff;
            }
        """)
        input_layout.addWidget(self.send_button)

        layout.addLayout(input_layout)

        # Overall style
        self.setStyleSheet("""
            QWidget {
                background: #11131a;
                border: 1px solid #00f0ff;
                border-radius: 12px;
            }
        """)

        # Add welcome message
        self.chat_history.append("<b>🤖 GEOCLUSTER AI:</b> Welcome! Try:")
        self.chat_history.append("• <i>Show me F-8 imagery</i>")
        self.chat_history.append("• <i>Apply K-Means</i>")
        self.chat_history.append("• <i>What is NDVI?</i>")

        self.hide()