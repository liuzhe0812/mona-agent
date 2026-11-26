"""Validate the local character bundle before serving its referenced files."""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import quote, urlsplit

MAX_JSON_BYTES = 1_048_576
PARAMETER = re.compile(r"[A-Za-z0-9_]{1,128}\Z")
SOURCES = {
    "headYaw", "headPitch", "headRoll", "bodyYaw", "browRaise", "eyeX", "eyeY", "eyeOpen",
    "smile", "armWave", "breath", "mouthOpen", "mouthForm",
}


def _read_json(path: Path, label: str) -> dict:
    try:
        with path.open("rb") as stream:
            content = stream.read(MAX_JSON_BYTES + 1)
    except OSError as exc:
        raise ValueError(f"{label}无法读取。") from exc
    if len(content) > MAX_JSON_BYTES:
        raise ValueError(f"{label}过大。")
    try:
        data = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label}不是有效的 JSON。") from exc
    if isinstance(data, dict):
        return data
    raise ValueError(f"{label}必须是 JSON 对象。")


def _relative(value: object, label: str) -> str:
    if (not isinstance(value, str) or not value or "\\" in value or "//" in value
            or any(unicodedata.category(char) == "Cc" for char in value)
            or any(char in value for char in "?#%")):
        raise ValueError(f"{label}必须是有效的相对路径。")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError(f"{label}必须是有效的相对路径。") from exc
    parts = value.split("/")
    if (parsed.scheme or parsed.netloc or ":" in value or value.startswith("/")
            or PureWindowsPath(value).drive or ".." in parts):
        raise ValueError(f"{label}必须是有效的相对路径。")
    return PurePosixPath(value).as_posix()


def _resolve_file(root: Path, name: str, suffix: str, label: str) -> Path:
    if not name.lower().endswith(suffix):
        raise ValueError(f"{label}文件类型无效。")
    try:
        path = root.joinpath(*PurePosixPath(name).parts).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError(f"{label}文件不存在或路径无效。") from exc
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError(f"{label}超出素材目录或不是文件。")
    return path


def _bindings(value: object) -> tuple[dict, ...]:
    if not isinstance(value, list) or len(value) > 32:
        raise ValueError("角色参数绑定必须是最多 32 项的列表。")
    result = []
    parameters = set()
    for binding in value:
        if not isinstance(binding, dict) or set(binding) != {"source", "parameter", "scale", "offset"}:
            raise ValueError("角色参数绑定字段无效。")
        source, parameter = binding["source"], binding["parameter"]
        if not isinstance(source, str) or source not in SOURCES:
            raise ValueError("角色参数绑定的来源无效。")
        if not isinstance(parameter, str) or not PARAMETER.fullmatch(parameter) or parameter in parameters:
            raise ValueError("角色参数名称无效或重复。")
        for key in ("scale", "offset"):
            number = binding[key]
            if (isinstance(number, bool) or not isinstance(number, (int, float))
                    or not -360 <= number <= 360 or not math.isfinite(number)):
                raise ValueError(f"角色参数绑定的 {key} 无效。")
        parameters.add(parameter)
        result.append(dict(binding))
    return tuple(result)


@dataclass(frozen=True)
class CharacterBundle:
    root: Path
    model_name: str
    core_name: str
    bindings: tuple[dict, ...]
    _assets: dict[str, Path]

    @classmethod
    def from_file(cls, value: str | Path) -> CharacterBundle:
        supplied = Path(value).expanduser()
        try:
            path = supplied.resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("角色清单不存在或路径无效。") from exc
        if not path.is_relative_to(supplied.parent.resolve()) or not path.is_file():
            raise ValueError("角色清单超出允许目录或不是文件。")
        config = _read_json(path, "角色清单")
        if set(config) - {"version", "asset_root", "model", "core", "bindings"}:
            raise ValueError("角色清单包含未知字段。")
        if type(config.get("version")) is not int or config["version"] != 1:
            raise ValueError("角色清单版本无效。")
        root_value = config.get("asset_root")
        if not isinstance(root_value, str) or not root_value:
            raise ValueError("角色素材目录无效。")
        try:
            root_path = Path(root_value).expanduser()
            root = (root_path if root_path.is_absolute() else path.parent / root_path).resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("角色素材目录不存在或路径无效。") from exc
        if not root.is_dir():
            raise ValueError("角色素材目录不是目录。")

        model_name = _relative(config.get("model"), "角色模型")
        core_name = _relative(config.get("core"), "角色运行组件")
        model_path = _resolve_file(root, model_name, ".model3.json", "角色模型")
        core_path = _resolve_file(root, core_name, ".js", "角色运行组件")
        model = _read_json(model_path, "角色模型")
        if type(model.get("Version")) is not int or model["Version"] != 3:
            raise ValueError("角色模型版本无效。")
        references = model.get("FileReferences")
        if not isinstance(references, dict) or not references:
            raise ValueError("角色模型缺少资源引用。")
        textures = references.get("Textures")
        if not isinstance(textures, list) or not 1 <= len(textures) <= 16:
            raise ValueError("角色模型需要 1 至 16 张纹理。")

        assets = {model_name: model_path, core_name: core_path}
        parent = PurePosixPath(model_name).parent
        required = [(references.get("Moc"), ".moc3", "角色模型数据")]
        required.extend((texture, ".png", "角色纹理") for texture in textures)
        required.extend((references[key], ".json", f"角色{key}") for key in ("Physics", "Pose")
                        if key in references)
        for reference, suffix, label in required:
            relative = _relative(reference, label)
            name = (parent / relative).as_posix()
            assets[name] = _resolve_file(root, name, suffix, label)
        return cls(root, model_name, core_name, _bindings(config.get("bindings", [])), assets)

    def public_config(self) -> dict:
        return {
            "available": True,
            "model_url": "/character/assets/" + quote(self.model_name, safe="/"),
            "core_url": "/character/assets/" + quote(self.core_name, safe="/"),
            "bindings": [dict(binding) for binding in self.bindings],
        }

    def asset(self, name: str) -> Path | None:
        if not isinstance(name, str) or name not in self._assets:
            return None
        try:
            path = self.root.joinpath(*PurePosixPath(name).parts).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return None
        if path != self._assets[name] or not path.is_relative_to(self.root) or not path.is_file():
            return None
        return path
