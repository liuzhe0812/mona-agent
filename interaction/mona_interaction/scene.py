"""Serve only the explicitly listed local office artwork."""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from .character import _read_json, _relative, _resolve_file


def _coordinate(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1


@dataclass(frozen=True)
class SceneBundle:
    root: Path
    config: dict
    _assets: dict[str, Path]

    @classmethod
    def from_file(cls, value: str | Path) -> SceneBundle:
        supplied = Path(value).expanduser()
        path = supplied.resolve(strict=True)
        if not path.is_file() or not path.is_relative_to(supplied.parent.resolve()):
            raise ValueError("场景清单超出允许目录或不是文件。")
        config = _read_json(path, "场景清单")
        required = {"version", "asset_root", "background", "width", "height", "clock", "window"}
        optional = {"artwork", "work_artwork", "rest_artwork", "foreground", "rest_foreground", "night_background",
                    "rest_idle", "dialogue_idle", "work_idle", "day_sky", "cloud_artwork", "cloud_regions"}
        if set(config) - (required | optional) or not required <= config.keys():
            raise ValueError("场景清单字段无效。")
        cloud_fields = {"day_sky", "cloud_artwork", "cloud_regions"}
        if cloud_fields & config.keys() and not cloud_fields <= config.keys():
            raise ValueError("云层素材与天空范围必须同时配置。")
        for idle, still in (("rest_idle", "rest_artwork"), ("dialogue_idle", "artwork"),
                            ("work_idle", "work_artwork")):
            if idle in config and still not in config:
                raise ValueError("动态预览需要对应的静态备用图。")
        if type(config["version"]) is not int or config["version"] != 1:
            raise ValueError("场景清单版本无效。")
        for key in ("width", "height"):
            if type(config[key]) is not int or not 1 <= config[key] <= 16384:
                raise ValueError("场景画布尺寸无效。")
        clock = config["clock"]
        if (not isinstance(clock, dict) or set(clock) != {"x", "y", "diameter"}
                or not all(_coordinate(number) for number in clock.values())
                or not 0 < clock["diameter"] <= 0.3):
            raise ValueError("墙钟位置或大小无效。")
        for key, maximum in (("window", 16), ("foreground", 64), ("rest_foreground", 64)):
            if key not in config:
                continue
            polygon = config[key]
            if (not isinstance(polygon, list) or not 3 <= len(polygon) <= maximum
                    or any(not isinstance(point, list) or len(point) != 2
                           or not all(_coordinate(number) for number in point) for point in polygon)):
                raise ValueError(f"场景 {key} 图层范围无效。")
        if "cloud_regions" in config:
            regions = config["cloud_regions"]
            if (not isinstance(regions, list) or not 1 <= len(regions) <= 8
                    or any(not isinstance(polygon, list) or not 3 <= len(polygon) <= 256
                           or any(not isinstance(point, list) or len(point) != 2
                                  or not all(_coordinate(number) for number in point)
                                  for point in polygon) for polygon in regions)):
                raise ValueError("云层天空范围无效。")
        root_value = config["asset_root"]
        if not isinstance(root_value, str) or not root_value:
            raise ValueError("场景素材目录无效。")
        supplied_root = Path(root_value).expanduser()
        root = (supplied_root if supplied_root.is_absolute() else path.parent / supplied_root).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("场景素材目录不是目录。")
        assets = {}
        idle_keys = {"rest_idle", "dialogue_idle", "work_idle"}
        for key in ("background", "artwork", "work_artwork", "rest_artwork", "night_background",
                    "rest_idle", "dialogue_idle", "work_idle", "day_sky", "cloud_artwork"):
            if key not in config:
                continue
            name = _relative(config[key], "场景素材")
            if key in idle_keys:
                if not name.lower().endswith(".png"):
                    raise ValueError("场景素材文件类型无效。")
                try:
                    candidate = root.joinpath(*PurePosixPath(name).parts).resolve()
                except (OSError, RuntimeError, ValueError) as exc:
                    raise ValueError("场景素材路径无效。") from exc
                if not candidate.is_relative_to(root):
                    raise ValueError("场景素材超出素材目录。")
                if not candidate.is_file():
                    continue
            image = _resolve_file(root, name, ".png", "场景素材")
            try:
                with image.open("rb") as stream:
                    header = stream.read(24)
            except OSError:
                if key in idle_keys:
                    continue
                raise
            if (len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n"
                    or header[12:16] != b"IHDR"
                    or struct.unpack(">II", header[16:24]) != (config["width"], config["height"])):
                if key in idle_keys:
                    continue
                raise ValueError("场景图片格式或画布尺寸与清单不一致。")
            assets[name] = image
        return cls(root, config, assets)

    def public_config(self) -> dict:
        result = {key: self.config[key] for key in ("width", "height", "clock", "window")}
        result.update(available=True, background_url="/scene/assets/" + quote(self.config["background"], safe="/"))
        if "artwork" in self.config:
            result["artwork_url"] = "/scene/assets/" + quote(self.config["artwork"], safe="/")
        if "work_artwork" in self.config:
            result["work_artwork_url"] = "/scene/assets/" + quote(self.config["work_artwork"], safe="/")
        if "rest_artwork" in self.config:
            result["rest_artwork_url"] = "/scene/assets/" + quote(self.config["rest_artwork"], safe="/")
        if "night_background" in self.config:
            result["night_background_url"] = "/scene/assets/" + quote(self.config["night_background"], safe="/")
        if "day_sky" in self.config:
            for key in ("day_sky", "cloud_artwork"):
                result[f"{key}_url"] = "/scene/assets/" + quote(self.config[key], safe="/")
            result["cloud_regions"] = self.config["cloud_regions"]
        unavailable_idle = []
        for key in ("rest_idle", "dialogue_idle", "work_idle"):
            if key in self.config:
                name = _relative(self.config[key], "场景素材")
                if name in self._assets:
                    result[f"{key}_url"] = "/scene/assets/" + quote(name, safe="/")
                else:
                    unavailable_idle.append(key.removesuffix("_idle"))
        if unavailable_idle:
            result["idle_unavailable"] = unavailable_idle
        if "foreground" in self.config:
            result["foreground"] = self.config["foreground"]
        if "rest_foreground" in self.config:
            result["rest_foreground"] = self.config["rest_foreground"]
        return result

    def asset(self, name: str) -> Path | None:
        if name not in self._assets:
            return None
        try:
            path = self.root.joinpath(*PurePosixPath(name).parts).resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            return None
        if path != self._assets[name] or not path.is_relative_to(self.root) or not path.is_file():
            return None
        return path
