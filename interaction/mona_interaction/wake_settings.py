"""Explicit local wake model manifest; this module does not acquire assets."""
from dataclasses import dataclass
from pathlib import Path

from .character import _read_json
from .voice_wake import WakeModelError, WakeModelFiles, _model_paths


@dataclass(frozen=True)
class WakeModelConfig:
    root: Path
    files: WakeModelFiles

    @classmethod
    def from_file(cls, value: str | Path) -> "WakeModelConfig":
        supplied = Path(value).expanduser()
        path = supplied.resolve(strict=True)
        if not path.is_file() or not path.is_relative_to(supplied.parent.resolve()):
            raise WakeModelError("语音资源清单位置无效。")
        data = _read_json(path, "语音资源清单")
        keys = {"version", "asset_root", "tokens", "encoder", "decoder", "joiner", "keywords_file"}
        if set(data) != keys or type(data["version"]) is not int or data["version"] != 1:
            raise WakeModelError("语音资源清单格式无效。")
        root = data["asset_root"]
        if not isinstance(root, str) or not root:
            raise WakeModelError("语音资源目录无效。")
        root_path = Path(root).expanduser()
        if not root_path.is_absolute():
            root_path = path.parent / root_path
        files = WakeModelFiles(*(data[key] for key in ("tokens", "encoder", "decoder", "joiner", "keywords_file")))
        _model_paths(root_path, files)
        return cls(root_path.resolve(strict=True), files)
