import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import mona.api.url2note as url2note
from mona.api.url2note import Url2NoteError, Url2NoteExtractor, parse_subtitle


def test_parse_subtitle_returns_timestamped_dialogue() -> None:
    subtitle = """1
00:00:01,000 --> 00:00:03,000
  第一行   字幕

2
00:00:04,000 --> 00:00:06,000
第二行字幕
"""

    assert parse_subtitle(subtitle) == "[00:00:01] 第一行 字幕\n[00:00:04] 第二行字幕"


class _Runtime:
    def get_ytdlp_path(self) -> str:
        return "yt-dlp.exe"

    def get_ffmpeg_path(self) -> str:
        return "ffmpeg.exe"


class _Fetcher:
    async def execute(self, _url: str, **_kwargs: object) -> str:
        return json.dumps(
            {
                "finalUrl": "https://example.com/post",
                "text": "# 技术文章\n\n有效正文",
            },
            ensure_ascii=False,
        )


class _InstallingRuntime:
    def __init__(self) -> None:
        self.installed: list[str] = []

    def get_ytdlp_path(self) -> str | None:
        return "yt-dlp.exe" if "yt_dlp" in self.installed else None

    def get_ffmpeg_path(self) -> str | None:
        return "ffmpeg.exe" if "ffmpeg" in self.installed else None

    async def ensure_runtime(self, component: str) -> dict[str, str | bool]:
        self.installed.append(component)
        return {"ok": True, "path": f"{component}.exe"}


@pytest.mark.asyncio
async def test_video_uses_audio_when_no_subtitle(monkeypatch: pytest.MonkeyPatch) -> None:
    transcribed: list[bytes] = []

    async def transcribe(audio: bytes, filename: str) -> str:
        assert filename == "audio.mp3"
        transcribed.append(audio)
        return "转写文本"

    extractor = Url2NoteExtractor(runtime=_Runtime(), transcribe=transcribe)

    async def no_subtitle(*_args: object) -> str:
        return ""

    async def audio(
        _ytdlp: str, _ffmpeg: str, _url: str, workdir: Path
    ) -> Path:
        output = workdir / "audio.mp3"
        output.write_bytes(b"audio")
        return output

    monkeypatch.setattr(extractor, "_download_subtitle", no_subtitle)
    monkeypatch.setattr(extractor, "_download_audio", audio)

    source = await extractor.extract("https://www.bilibili.com/video/BV1")

    assert source.kind == "video"
    assert source.text == "转写文本"
    assert transcribed == [b"audio"]


@pytest.mark.asyncio
async def test_article_uses_readable_web_content() -> None:
    extractor = Url2NoteExtractor(runtime=_Runtime(), web_fetcher=_Fetcher())

    source = await extractor.extract("https://example.com/post")

    assert source.kind == "article"
    assert source.title == "技术文章"
    assert source.text.endswith("有效正文")


@pytest.mark.asyncio
async def test_download_subtitle_prefers_chinese_track(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []

    async def run(command: list[str], workdir: Path) -> None:
        commands.append(command)
        (workdir / "subtitle.en.vtt").write_text(
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEnglish", encoding="utf-8"
        )
        (workdir / "subtitle.zh-Hans.srt").write_text(
            "1\n00:00:01,000 --> 00:00:02,000\n中文", encoding="utf-8"
        )

    monkeypatch.setattr(url2note, "_run_process", run, raising=False)
    extractor = Url2NoteExtractor(runtime=_Runtime())

    subtitle = await extractor._download_subtitle("yt-dlp.exe", "https://example.com", tmp_path)

    assert subtitle == "[00:00:01] 中文"
    assert "--write-auto-subs" in commands[0]


@pytest.mark.asyncio
async def test_video_installs_only_ytdlp_when_subtitle_exists(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = _InstallingRuntime()
    extractor = Url2NoteExtractor(runtime=runtime)

    async def subtitle(*_args: object) -> str:
        return "[00:00:01] 字幕"

    monkeypatch.setattr(extractor, "_download_subtitle", subtitle)

    source = await extractor.extract("https://www.bilibili.com/video/BV1")

    assert source.text == "[00:00:01] 字幕"
    assert runtime.installed == ["yt_dlp"]


@pytest.mark.asyncio
async def test_download_audio_converts_to_small_mono_mp3(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands: list[list[str]] = []

    async def run(command: list[str], workdir: Path) -> None:
        commands.append(command)
        if command[0] == "yt-dlp.exe":
            (workdir / "source.m4a").write_bytes(b"source")
        else:
            (workdir / "audio.mp3").write_bytes(b"audio")

    monkeypatch.setattr(url2note, "_run_process", run)
    extractor = Url2NoteExtractor(runtime=_Runtime())

    audio = await extractor._download_audio(
        "yt-dlp.exe", "ffmpeg.exe", "https://example.com", tmp_path
    )

    assert audio.name == "audio.mp3"
    assert "-ac" in commands[1]
    assert "32k" in commands[1]


@pytest.mark.asyncio
async def test_subtitle_download_failure_uses_audio_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def fail(_command: list[str], _workdir: Path) -> None:
        raise Url2NoteError("No subtitles")

    monkeypatch.setattr(url2note, "_run_process", fail)
    extractor = Url2NoteExtractor(runtime=_Runtime())

    assert await extractor._download_subtitle("yt-dlp.exe", "https://example.com", tmp_path) == ""


@pytest.mark.asyncio
async def test_default_transcriber_uses_configured_provider(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    received: dict[str, object] = {}

    class Provider:
        def __init__(self, language: str | None = None) -> None:
            received["language"] = language

        async def transcribe_bytes(self, audio: bytes, filename: str) -> str:
            received["audio"] = audio
            received["filename"] = filename
            return "转写"

    monkeypatch.setattr(
        url2note,
        "load_config",
        lambda: SimpleNamespace(
            channels=SimpleNamespace(transcription_provider="groq", transcription_language="zh")
        ),
        raising=False,
    )
    monkeypatch.setattr(url2note, "GroqTranscriptionProvider", Provider, raising=False)

    assert await url2note._transcribe_with_config(b"audio", "audio.mp3") == "转写"
    assert received == {"language": "zh", "audio": b"audio", "filename": "audio.mp3"}
