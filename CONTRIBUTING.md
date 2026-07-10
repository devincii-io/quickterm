# Contributing

QuickTerm uses Python 3.12+ and [uv](https://docs.astral.sh/uv/). The frontend
is plain JavaScript and CSS with no Node build step.

```bash
uv sync --all-extras --dev
uv run ruff check quickterm tests
uv run pytest -q
```

Keep terminal I/O as raw bytes, preserve the replay-then-resize sequence, and
test on Windows when changing ConPTY or global-hotkey behavior. Open an issue
before large architectural changes.
