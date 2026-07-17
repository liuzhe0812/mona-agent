"""Shared URL extraction for browser and Agent Markdown notes."""

from __future__ import annotations

import asyncio
import html
import json
import re
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from mona.agent.tools.web import WebFetchTool
from mona.api.video_runtime import VideoRuntime
from mona.providers.transcription import GroqTranscriptionProvider, OpenAITranscriptionProvider
from mona.security.network import validate_url_target

_MAX_AUDIO_BYTES = 25 * 1024 * 1024
_SUBTITLE_EXTENSIONS = ("*.srt", "*.vtt")
_SUBTITLE_LANGUAGES = "zh.*,zh-Hans,zh-Hant,en.*,en-US"


class Url2NoteError(RuntimeError):
    """A user-facing URL extraction failure."""


@dataclass(frozen=True)
class Url2NoteSource:
    title: str
    url: str
    kind: str
    text: str


def parse_subtitle(content: str) -> str:
    """Convert SRT or WebVTT content to compact, timestamped dialogue."""
    entries: list[str] = []
    for block in re.split(r"\r?\n\s*\r?\n", content):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if timing_index is None:
            continue
        stamp = lines[timing_index].split("-->", 1)[0].strip()
        stamp = re.sub(r"[,.]\d{3}$", "", stamp)
        caption = " ".join(lines[timing_index + 1 :])
        caption = re.sub(r"<[^>]+>", "", caption)
        caption = re.sub(r"\s+", " ", html.unescape(caption)).strip()
        if caption:
            entries.append(f"[{stamp}] {caption}")
    return "\n".join(entries)


def is_video_url(url: str) -> bool:
    """Identify the public video URL families supported by the first release."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    # ponytail: avoid provisioning yt-dlp for ordinary articles; add hosts on demand.
    return host.endswith(("bilibili.com", "b23.tv", "douyin.com", "iesdouyin.com")) or (
        host.endswith("toutiao.com") and "/video/" in parsed.path
    )


class Url2NoteExtractor:
    """Extract source content for a URL note."""

    def __init__(
        self,
        *,
        runtime: VideoRuntime | None = None,
        web_fetcher: Any | None = None,
        transcribe: Callable[[bytes, str], Awaitable[str]] | None = None,
    ) -> None:
        self._runtime = runtime or VideoRuntime()
        self._web_fetcher = web_fetcher or WebFetchTool()
        self._transcribe = transcribe or _transcribe_with_config

    async def extract(self, url: str) -> Url2NoteSource:
        url = url.strip(" \t\r\n`\"'")
        valid, error = validate_url_target(url)
        if not valid:
            raise Url2NoteError(f"URL validation failed: {error}")
        if is_video_url(url):
            return await self._extract_video(url)
        return await self._extract_article(url)

    async def _extract_article(self, url: str) -> Url2NoteSource:
        raw = await self._web_fetcher.execute(url, extract_mode="markdown")
        if not isinstance(raw, str):
            raise Url2NoteError("Unable to extract readable page content")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise Url2NoteError("Unable to parse extracted page content") from exc
        if payload.get("error"):
            raise Url2NoteError(str(payload["error"]))
        text = str(payload.get("text") or "").strip()
        if not text:
            raise Url2NoteError("The page has no readable text")
        return Url2NoteSource(
            _title_from_text(text, url),
            str(payload.get("finalUrl") or url),
            "article",
            text,
        )

    async def _extract_video(self, url: str) -> Url2NoteSource:
        ytdlp = await self._ensure_component("yt_dlp")
        with tempfile.TemporaryDirectory(prefix="mona-url2note-") as temp:
            workdir = Path(temp)
            subtitle = await self._download_subtitle(ytdlp, url, workdir)
            if subtitle:
                return Url2NoteSource(_title_from_url(url), url, "video", subtitle)
            ffmpeg = await self._ensure_component("ffmpeg")
            audio = await self._download_audio(ytdlp, ffmpeg, url, workdir)
            if audio.stat().st_size > _MAX_AUDIO_BYTES:
                raise Url2NoteError("Audio is too large to transcribe; use a shorter video")
            text = (await self._transcribe(audio.read_bytes(), audio.name)).strip()
            if not text:
                raise Url2NoteError("Audio transcription returned no text")
            return Url2NoteSource(_title_from_url(url), url, "video", text)

    async def _ensure_component(self, component: str) -> str:
        path = (
            self._runtime.get_ytdlp_path()
            if component == "yt_dlp"
            else self._runtime.get_ffmpeg_path()
        )
        if path:
            return path
        result = await self._runtime.ensure_runtime(component)
        if not result.get("ok") or not result.get("path"):
            raise Url2NoteError(str(result.get("error") or f"Unable to install {component}"))
        return str(result["path"])

    async def _download_subtitle(self, ytdlp: str, url: str, workdir: Path) -> str:
        output = str(workdir / "subtitle.%(language)s.%(ext)s")
        try:
            await _run_process(
                [
                    ytdlp,
                    "--no-playlist",
                    "--skip-download",
                    "--write-subs",
                    "--write-auto-subs",
                    "--sub-langs",
                    _SUBTITLE_LANGUAGES,
                    "-o",
                    output,
                    url,
                ],
                workdir,
            )
        except Url2NoteError:
            return ""
        files = [path for pattern in _SUBTITLE_EXTENSIONS for path in workdir.glob(pattern)]
        files.sort(key=lambda path: ("zh" not in path.name.lower(), path.name))
        for path in files:
            text = parse_subtitle(path.read_text(encoding="utf-8", errors="replace"))
            if text:
                return text
        return ""

    async def _download_audio(
        self, ytdlp: str, ffmpeg: str, url: str, workdir: Path
    ) -> Path:
        source_template = str(workdir / "source.%(ext)s")
        await _run_process(
            [ytdlp, "--no-playlist", "-f", "bestaudio/best", "-o", source_template, url],
            workdir,
        )
        source = next(
            (path for path in workdir.glob("source.*") if path.suffix not in {".part", ".ytdl"}),
            None,
        )
        if source is None:
            raise Url2NoteError("Unable to download video audio")
        output = workdir / "audio.mp3"
        await _run_process(
            [
                ffmpeg,
                "-y",
                "-i",
                str(source),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "32k",
                str(output),
            ],
            workdir,
        )
        if not output.is_file():
            raise Url2NoteError("Unable to convert video audio")
        return output


async def _transcribe_with_config(audio: bytes, filename: str) -> str:
    from mona.config.loader import load_config
    channels = load_config().channels
    language = channels.transcription_language or None
    if channels.transcription_provider == "openai":
        provider = OpenAITranscriptionProvider(language=language)
    else:
        provider = GroqTranscriptionProvider(language=language)
    return await provider.transcribe_bytes(audio, filename=filename)


async def _run_process(command: list[str], workdir: Path) -> None:
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise Url2NoteError(f"Required component is unavailable: {command[0]}") from exc
    try:
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=600)
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise Url2NoteError("URL extraction timed out") from exc
    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip()
        raise Url2NoteError(detail or "URL extraction failed")


def _title_from_url(url: str) -> str:
    return urlparse(url).hostname or "网页笔记"


def _title_from_text(text: str, url: str) -> str:
    for line in text.splitlines():
        if line.startswith("# ") and line[2:].strip():
            return line[2:].strip()
    return _title_from_url(url)
