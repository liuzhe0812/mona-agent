# -*- mode: python ; coding: utf-8 -*-

import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules
from packaging.version import Version

datas = []
binaries = []
hiddenimports = []

for package in (
    "mona", "playwright", "yt_dlp", "freetype", "certifi",
    "trafilatura", "curl_cffi",
):
    try:
        package_datas, package_binaries, package_hidden = collect_all(package)
    except Exception:
        continue
    if package == "mona":
        package_datas = [
            item for item in package_datas
            if not str(item[0]).lower().endswith(".py")
            and not (
                str(item[1]).replace("\\", "/").rstrip("/") == "mona/web/dist"
                or str(item[1]).replace("\\", "/").startswith("mona/web/dist/")
            )
            and "ai-image-comparison" not in str(item[0]).lower()
            and "ai-image-comparison" not in str(item[1]).lower()
        ]
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

datas = [
    item for item in datas
    if not {"tests", "test", "testing", "__pycache__", "node_modules", ".git"}.intersection(
        Path(str(item[1]).replace("\\", "/")).parts
    )
]

# Skills execute these files by path; Python's import archive is not sufficient.
skill_root = Path("mona/skills")
for path in sorted(skill_root.rglob("*.py")):
    if not {"tests", "test", "__pycache__", "node_modules", ".git"}.intersection(
        path.relative_to(skill_root).parts
    ) and "ai-image-comparison" not in path.parts:
        datas.append((str(path), path.parent.as_posix()))

# The legacy updater replaces the whole gateway tree. Keep desktop resources
# inside it so both existing installations and fresh installers receive them.
office_resources = Path("src-tauri/resources/office-editor")
if not office_resources.is_dir():
    raise FileNotFoundError(f"Office resources missing: {office_resources}")
datas.append((str(office_resources), "desktop-resources/office-editor"))

hiddenimports += [
    "pymupdf",
    "pypdf",
    "pdfplumber",
    "uvicorn.lifespan.on",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "pydantic.deprecated.decorator",
    "pydantic_settings",
    "anthropic.types",
    "openai",
    "httpx._transports.default",
    "anyio._backends._asyncio",
    "aiohttp.web",
    "mcp.server.fastmcp",
    "mcp.client.stdio",
    "mcp.client.streamable_http",
    "lark_oapi.api.im.v1",
    "engineio.async_drivers.aiohttp",
    "engineio.async_drivers.threading",
    "socketio",
]

hiddenimports = sorted({
    name for name in hiddenimports
    if not {"tests", "test", "testing", "__pyinstaller"}.intersection(name.split("."))
})

a = Analysis(
    ["mona/__main__.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "matplotlib", "scipy", "pandas", "IPython", "notebook", "jupyter",
        "cv2", "opencv_python", "PyQt5", "PyQt6", "PySide2", "PySide6", "wx",
        "test", "tests", "pytest", "_pytest", "torch", "torchvision", "torchaudio",
        "zmq", "pyzmq", "whisper", "modelscope", "sentence_transformers", "chromadb",
    ],
    noarchive=False,
    optimize=0,
)
# Use the release source version, not stale editable-install metadata from
# the build machine. importlib.metadata reads this from the deployed tree.
release_version = Version(tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))["project"]["version"])
metadata_dir = Path(workpath) / f"mona_ai-{release_version}.dist-info"
metadata_dir.mkdir(parents=True, exist_ok=True)
metadata_file = metadata_dir / "METADATA"
metadata_file.write_text(f"Metadata-Version: 2.1\nName: mona-ai\nVersion: {release_version}\n", encoding="utf-8")
a.datas = [
    entry for entry in a.datas
    if not entry[0].replace("\\", "/").split("/")[0].startswith(("mona_ai-", "mona-ai-"))
]
a.datas.append((f"{metadata_dir.name}/METADATA", str(metadata_file), "DATA"))

pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="mona-gateway",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="mona-gateway",
)
