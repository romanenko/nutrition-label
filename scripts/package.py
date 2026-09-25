"""Package only the standalone extension, with deterministic ZIP metadata."""

import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "dist" / "release"
OUTPUT = ROOT / "dist" / "downloads"

manifest = json.loads((BUILD / "manifest.json").read_text())
package = json.loads((ROOT / "package.json").read_text())
if manifest["version"] != package["version"]:
    raise SystemExit("Manifest and package versions must match before packaging.")
if "Dev" in manifest["name"] or "http://localhost" in json.dumps(manifest):
    raise SystemExit("Refusing to package a development extension.")

files = {"INSTALL.txt": (ROOT / "docs" / "INSTALL.txt").read_bytes()}
for path in sorted(BUILD.rglob("*")):
    if path.is_symlink():
        raise SystemExit(f"Unexpected symlink in build: {path.name}")
    if not path.is_file():
        continue
    relative = path.relative_to(BUILD).as_posix()
    if path.suffix not in {".json", ".js", ".html", ".css", ".png", ".svg"} or path.name == "fixture.html":
        raise SystemExit(f"Unexpected release file: {relative}")
    content = path.read_bytes()
    if path.suffix in {".js", ".html", ".json"} and any(marker in content for marker in [b"/@vite/client", b"localhost:5173", b"127.0.0.1:5173"]):
        raise SystemExit(f"Development server reference in release: {relative}")
    files[f"nutrition-label/{relative}"] = content

notices = []
for dependency, license_file in [
    ("dom-accessibility-api", "LICENSE.md"),
    ("vite", "LICENSE.md"),
    ("@crxjs/vite-plugin", "LICENSE"),
]:
    directory = ROOT / "node_modules" / dependency
    version = json.loads((directory / "package.json").read_text())["version"]
    notices.append(f"{dependency} {version}\n\n{(directory / license_file).read_text()}")
files["nutrition-label/THIRD_PARTY_NOTICES.txt"] = "\n\n---\n\n".join(notices).encode()

OUTPUT.mkdir(parents=True, exist_ok=True)
archive_path = OUTPUT / "nutrition-label-chrome.zip"
with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, content in sorted(files.items()):
        entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, content, compresslevel=9)

with zipfile.ZipFile(archive_path) as archive:
    if archive.testzip() is not None or set(archive.namelist()) != set(files):
        raise SystemExit("Archive verification failed.")

digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
archive_path.with_suffix(".zip.sha256").write_text(f"{digest}  {archive_path.name}\n")
print(f"Packaged Nutrition Label {manifest['version']}: {archive_path}")
print(f"{len(files)} files, {archive_path.stat().st_size:,} bytes; SHA-256: {digest}")
