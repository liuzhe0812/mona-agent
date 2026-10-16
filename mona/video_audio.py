"""Validated project audio timeline and FFmpeg command construction."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Mapping

from mona.video_assets import list_project_assets

_AUDIO_EXTENSIONS = {".m4a", ".mp3", ".wav"}
_VIDEO_EXTENSIONS = {".mp4", ".webm"}
_TRACK_FIELDS = {
    "assetId",
    "role",
    "startSeconds",
    "sourceStartSeconds",
    "durationSeconds",
    "volume",
    "loop",
}
_PRESET_GAINS = {"ambient": 0.10, "rhythmic": 0.15, "brand": 0.20}
_MAX_GAIN = 4.0
_SAMPLE_RATE = 48_000


@dataclass(frozen=True)
class _Track:
    asset_id: str
    role: str
    path: Path
    start: float
    source_start: float
    duration: float
    volume: float
    loop: bool
    legacy_music: bool = False


def _number(value: Any, field: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} 必须是数字")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field} 必须是有限数字")
    if number <= 0 if positive else number < 0:
        boundary = "必须大于 0" if positive else "不能小于 0"
        raise ValueError(f"{field} {boundary}")
    return number


def _seconds(value: float) -> str:
    return f"{value:.9f}".rstrip("0").rstrip(".") or "0"


def _inside(path: Path, root: Path, label: str) -> Path:
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} 必须位于当前视频项目内") from exc
    return resolved


def _resolve_asset(
    project_root: Path,
    record: Mapping[str, Any],
    role: str,
    asset_durations: Mapping[str, float] | None,
) -> tuple[Path, float]:
    asset_id = record.get("id")
    relative = record.get("path")
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError(f"素材 {asset_id} 没有有效路径")
    normalized = relative.replace("\\", "/")
    posix = PurePosixPath(normalized)
    windows = PureWindowsPath(normalized)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
        or ".." in posix.parts
        or not normalized.startswith("assets/")
    ):
        raise ValueError(f"素材 {asset_id} 路径无效")

    assets_root = (project_root / "assets").resolve(strict=True)
    try:
        assets_root.relative_to(project_root)
    except ValueError as exc:
        raise ValueError("项目素材目录必须位于当前视频项目内") from exc
    path = _inside(project_root / normalized, assets_root, f"素材 {asset_id}")

    extension = path.suffix.lower()
    kind = str(record.get("kind") or "").lower()
    mime_type = str(record.get("mimeType") or "").lower()
    mime_kind = mime_type.split("/", 1)[0] if "/" in mime_type else ""
    if role == "source":
        valid = extension in _VIDEO_EXTENSIONS and kind in {"", "video"} and mime_kind in {"", "video"}
    else:
        valid = extension in _AUDIO_EXTENSIONS and kind in {"", "audio"} and mime_kind in {"", "audio"}
    if not valid:
        raise ValueError(f"素材 {asset_id} 与 {role} 音轨类型不匹配")

    duration_value: Any = None
    if asset_durations is not None:
        duration_value = asset_durations.get(str(asset_id))
    if duration_value is None:
        duration_value = record.get("durationSeconds", record.get("duration"))
    if duration_value is None:
        raise ValueError(f"素材 {asset_id} 缺少已探测的媒体时长")
    duration = _number(duration_value, f"素材 {asset_id} 时长", positive=True)
    return path, duration


def _read_tracks(
    project_root: Path,
    meta: Mapping[str, Any],
    timeline_duration: float,
    asset_durations: Mapping[str, float] | None,
) -> list[_Track]:
    raw_tracks = meta.get("audioTracks", [])
    if not isinstance(raw_tracks, list):
        raise ValueError("audioTracks 必须是列表")

    assets = list_project_assets(project_root)
    records: dict[str, Mapping[str, Any]] = {}
    for asset in assets:
        asset_id = asset.get("id")
        if isinstance(asset_id, str):
            if asset_id in records:
                raise ValueError(f"项目素材台账中的 ID 重复: {asset_id}")
            records[asset_id] = asset

    tracks: list[_Track] = []
    explicit_music_ids: set[str] = set()
    for index, item in enumerate(raw_tracks):
        if not isinstance(item, Mapping):
            raise ValueError(f"第 {index + 1} 条音轨格式无效")
        if any(not isinstance(key, str) for key in item):
            raise ValueError(f"第 {index + 1} 条音轨字段名无效")
        extra = set(item) - _TRACK_FIELDS
        if extra:
            raise ValueError(f"第 {index + 1} 条音轨包含未知字段: {', '.join(sorted(extra))}")

        asset_id = item.get("assetId")
        role = item.get("role")
        if not isinstance(asset_id, str) or not asset_id:
            raise ValueError(f"第 {index + 1} 条音轨缺少素材 ID")
        if not isinstance(role, str) or role not in {"music", "effect", "source"}:
            raise ValueError(f"第 {index + 1} 条音轨角色无效")
        record = records.get(asset_id)
        if record is None:
            raise ValueError(f"音轨素材不在当前项目台账中: {asset_id}")
        path, asset_duration = _resolve_asset(project_root, record, role, asset_durations)

        start = _number(item.get("startSeconds"), f"第 {index + 1} 条音轨开始时间")
        source_start = _number(item.get("sourceStartSeconds", 0), f"第 {index + 1} 条音轨素材起点")
        duration = _number(item.get("durationSeconds"), f"第 {index + 1} 条音轨时长", positive=True)
        volume = _number(item.get("volume", 1), f"第 {index + 1} 条音轨音量")
        loop = item.get("loop", False)
        if not isinstance(loop, bool):
            raise ValueError(f"第 {index + 1} 条音轨 loop 必须是布尔值")
        if volume > _MAX_GAIN:
            raise ValueError(f"第 {index + 1} 条音轨音量不能大于 {_MAX_GAIN:g}")
        if start + duration > timeline_duration + 1e-9:
            raise ValueError(f"第 {index + 1} 条音轨超出视频片尾")
        if source_start >= asset_duration or (not loop and source_start + duration > asset_duration + 1e-9):
            raise ValueError(f"第 {index + 1} 条音轨超出素材时长")

        tracks.append(_Track(asset_id, role, path, start, source_start, duration, volume, loop))
        if role == "music":
            explicit_music_ids.add(asset_id)

    preset = meta.get("musicPreset") or "none"
    asset_id = meta.get("musicAssetId") or ""
    if preset not in {"none", *_PRESET_GAINS}:
        raise ValueError("背景音乐预设无效")
    if preset != "none":
        if not isinstance(asset_id, str) or not asset_id:
            raise ValueError("背景音乐缺少项目素材 ID")
        if asset_id not in explicit_music_ids:
            record = records.get(asset_id)
            if record is None:
                raise ValueError(f"背景音乐不在当前项目台账中: {asset_id}")
            path, asset_duration = _resolve_asset(project_root, record, "music", asset_durations)
            if asset_duration <= 0:
                raise ValueError("背景音乐时长无效")
            tracks.append(
                _Track(
                    asset_id,
                    "music",
                    path,
                    0,
                    0,
                    timeline_duration,
                    _PRESET_GAINS[preset],
                    True,
                    legacy_music=True,
                )
            )
    return tracks


def build_audio_mix_command(
    project_dir: Path | str,
    meta: Mapping[str, Any],
    *,
    ffmpeg_path: Path | str,
    output_path: Path | str,
    timeline_duration: float,
    voice_path: Path | str | None = None,
    window_start: float = 0,
    window_duration: float | None = None,
    asset_durations: Mapping[str, float] | None = None,
) -> list[str]:
    """Build an AAC audio-mix command for a full timeline or a global-time window.

    ``voice_path`` is supplied by the application and must resolve inside the project.
    ``asset_durations`` contains ffprobe durations keyed by project asset ID.
    Windows are mixed from the project start before trimming so compressor and fade state
    match a full mix. The output is an audio-only M4A file for the caller to mux.
    """
    if not isinstance(meta, Mapping):
        raise ValueError("视频元数据格式无效")
    root = Path(project_dir).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("视频项目路径无效")
    total = _number(timeline_duration, "视频总时长", positive=True)
    start = _number(window_start, "预览起始时间")
    duration = total - start if window_duration is None else _number(window_duration, "预览时长", positive=True)
    if duration <= 0 or start + duration > total + 1e-9:
        raise ValueError("预览时间范围超出视频片尾")
    mix_end = start + duration

    tracks = _read_tracks(root, meta, total, asset_durations)
    voice: Path | None = None
    if voice_path is not None:
        voice = _inside(Path(voice_path), root, "旁白")
        if not voice.is_file():
            raise ValueError("旁白文件不存在")
        if voice.suffix.lower() not in _AUDIO_EXTENSIONS:
            raise ValueError("旁白文件必须是音频素材")

    ffmpeg = str(ffmpeg_path)
    output = Path(output_path)
    if output.suffix.lower() != ".m4a":
        raise ValueError("混音输出必须使用 .m4a 格式")
    resolved_output = output.resolve(strict=False)
    inputs: list[tuple[Path | None, bool]] = [(None, False)]
    voice_index: int | None = None
    if voice is not None:
        voice_index = len(inputs)
        inputs.append((voice, False))

    prepared: list[tuple[_Track, float, float, int, int]] = []
    for track in tracks:
        overlap_start = max(0.0, track.start)
        overlap_end = min(mix_end, track.start + track.duration)
        if overlap_end <= overlap_start:
            continue
        input_index = len(inputs)
        inputs.append((track.path, track.loop))
        prepared.append((track, overlap_start, overlap_end, input_index, len(prepared)))

    for input_path, _loop in inputs:
        if input_path is not None and resolved_output == input_path.resolve(strict=True):
            raise ValueError("混音输出不能覆盖输入素材")

    command = [ffmpeg, "-nostdin", "-y", "-f", "lavfi", "-t", _seconds(mix_end), "-i", f"anullsrc=r={_SAMPLE_RATE}:cl=stereo"]
    for input_path, loop in inputs[1:]:
        if input_path is None:
            continue
        if loop:
            command.extend(["-stream_loop", "-1"])
        command.extend(["-i", str(input_path)])

    filters = [
        f"[0:a:0]atrim=duration={_seconds(mix_end)},asetpts=PTS-STARTPTS[silence]"
    ]
    mix_labels = ["silence"]
    if voice_index is not None:
        filters.append(
            f"[{voice_index}:a:0]atrim=duration={_seconds(mix_end)},"
            f"asetpts=PTS-STARTPTS,aresample={_SAMPLE_RATE},"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,apad,"
            f"atrim=duration={_seconds(mix_end)}[voicebase]"
        )

    music_labels: list[str] = []
    other_labels: list[str] = []
    for track, overlap_start, overlap_end, input_index, track_index in prepared:
        overlap_duration = overlap_end - overlap_start
        source_start = track.source_start + (overlap_start - track.start)
        delay_samples = round(overlap_start * _SAMPLE_RATE)
        chain = (
            f"[{input_index}:a:0]atrim=start={_seconds(source_start)}:duration={_seconds(overlap_duration)},"
            "asetpts=PTS-STARTPTS,"
            f"aresample={_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume={_seconds(track.volume)}"
        )
        if track.legacy_music:
            if overlap_start <= 1e-9:
                chain += ",afade=t=in:st=0:d=0.5"
            fade_out_start = total - 1.0
            if overlap_start <= fade_out_start < overlap_end:
                chain += f",afade=t=out:st={_seconds(fade_out_start - overlap_start)}:d=1"
        chain += f",adelay={delay_samples}S:all=1[t{track_index}]"
        filters.append(chain)
        (music_labels if track.role == "music" else other_labels).append(f"t{track_index}")

    def _mix_bus(labels: list[str], name: str) -> str:
        if len(labels) == 1:
            source = labels[0]
            filters.append(f"[{source}]apad,atrim=duration={_seconds(mix_end)}[{name}]")
        else:
            joined = "".join(f"[{label}]" for label in labels)
            filters.append(
                f"{joined}amix=inputs={len(labels)}:duration=longest:normalize=0,"
                f"apad,atrim=duration={_seconds(mix_end)}[{name}]"
            )
        return name

    if music_labels:
        music_bus = _mix_bus(music_labels, "music")
        if voice_index is not None:
            filters.append("[voicebase]asplit=2[voice][voicekey]")
            filters.append(
                f"[{music_bus}][voicekey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duckedmusic]"
            )
            mix_labels.append("duckedmusic")
        else:
            mix_labels.append(music_bus)
    if voice_index is not None:
        mix_labels.append("voice" if music_labels else "voicebase")
    if other_labels:
        mix_labels.append(_mix_bus(other_labels, "other"))

    mixed = "".join(f"[{label}]" for label in mix_labels)
    filters.append(
        f"{mixed}amix=inputs={len(mix_labels)}:duration=longest:normalize=0,"
        f"alimiter=limit=0.95,aresample={_SAMPLE_RATE},"
        "aformat=sample_fmts=fltp:channel_layouts=stereo,apad,"
        f"atrim=duration={_seconds(mix_end)},atrim=start={_seconds(start)}:duration={_seconds(duration)},"
        "asetpts=PTS-STARTPTS[aout]"
    )
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[aout]",
            "-t",
            _seconds(duration),
            "-ar",
            str(_SAMPLE_RATE),
            "-ac",
            "2",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    return command


__all__ = ["build_audio_mix_command"]
