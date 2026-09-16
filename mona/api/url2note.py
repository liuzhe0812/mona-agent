"""Shared URL extraction for browser and Agent Markdown notes."""

from __future__ import annotations

import asyncio
import base64
import html
import json
import locale
import re
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from mona.api.video_runtime import VideoRuntime
from mona.security.network import validate_url_target

_MAX_AUDIO_BYTES = 25 * 1024 * 1024
_SUBTITLE_EXTENSIONS = ("*.srt", "*.vtt")
_SUBTITLE_LANGUAGES = "zh.*,zh-Hans,zh-Hant,en.*,en-US"
_MAX_FRAMES = 8
_MAX_NOTE_FRAMES = 3
_FRAME_TIMEOUT = 60
_TIMESTAMP_PATTERN = re.compile(
    r"^(?:(?:[0-9]{1,2}:)?[0-5]?[0-9]:)?[0-5]?[0-9](?:\.\d+)?$"
)
_TOUTIAO_ARTICLE_PATTERN = re.compile(r"^/article/(\d+)(?:/|$)")


class Url2NoteError(RuntimeError):
    """A user-facing URL extraction failure."""


@dataclass(frozen=True)
class Url2NoteSource:
    title: str
    url: str
    kind: str
    text: str
    frames: tuple["Url2NoteFrame", ...] = ()


@dataclass(frozen=True)
class Url2NoteFrame:
    timestamp: str
    file_name: str
    data_base64: str


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
        # 延迟导入 WebFetchTool 避免循环导入：
        # mona.api.url2note → mona.agent.tools.web → mona.agent.tools (包初始化)
        # → mona.agent.tools.url2note → mona.api.url2note
        if web_fetcher is not None:
            self._web_fetcher = web_fetcher
        else:
            from mona.agent.tools.web import WebFetchTool
            self._web_fetcher = WebFetchTool()
        self._transcribe = transcribe

    async def extract(self, url: str, *, include_keyframes: bool = False) -> Url2NoteSource:
        url = url.strip(" \t\r\n`\"'")
        valid, error = validate_url_target(url)
        if not valid:
            raise Url2NoteError(f"URL validation failed: {error}")
        if is_video_url(url):
            return await self._extract_video(url, include_keyframes=include_keyframes)
        return await self._extract_article(url)

    async def _extract_article(self, url: str) -> Url2NoteSource:
        article_id = _toutiao_article_id(url)
        if article_id:
            source = await self._extract_toutiao_article(url, article_id)
            if source:
                return source

        raw = await self._web_fetcher.execute(url, extract_mode="markdown")
        if not isinstance(raw, str):
            raise Url2NoteError("Unable to extract readable page content")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise Url2NoteError("Unable to parse extracted page content") from exc
        if payload.get("error"):
            raise Url2NoteError(str(payload["error"]))
        if payload.get("requiresInteraction") is True:
            raise Url2NoteError("The page requires login or interactive verification")
        if payload.get("quality") == "low":
            raise Url2NoteError("The page could not be extracted with reliable quality")
        text = str(payload.get("text") or "").strip()
        if not text or not _has_article_content(text):
            raise Url2NoteError("The page has no readable text")
        return Url2NoteSource(
            _title_from_text(text, url),
            str(payload.get("finalUrl") or url),
            "article",
            text,
        )

    async def _extract_toutiao_article(
        self, url: str, article_id: str
    ) -> Url2NoteSource | None:
        # ponytail: 桌面页是 JS 验证壳，直接读取同站移动端正文数据。
        try:
            async with httpx.AsyncClient(
                proxy=getattr(self._web_fetcher, "proxy", None), timeout=20.0
            ) as client:
                response = await client.get(
                    f"https://m.toutiao.com/i{article_id}/info/",
                    headers={
                        "User-Agent": getattr(
                            self._web_fetcher, "user_agent", "Mozilla/5.0"
                        )
                    },
                )
                response.raise_for_status()
            data = response.json().get("data") or {}
            title = str(data.get("title") or "").strip()
            content = _html_to_text(str(data.get("content") or ""))
            if title and content:
                return Url2NoteSource(title, url, "article", f"# {title}\n\n{content}")
        except Exception:
            return None
        return None

    async def _extract_video(
        self, url: str, *, include_keyframes: bool = False
    ) -> Url2NoteSource:
        ytdlp = await self._ensure_component("yt_dlp")
        with tempfile.TemporaryDirectory(prefix="mona-url2note-") as temp:
            workdir = Path(temp)
            title = await self._video_title(ytdlp, url, workdir)
            subtitle = await self._download_subtitle(ytdlp, url, workdir)
            if subtitle:
                frames: tuple[Url2NoteFrame, ...] = ()
                timestamps = select_keyframe_timestamps(subtitle) if include_keyframes else []
                if timestamps:
                    try:
                        ffmpeg = await self._ensure_component("ffmpeg")
                        video = await self._download_video(ytdlp, url, workdir)
                        frames = await self._extract_note_frames(
                            ffmpeg, video, timestamps, workdir, url
                        )
                    except Url2NoteError:
                        frames = ()
                return Url2NoteSource(
                    title, url, "video", subtitle, frames
                )
            ffmpeg = await self._ensure_component("ffmpeg")
            audio = await self._download_audio(ytdlp, ffmpeg, url, workdir)
            if self._transcribe is not None:
                if audio.stat().st_size > _MAX_AUDIO_BYTES:
                    raise Url2NoteError("Audio is too large to transcribe; use a shorter video")
                text = (await self._transcribe(audio.read_bytes(), audio.name)).strip()
            else:
                text = (await self._transcribe_local(audio)).strip()
            if not text:
                raise Url2NoteError("Audio transcription returned no text")
            frames = ()
            timestamps = select_keyframe_timestamps(text) if include_keyframes else []
            if timestamps:
                video = next(
                    (
                        path
                        for path in workdir.glob("source.*")
                        if path.suffix not in {".part", ".ytdl"}
                    ),
                    None,
                )
                if video is not None:
                    try:
                        frames = await self._extract_note_frames(
                            ffmpeg, video, timestamps, workdir, url
                        )
                    except Url2NoteError:
                        frames = ()
            return Url2NoteSource(title, url, "video", text, frames)

    async def _video_title(self, ytdlp: str, url: str, workdir: Path) -> str:
        try:
            raw = await _run_process_output(
                [
                    ytdlp,
                    "--no-playlist",
                    "--skip-download",
                    "--print",
                    "%(title)s",
                    url,
                ],
                workdir,
                timeout=60,
            )
            title = next((line.strip() for line in raw.splitlines() if line.strip()), "")
            return title or _title_from_url(url)
        except Url2NoteError:
            return _title_from_url(url)

    async def _transcribe_local(self, audio: Path) -> str:
        result = await self._runtime.ensure_runtime("asr")
        if not result.get("ok"):
            raise Url2NoteError(
                str(result.get("error") or "Unable to install local transcription runtime")
            )
        executable = str(result.get("path") or "")
        model = str(result.get("modelPath") or "")
        vad = str(result.get("vadPath") or "")
        if not executable or not model or not vad:
            raise Url2NoteError("Local transcription runtime is incomplete")
        raw = await _run_process_output(
            [executable, "-m", model, "--vad", vad, "--srt", "-a", str(audio.resolve())],
            audio.parent,
        )
        timestamped = parse_subtitle(raw)
        return timestamped or raw.strip()

    async def _extract_note_frames(
        self,
        ffmpeg: str,
        video: Path,
        timestamps: list[str],
        workdir: Path,
        url: str,
    ) -> tuple[Url2NoteFrame, ...]:
        frames: list[Url2NoteFrame] = []
        source_id = re.sub(r"\D+", "", urlparse(url).path)[-20:] or "video"
        for index, timestamp in enumerate(timestamps[:_MAX_NOTE_FRAMES], start=1):
            output = workdir / f"url-note-{source_id}-{index:02d}-{_sanitize_ts(timestamp)}.jpg"
            await _run_process(
                [
                    ffmpeg,
                    "-y",
                    "-ss",
                    timestamp,
                    "-i",
                    str(video),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale='min(960,iw)':-2",
                    "-q:v",
                    "3",
                    str(output),
                ],
                workdir,
                timeout=_FRAME_TIMEOUT,
            )
            if output.is_file() and output.stat().st_size > 0:
                frames.append(
                    Url2NoteFrame(
                        timestamp=timestamp,
                        file_name=output.name,
                        data_base64=base64.b64encode(output.read_bytes()).decode("ascii"),
                    )
                )
        if not frames:
            raise Url2NoteError("Frame extraction produced no images")
        return tuple(frames)

    async def extract_frames(self, url: str, timestamps: list[str]) -> list[Path]:
        """Download the video once and extract keyframes at the given timestamps.

        Returns a list of temporary PNG file paths, one per valid timestamp.
        Caller is responsible for moving/copying the files out before the
        temp dir is reused; this method does not clean up the files itself.
        """
        url = url.strip(" \t\r\n`\"'")
        valid, error = validate_url_target(url)
        if not valid:
            raise Url2NoteError(f"URL validation failed: {error}")
        if not is_video_url(url):
            raise Url2NoteError("Frame extraction only supports video URLs")
        if not timestamps:
            raise Url2NoteError("No timestamps provided")
        if len(timestamps) > _MAX_FRAMES:
            raise Url2NoteError(
                f"Too many timestamps: {len(timestamps)} > {_MAX_FRAMES}. "
                "Pass at most 8 timestamps per call."
            )

        normalized: list[str] = []
        for ts in timestamps:
            cleaned = str(ts).strip().replace(",", ".")
            if not _TIMESTAMP_PATTERN.match(cleaned):
                raise Url2NoteError(f"Invalid timestamp: {ts!r} (use HH:MM:SS or MM:SS)")
            normalized.append(cleaned)

        ytdlp = await self._ensure_component("yt_dlp")
        ffmpeg = await self._ensure_component("ffmpeg")
        workdir = Path(tempfile.mkdtemp(prefix="mona-frame-"))
        try:
            video = await self._download_video(ytdlp, url, workdir)
            frames: list[Path] = []
            for index, ts in enumerate(normalized, start=1):
                output = workdir / f"frame-{index:03d}-{_sanitize_ts(ts)}.png"
                await _run_process(
                    [
                        ffmpeg,
                        "-y",
                        "-ss",
                        ts,
                        "-i",
                        str(video),
                        "-frames:v",
                        "1",
                        "-q:v",
                        "3",
                        str(output),
                    ],
                    workdir,
                    timeout=_FRAME_TIMEOUT,
                )
                if output.is_file() and output.stat().st_size > 0:
                    frames.append(output)
            if not frames:
                raise Url2NoteError("Frame extraction produced no images")
            return frames
        except Exception:
            # Best-effort cleanup on failure; on success the caller owns the files.
            shutil.rmtree(workdir, ignore_errors=True)
            raise

    async def _download_video(self, ytdlp: str, url: str, workdir: Path) -> Path:
        template = str(workdir / "source.%(ext)s")
        await _run_process(
            [ytdlp, "--no-playlist", "-f", "best", "-o", template, url],
            workdir,
        )
        source = next(
            (path for path in workdir.glob("source.*") if path.suffix not in {".part", ".ytdl"}),
            None,
        )
        if source is None:
            raise Url2NoteError("Unable to download video for frame extraction")
        return source

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


async def _run_process(command: list[str], workdir: Path, *, timeout: float = 600) -> None:
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
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise Url2NoteError("URL extraction timed out") from exc
    if process.returncode != 0:
        detail = _decode_process_bytes(stderr).strip()
        raise Url2NoteError(detail or "URL extraction failed")


async def _run_process_output(
    command: list[str], workdir: Path, *, timeout: float = 600
) -> str:
    """Run a short-lived helper and return stdout after all resources exit."""
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
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.CancelledError:
        process.kill()
        await process.wait()
        raise
    except TimeoutError as exc:
        process.kill()
        await process.wait()
        raise Url2NoteError("URL extraction timed out") from exc
    if process.returncode != 0:
        detail = _decode_process_bytes(stderr).strip()
        raise Url2NoteError(detail or "URL extraction failed")
    return _decode_process_bytes(stdout)


def _decode_process_bytes(content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        encoding = locale.getpreferredencoding(False) or "utf-8"
        return content.decode(encoding, "replace")


def _sanitize_ts(ts: str) -> str:
    """Make a timestamp safe for use in a filename."""
    return ts.replace(":", "m").replace(".", "s")


def select_keyframe_timestamps(text: str, *, limit: int = _MAX_NOTE_FRAMES) -> list[str]:
    """Pick a few transcript moments where the spoken content is likely visual."""
    visual_terms = (
        "画面",
        "屏幕",
        "界面",
        "图中",
        "如图",
        "这里可以看到",
        "大家看",
        "看这里",
        "显示",
        "点击",
        "输入",
        "切换",
        "代码",
        "架构图",
        "流程图",
        "演示",
    )
    important_terms = ("重点", "关键", "核心", "步骤", "流程", "架构", "配置", "参数", "结果")
    candidates: list[tuple[int, int, str]] = []
    pattern = re.compile(r"^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)$")
    for position, line in enumerate(text.splitlines()):
        match = pattern.match(line.strip())
        if not match:
            continue
        timestamp, caption = match.groups()
        score = sum(4 for term in visual_terms if term in caption)
        score += sum(2 for term in important_terms if term in caption)
        if score == 0:
            continue
        candidates.append((score, position, _normalize_timestamp(timestamp)))

    selected: list[tuple[int, int, str]] = []
    for candidate in sorted(candidates, key=lambda item: (-item[0], item[1])):
        seconds = _timestamp_seconds(candidate[2])
        if any(abs(seconds - _timestamp_seconds(item[2])) < 30 for item in selected):
            continue
        selected.append(candidate)
        if len(selected) >= max(0, limit):
            break
    return [item[2] for item in sorted(selected, key=lambda item: _timestamp_seconds(item[2]))]


def _normalize_timestamp(value: str) -> str:
    parts = value.split(":")
    if len(parts) == 2:
        return f"00:{int(parts[0]):02d}:{int(parts[1]):02d}"
    return f"{int(parts[0]):02d}:{int(parts[1]):02d}:{int(parts[2]):02d}"


def _timestamp_seconds(value: str) -> int:
    hours, minutes, seconds = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def _title_from_url(url: str) -> str:
    return urlparse(url).hostname or "网页笔记"


def _toutiao_article_id(url: str) -> str | None:
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in {
        "toutiao.com",
        "www.toutiao.com",
        "m.toutiao.com",
    }:
        return None
    match = _TOUTIAO_ARTICLE_PATTERN.match(parsed.path)
    return match.group(1) if match else None


def _html_to_text(content: str) -> str:
    content = re.sub(r"<br\s*/?>|</(?:p|div|h[1-6]|li)\s*>", "\n", content, flags=re.I)
    content = re.sub(r"<[^>]+>", "", content)
    content = html.unescape(content).replace("\xa0", " ")
    content = re.sub(r"[ \t]+\n", "\n", content)
    return re.sub(r"\n{3,}", "\n\n", content).strip()


def _has_article_content(text: str) -> bool:
    meaningful = "\n".join(
        line
        for line in text.splitlines()
        if not line.startswith("[External content")
        and line.strip().casefold() != "# [no-title]"
    )
    return bool(meaningful.strip())


def _title_from_text(text: str, url: str) -> str:
    for line in text.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            if title and title.casefold() != "[no-title]":
                return title
    return _title_from_url(url)
