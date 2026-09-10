"""Structured storyboard fields used by series style compilation."""

import importlib.util
from pathlib import Path

_SCRIPTS = (
    Path(__file__).parents[1] / "mona" / "skills" / "mona-video" / "scripts"
)


def _load(name: str):
    path = _SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_storyboard_round_trips_series_style_fields(tmp_path: Path) -> None:
    writer = _load("write_storyboard")
    parser = _load("parse_storyboard")
    scenes = [
        {
            "index": 1,
            "title": "开场",
            "role": "cover",
            "layout": "cover-split",
            "backgroundSlot": "cover",
            "duration": 5,
            "durationRaw": "5s",
            "visual": "标题与主视觉",
            "animation": "淡入",
            "narration": "欢迎观看",
            "assets": [],
        }
    ]

    writer.write_storyboard(tmp_path, scenes)
    parsed = parser.parse_storyboard(tmp_path / "storyboard.md")

    assert parsed[0]["role"] == "cover"
    assert parsed[0]["layout"] == "cover-split"
    assert parsed[0]["backgroundSlot"] == "cover"


def test_legacy_storyboard_gets_compatible_defaults(tmp_path: Path) -> None:
    parser = _load("parse_storyboard")
    storyboard = tmp_path / "storyboard.md"
    storyboard.write_text(
        """# Storyboard

### Scene 1: 开场
- Duration: 5s
- Visual: 标题

### Scene 2: 内容
- Duration: 5s
- Visual: 正文

### Scene 3: 结尾
- Duration: 5s
- Visual: 品牌结束页
""",
        encoding="utf-8",
    )

    parsed = parser.parse_storyboard(storyboard)

    assert [scene["role"] for scene in parsed] == ["cover", "content", "outro"]
    assert [scene["layout"] for scene in parsed] == [
        "cover-split",
        "content-standard",
        "outro-brand",
    ]
    assert [scene["backgroundSlot"] for scene in parsed] == [
        "cover",
        "content",
        "outro",
    ]
