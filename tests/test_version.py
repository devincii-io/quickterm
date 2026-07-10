import tomllib
from pathlib import Path

import quickterm


def test_package_versions_match():
    project = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    assert quickterm.__version__ == project["project"]["version"]
