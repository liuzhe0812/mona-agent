# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for mona-gateway (COLLECT / onedir mode).

Build:
    cd <project-root>
    pyinstaller src-tauri/mona-gateway.spec

Output:
    src-tauri/resources/mona-gateway/   (directory containing mona-gateway.exe + _internal/)
"""
import os
import sys
import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules, collect_data_files
from packaging.version import Version

block_cipher = None

PROJECT_ROOT = Path(SPECPATH).resolve().parent
MONA_PKG = PROJECT_ROOT / "mona"

# ============== Hidden Imports ==============

hidden_imports_mona = [
    "mona",
    "mona.__main__",
    "mona.cli.commands",
    "mona.cli.onboard",
    "mona.config.schema",
    "mona.config.loader",
    "mona.agent.loop",
    "mona.agent.runner",
    "mona.agent.context",
    "mona.bus.queue",
    "mona.cron.service",
    "mona.cron.types",
    "mona.heartbeat.service",
    "mona.session.manager",
    "mona.security.network",
    "mona.utils.helpers",
    "mona.utils.restart",
    "mona.utils.llm_runtime",
    "mona.utils.file_edit_events",
    "mona.command.builtin",
    "mona.webui",
    "mona.kb.search",
    "mona.kb.embedding",
]

hidden_imports_third_party = [
    # Web framework
    "uvicorn",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    # Pydantic
    "pydantic",
    "pydantic.deprecated",
    "pydantic.deprecated.decorator",
    "pydantic._internal",
    "pydantic._internal._config",
    "pydantic_settings",
    # LLM providers
    "anthropic",
    "anthropic.types",
    "openai",
    "httpx",
    "httpx._transports",
    "httpx._transports.default",
    "httpcore",
    "socksio",
    "certifi",
    # Async I/O
    "anyio",
    "anyio._backends._asyncio",
    "sniffio",
    "aiohttp",
    "aiohttp.web",
    "aiohttp._http_parser",
    "aiohttp._helpers",
    "multidict",
    "yarl",
    "frozenlist",
    "aiosignal",
    # CLI / TUI
    "typer",
    "typer.core",
    "click",
    "rich",
    "prompt_toolkit",
    "prompt_toolkit.completion",
    "prompt_toolkit.formatted_text",
    "prompt_toolkit.history",
    "prompt_toolkit.key_binding",
    "prompt_toolkit.keys",
    "questionary",
    # Config / data
    "yaml",
    "dotenv",
    "tenacity",
    "simplejson",
    "json_repair",
    "chardet",
    # Search
    "ddgs",
    "ddgs.engines",
    "lxml",
    "lxml.html",
    "lxml.etree",
    "lxml._elementpath",
    "readability_lxml",
    # System utilities
    "psutil",
    "websockets",
    "websocket",
    "croniter",
    "filelock",
    # MCP
    "mcp",
    "mcp.server.fastmcp",
    "mcp.client.stdio",
    "mcp.client.streamable_http",
    # Document processing
    "docx",
    "docx.opc",
    "docx.oxml",
    "openpyxl",
    "openpyxl.workbook",
    "openpyxl.worksheet",
    "openpyxl.cell._writer",
    "pptx",
    "pptx.opc",
    "pptx.oxml",
    "pypdf",
    "pymupdf",
    "pdfplumber",
    # IM channel adapters
    "dingtalk_stream",
    "dingtalk_stream.chatbot",
    "lark_oapi",
    # Crypto / Auth
    "oauth_cli_kit",
    "tiktoken",
    # Jinja2
    "jinja2",
    # Git
    "dulwich",
    # AWS
    "boto3",
    "botocore",
    "urllib3",
    "requests",
    "requests.adapters",
    "requests.auth",
    "requests.cookies",
    "requests.exceptions",
    "requests.models",
    "requests.sessions",
    "requests.structures",
    "requests.utils",
    "charset_normalizer",
    # SQLite extensions
    "sqlite_vec",
    # Socket.IO
    "socketio",
    "engineio",
    "msgpack",
    # Python-socks
    "python_socks",
    "python_socks.async_.asyncio",
    # Browser automation (used by mona.agent.tools.browser)
    # playwright has many submodules (_impl, async_api, sync_api, _impl._driver, etc.)
    # that PyInstaller's static analysis misses because they're imported lazily.
    # collect_submodules() below adds them all.
]

# collect_submodules() dynamically discovers all submodules of a package,
# including those only imported via pkgutil.iter_modules (e.g. mona.agent.tools
# tool modules discovered at runtime by ToolLoader). Without this, PyInstaller
# static analysis misses terminal/email/notes/database/etc. tools and they
# silently fail to register at runtime.
hidden_imports = (
    hidden_imports_mona
    + hidden_imports_third_party
    + collect_submodules("mona")
    + collect_submodules("playwright")
)

# ============== Excludes ==============

excludes = [
    "tkinter",
    "matplotlib",
    "scipy",
    "pandas",
    "IPython",
    "notebook",
    "jupyter",
    "cv2",
    "opencv_python",
    "PyQt5",
    "PyQt6",
    "PySide2",
    "PySide6",
    "wx",
    "test",
    "tests",
    "pytest",
    "_pytest",
    "torch",
    "torchvision",
    "torchaudio",
    "zmq",
    "pyzmq",
    "whisper",
    "modelscope",
    "sentence_transformers",
    "chromadb",
]

# ============== Data Files ==============

datas = []
binaries = []

for package in ("trafilatura", "curl_cffi"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hidden_imports += package_hidden

# Playwright data files (driver binaries, browsers metadata)
datas += collect_data_files("playwright")

# Mona templates (Jinja2 markdown files used at runtime)
mona_templates = MONA_PKG / "templates"
if mona_templates.exists():
    datas.append((str(mona_templates), "mona/templates"))

# Skills execute these files by path; Python's import archive is not sufficient.
skill_root = MONA_PKG / "skills"
for path in sorted(skill_root.rglob("*.py")):
    if not {"tests", "test", "__pycache__", "node_modules", ".git"}.intersection(
        path.relative_to(skill_root).parts
    ) and "ai-image-comparison" not in path.parts:
        datas.append((str(path), "mona/" + path.parent.relative_to(MONA_PKG).as_posix()))

# Keep desktop resources within the tree copied by legacy hot updaters.
office_resources = PROJECT_ROOT / "src-tauri" / "resources" / "office-editor"
if not office_resources.is_dir():
    raise FileNotFoundError(f"Office resources missing: {office_resources}")
datas.append((str(office_resources), "desktop-resources/office-editor"))

# certifi CA bundle
try:
    import certifi
    _certifi_pem = certifi.where()
    _certifi_dir = str(Path(_certifi_pem).parent)
    datas.append((_certifi_dir, "certifi"))
    print(f"[spec] Bundling certifi CA bundle: {_certifi_pem}")
except ImportError:
    print("[spec] WARNING: certifi not installed, CA bundle not bundled")

# rich._unicode_data
try:
    import rich._unicode_data as _rud
    _rud_dir = str(Path(_rud.__file__).parent)
    datas.append((_rud_dir, "rich/_unicode_data"))
except ImportError:
    pass

# lark_oapi (Feishu SDK): auto-generated API files, must copy as data
try:
    import lark_oapi as _lark
    _lark_dir = str(Path(_lark.__file__).parent)
    datas.append((_lark_dir, "lark_oapi"))
    print(f"[spec] Bundling lark_oapi: {_lark_dir}")
except ImportError:
    print("[spec] WARNING: lark_oapi not installed, feishu channel will need runtime install")

# ============== Analysis ==============

a = Analysis(
    [str(MONA_PKG / "__main__.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)

# The packaged version follows this checkout, not the build host's metadata.
release_version = Version(tomllib.loads((PROJECT_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"])
metadata_dir = Path(workpath) / f"mona_ai-{release_version}.dist-info"
metadata_dir.mkdir(parents=True, exist_ok=True)
metadata_file = metadata_dir / "METADATA"
metadata_file.write_text(f"Metadata-Version: 2.1\nName: mona-ai\nVersion: {release_version}\n", encoding="utf-8")
a.datas = [
    entry for entry in a.datas
    if not entry[0].replace("\\", "/").split("/")[0].startswith(("mona_ai-", "mona-ai-"))
]
a.datas.append((f"{metadata_dir.name}/METADATA", str(metadata_file), "DATA"))

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

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
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="mona-gateway",
)
