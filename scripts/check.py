"""Local manual-CI gate for QuickTerm.

Run with ``uv run --no-sync python scripts/check.py``. Pass ``--artifacts``
after building a release to verify the updater-facing filenames and checksum
manifest as well.
"""

from __future__ import annotations

import argparse
import compileall
import hashlib
import subprocess
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(*args: str) -> None:
    print(f"+ {' '.join(args)}", flush=True)
    subprocess.run(args, cwd=ROOT, check=True)


def project_version() -> str:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    version = pyproject["project"]["version"]

    namespace: dict[str, str] = {}
    exec((ROOT / "quickterm" / "__init__.py").read_text(encoding="utf-8"), namespace)
    init_version = namespace["__version__"]

    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    lock_versions = {
        package["version"] for package in lock["package"] if package["name"] == "quickterm"
    }
    if init_version != version or lock_versions != {version}:
        raise RuntimeError(
            f"version mismatch: pyproject={version}, __init__={init_version}, "
            f"uv.lock={sorted(lock_versions)}"
        )
    return version


def check_javascript() -> None:
    tests = sorted((ROOT / "tests" / "js").glob("*.test.mjs"))
    if not tests:
        raise RuntimeError("no JavaScript tests found")
    run("node", "--test", *(str(path) for path in tests))
    for path in sorted((ROOT / "quickterm" / "frontend" / "js").glob("*.js")):
        run("node", "--check", str(path))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_artifacts(version: str) -> None:
    artifacts = [
        ROOT / f"QuickTerm-v{version}-windows-x64.zip",
        ROOT / "dist" / f"QuickTerm-v{version}-Setup.exe",
        ROOT / "dist" / f"quickterm-{version}-py3-none-any.whl",
        ROOT / "dist" / f"quickterm-{version}.tar.gz",
    ]
    missing = [str(path.relative_to(ROOT)) for path in artifacts if not path.is_file()]
    if missing:
        raise RuntimeError(f"missing release artifacts: {', '.join(missing)}")

    sums_path = ROOT / "SHA256SUMS.txt"
    expected = {
        line.split()[1]: line.split()[0].lower()
        for line in sums_path.read_text(encoding="ascii").splitlines()
        if line.strip()
    }
    actual_names = {path.name for path in artifacts}
    if set(expected) != actual_names:
        raise RuntimeError(
            f"checksum manifest names differ: expected={sorted(actual_names)}, "
            f"found={sorted(expected)}"
        )
    for path in artifacts:
        if sha256(path) != expected[path.name]:
            raise RuntimeError(f"checksum mismatch: {path.name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", action="store_true", help="also verify built release files")
    args = parser.parse_args()

    version = project_version()
    print(f"QuickTerm {version} manual CI", flush=True)
    run(sys.executable, "-m", "pytest", "-q")
    run(sys.executable, "-m", "ruff", "check", "quickterm", "tests", "scripts")
    if not compileall.compile_dir(ROOT / "quickterm", quiet=1):
        raise RuntimeError("Python byte compilation failed")
    check_javascript()
    run("git", "diff", "--check")
    if args.artifacts:
        check_artifacts(version)
    print("Manual CI passed.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
