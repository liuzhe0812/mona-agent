"""Official native engine release metadata; program bytes use VerifiedDownloader."""
from __future__ import annotations

import json
import platform
import re
import sys
from urllib.parse import urljoin

import httpx

from mona.runtime.catalog import RuntimeCatalogEntry, RuntimeCatalogError
from mona.runtime.executors import EXECUTOR_RUNTIMES
from mona.security.network import validate_url_target

CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases"
CODEBUDDY_RELEASES = "https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases"
CODEX_RELEASE = "https://releases.openai.com/codex/channels/latest"
_VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?")


async def _metadata(client: httpx.AsyncClient, url: str, *, head: bool = False) -> tuple[bytes, httpx.Headers]:
    for _ in range(6):
        allowed, reason = validate_url_target(url)
        if not allowed:
            raise RuntimeCatalogError(f"模型引擎发行地址不可访问：{reason}")
        async with client.stream("HEAD" if head else "GET", url) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise RuntimeCatalogError("模型引擎发行地址没有重定向目标。")
                url = urljoin(url, location)
                continue
            response.raise_for_status()
            body = bytearray()
            async for block in response.aiter_bytes():
                body.extend(block)
                if len(body) > 2 * 1024 * 1024:
                    raise RuntimeCatalogError("模型引擎发行清单超过大小限制。")
            return bytes(body), response.headers
    raise RuntimeCatalogError("模型引擎发行地址重定向过多。")


async def native_release_entry(executor: str, *, current_platform: str = sys.platform,
                               current_architecture: str | None = None,
                               transport: httpx.AsyncBaseTransport | None = None) -> RuntimeCatalogEntry:
    component, kind = EXECUTOR_RUNTIMES[executor]
    arch = current_architecture or {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower())
    if current_platform not in {"win32", "darwin", "linux"} or arch not in {"x64", "arm64"}:
        raise RuntimeCatalogError("此平台暂未提供对应模型引擎的官方程序。")
    target = f"{current_platform}-{arch}"
    binary = executor + (".exe" if current_platform == "win32" else "")
    async with httpx.AsyncClient(timeout=20, follow_redirects=False, transport=transport) as client:
        if executor == "codex":
            body, _ = await _metadata(client, CODEX_RELEASE)
            release = json.loads(body)
            version = str(release["tag_name"]).removeprefix("rust-v")
            triples = {("win32", "x64"): "x86_64-pc-windows-msvc", ("win32", "arm64"): "aarch64-pc-windows-msvc",
                ("darwin", "x64"): "x86_64-apple-darwin", ("darwin", "arm64"): "aarch64-apple-darwin",
                ("linux", "x64"): "x86_64-unknown-linux-musl", ("linux", "arm64"): "aarch64-unknown-linux-musl"}
            filenames = {f"codex-package-{triples[(current_platform, arch)]}.tar.gz",
                f"codex-package-{triples[(current_platform, arch)]}-{version}.tar.gz"}
            asset = next((item for item in release.get("assets", []) if item.get("name") in filenames), None)
            if not asset or not str(asset.get("digest", "")).startswith("sha256:"):
                raise RuntimeCatalogError("官方 Codex 程序包缺少对应平台资产或 SHA-256。")
            url, sha = asset["browser_download_url"], asset["digest"][7:]
            size = asset.get("size")
            if not size:
                _, headers = await _metadata(client, url, head=True)
                size = int(headers.get("content-length", "0"))
            artifact, entrypoint = "native-tar-gz", f"bin/{binary}"
        elif executor == "claude":
            body, _ = await _metadata(client, f"{CLAUDE_RELEASES}/stable")
            version = body.decode().strip()
            if not _VERSION.fullmatch(version):
                raise RuntimeCatalogError("Claude Code 版本清单格式无效。")
            body, _ = await _metadata(client, f"{CLAUDE_RELEASES}/{version}/manifest.json")
            manifest = json.loads(body)
            asset = manifest.get("platforms", {}).get(target)
            if not asset or asset.get("binary") != binary or manifest.get("version") != version:
                raise RuntimeCatalogError("官方 Claude Code 发行清单与平台不匹配。")
            url = f"{CLAUDE_RELEASES}/{version}/{target}/{binary}"
            sha, size = asset["checksum"], asset["size"]
            artifact, entrypoint = "native-binary", binary
        else:
            if current_platform == "win32" and arch != "x64":
                raise RuntimeCatalogError("官方 CodeBuddy CLI 暂未提供 Windows ARM64 版本。")
            body, _ = await _metadata(client, f"{CODEBUDDY_RELEASES}/latest")
            version = body.decode().strip()
            if not _VERSION.fullmatch(version):
                raise RuntimeCatalogError("CodeBuddy CLI 版本清单格式无效。")
            system = {"win32": "Windows", "darwin": "Darwin", "linux": "Linux"}[current_platform]
            filename = f"codebuddy-code_{system}_{'x86_64' if arch == 'x64' else 'arm64'}.{'zip' if current_platform == 'win32' else 'tar.gz'}"
            body, _ = await _metadata(client, f"{CODEBUDDY_RELEASES}/download/{version}/checksums.txt")
            hashes = {parts[1].lstrip("*"): parts[0] for line in body.decode().splitlines() if len(parts := line.split()) == 2}
            if filename not in hashes:
                raise RuntimeCatalogError("官方 CodeBuddy CLI 校验清单缺少对应平台资产。")
            url = f"{CODEBUDDY_RELEASES}/download/{version}/{filename}"
            _, headers = await _metadata(client, url, head=True)
            size = int(headers.get("content-length", "0"))
            sha = hashes[filename]
            artifact, entrypoint = "native-zip" if current_platform == "win32" else "native-tar-gz", binary
    if not _VERSION.fullmatch(version):
        raise RuntimeCatalogError("模型引擎版本清单格式无效。")
    return RuntimeCatalogEntry(id=component, kind=kind, version=f"{version}+{current_platform}.{arch}",
        download_url=url, sha256=sha, size=size, platforms=[current_platform], architectures=[arch],
        artifact_format=artifact, native_entrypoint=entrypoint)
