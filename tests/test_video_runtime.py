from pathlib import Path

from mona.api.video_runtime import VideoRuntime


def test_get_ytdlp_path_uses_cached_resource(tmp_path: Path) -> None:
    executable = tmp_path / "yt-dlp" / "yt-dlp.exe"
    executable.parent.mkdir()
    executable.write_bytes(b"yt-dlp")

    assert VideoRuntime(tmp_path).get_ytdlp_path() == str(executable)
