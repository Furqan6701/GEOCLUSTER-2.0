"""Keep secrets out of the server log.

Errors raised by an HTTP client or an SDK sometimes quote the request they made
- and a request may carry a key in a header or a query string. The rule this
module enforces is simple: **whatever gets logged, a key-shaped string in it is
replaced by `***`** before it reaches a handler.

It wraps the formatters that already exist (uvicorn's included) instead of
installing new ones, so the log keeps its familiar layout.
"""

from __future__ import annotations

import logging
import re

REDACTED = "***"

#: Key-shaped strings and authorization headers. Deliberately broad: a false
#: positive only costs a little readability in a log line.
SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{8,}"),
    re.compile(r"\b(?:gsk|fw|sk|xox[baprs])[_\-]?[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),
    re.compile(r"(?i)\b(api[_-]?key|client[_-]?secret|access[_-]?token|password)\b\s*[=:]\s*\S+"),
)


def redact(text: str) -> str:
    """`text` with every key-shaped fragment replaced by `***`."""
    if not text:
        return text
    redacted = str(text)
    for pattern in SECRET_PATTERNS:
        if pattern.groups:
            redacted = pattern.sub(lambda match: f"{match.group(1)}{REDACTED}" if match.group(1) else REDACTED, redacted)
        else:
            redacted = pattern.sub(REDACTED, redacted)
    return redacted


class SecretRedactionFilter(logging.Filter):
    """Rewrites the record's message, so even a friendly formatter is safe."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - a broken record is not our problem
            return True
        if message != redact(message):
            record.msg = redact(message)
            record.args = ()
        return True


class RedactingFormatter(logging.Formatter):
    """Wraps another formatter: its output (tracebacks included) is redacted."""

    def __init__(self, inner: logging.Formatter | None = None) -> None:
        super().__init__()
        self._inner = inner or logging.Formatter()

    @property
    def inner(self) -> logging.Formatter:
        return self._inner

    def format(self, record: logging.LogRecord) -> str:
        return redact(self._inner.format(record))


def _wrap_handler(handler: logging.Handler) -> None:
    if not any(isinstance(existing, SecretRedactionFilter) for existing in handler.filters):
        handler.addFilter(SecretRedactionFilter())
    if not isinstance(handler.formatter, RedactingFormatter):
        handler.setFormatter(RedactingFormatter(handler.formatter))


#: The console handler uvicorn installs for `logger.exception` fallbacks.
def install_secret_redaction(*loggers: str) -> None:
    """Wrap the handlers of the named loggers (default: everything relevant).

    Idempotent: calling it twice does not double-wrap a handler. Called from
    `create_app()` so a running server always has it.
    """
    names = loggers or ("", "uvicorn", "uvicorn.error", "uvicorn.access", "geocluster")
    seen: set[int] = set()
    for name in names:
        logger = logging.getLogger(name)
        if not any(isinstance(existing, SecretRedactionFilter) for existing in logger.filters):
            logger.addFilter(SecretRedactionFilter())
        for handler in logger.handlers:
            if id(handler) in seen:
                continue
            seen.add(id(handler))
            _wrap_handler(handler)
