# -*- mode: python ; coding: utf-8 -*-

import tomllib
import sys
from pathlib import Path

from packaging.version import Version
from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_submodules,
    copy_metadata,
)

sys.path.insert(0, str(Path(SPECPATH)))
from mona.office.ppt_packaging import should_include_mona_pptx_package_resource

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
            and should_include_mona_pptx_package_resource(item[0], item[1])
            and "ai-image-comparison" not in str(item[0]).lower()
            and "ai-image-comparison" not in str(item[1]).lower()
        ]
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

# Default TTS imports Edge TTS dynamically; include its package resources and
# distribution metadata explicitly so the packaged Gateway can discover it.
hiddenimports += collect_submodules("edge_tts")
datas += collect_data_files("edge_tts")
datas += copy_metadata("edge-tts")

# The pinned sandbox component must reach both fresh and upgraded desktops.
sandbox_assets = Path("mona/development/sandbox_node")
for asset in sandbox_assets.iterdir():
    if asset.is_file() and not any(Path(item[0]).resolve() == asset.resolve() for item in datas):
        datas.append((str(asset), sandbox_assets.as_posix()))

# SDKs are imported dynamically by the isolated worker. Require compatible
# Python modules + distribution metadata; native CLIs use existing local installs.
from mona.development.executors.sdk_policy import SDK_MODULES, SDK_PACKAGES, sdk_version

for executor, module in SDK_MODULES.items():
    sdk_version(executor)
    sdk_datas, _, sdk_hidden = collect_all(module)
    sdk_native_root = {
        "claude_agent_sdk": (module, "_bundled"),
        "codebuddy_agent_sdk": (module, "bin"),
    }[module]
    def python_sdk_resource(item):
        for part in item:
            parts = tuple(value.casefold() for value in Path(str(part).replace("\\", "/")).parts)
            if any(parts[index:index + len(sdk_native_root)] == sdk_native_root
                   for index in range(len(parts) - len(sdk_native_root) + 1)):
                return False
        return True
    datas += [item for item in sdk_datas if python_sdk_resource(item)]
    sdk_native_module = ".".join(sdk_native_root)
    hiddenimports += [name for name in sdk_hidden
                      if name != sdk_native_module and not name.startswith(sdk_native_module + ".")]
    datas += copy_metadata(SDK_PACKAGES[executor], recursive=True)

datas = [
    item for item in datas
    if not {"tests", "test", "testing", "__pycache__", "node_modules", ".git"}.intersection(
        Path(str(item[1]).replace("\\", "/")).parts
    )
]

# Skills execute these files by path; Python's import archive is not sufficient.
skill_root = Path("mona/skills")
video_runtime = skill_root / "mona-video/runtime"
if not (video_runtime / "remotion.js").is_file():
    raise FileNotFoundError("Video animation runtime missing: run npm run build:video-runtime in webui")
datas.append((str(video_runtime), video_runtime.as_posix()))
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
