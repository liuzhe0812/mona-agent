"""Validate and start an explicitly prepared Ubuntu interaction environment."""

from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import sys
import tempfile
import unicodedata
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
MARKER = "# Installed and populated by scripts/install-ubuntu-service.sh.\n"
RESOURCE_OPTIONS = (
    "connection_file", "scene_file", "rest_character_file", "work_character_file",
    "dialogue_character_file", "wake_model_file", "asr_model_file", "tts_config_file",
)


def safe_text(value: str) -> str:
    if not value or any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError("路径或参数包含无效字符。")
    return value


def managed_environment(root: Path, executable: Path, prefix: Path | None = None) -> Path:
    """Validate both the venv launcher and its resolved interpreter target."""
    root = root.resolve(strict=True)
    if not root.is_dir() or root == Path(root.anchor):
        raise ValueError("运行时目录无效。")
    executable = Path(os.path.abspath(executable))
    parent = executable.parent.resolve(strict=True)
    target = executable.resolve(strict=True)
    if executable.name != "python" or not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError("受管 Python 不可执行。")
    if not executable.is_relative_to(root) or not parent.is_relative_to(root) or not target.is_relative_to(root):
        raise ValueError("受管 Python 超出运行时范围。")
    parts = parent.relative_to(root).parts
    if (len(parts) != 4 or parts[0] != "python" or not re.fullmatch(r"[a-z0-9][a-z0-9._-]*-envs", parts[1])
            or not re.fullmatch(r"[0-9a-f]{32}", parts[2]) or parts[3] != "bin"):
        raise ValueError("Python 不属于已准备的受管环境。")
    environment = parent.parent
    metadata_path = (environment / "environment.json").resolve(strict=True)
    if not metadata_path.is_relative_to(environment) or metadata_path.stat().st_size > 65536:
        raise ValueError("受管环境记录无效。")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    base_pack = metadata.get("basePack", metadata.get("base_pack")) if isinstance(metadata, dict) else None
    if (not isinstance(metadata, dict) or metadata.get("schemaVersion", metadata.get("schema_version")) != 1
            or metadata.get("generation") != parts[2]
            or metadata.get("pythonRelative", metadata.get("python_relative")) != "bin/python"
            or not isinstance(metadata.get("packs"), list) or not metadata["packs"]
            or not all(isinstance(item, str) and item for item in metadata["packs"])
            or not isinstance(base_pack, str) or base_pack not in metadata["packs"]):
        raise ValueError("受管环境记录无效。")
    if prefix is not None and prefix.resolve(strict=True) != environment:
        raise ValueError("当前解释器不是指定的受管环境。")
    return environment


def bounded_file(value: str, roots: tuple[Path, ...]) -> Path:
    supplied = Path(safe_text(value)).expanduser()
    resolved = supplied.resolve(strict=True)
    if not resolved.is_file() or not any(resolved.is_relative_to(root) for root in roots):
        raise ValueError("资源文件不存在或超出允许范围。")
    return resolved


def bounded_root(path: Path, roots: tuple[Path, ...]) -> None:
    resolved = path.resolve(strict=True)
    if not resolved.is_dir() or not any(resolved.is_relative_to(root) for root in roots):
        raise ValueError("资源目录超出允许范围。")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ubuntu 受管交互程序启动")
    parser.add_argument("action", choices=("run", "install"))
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--managed-python", required=True)
    for name in RESOURCE_OPTIONS:
        parser.add_argument("--" + name.replace("_", "-"))
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--port", type=int, default=17880)
    args = parser.parse_args(argv)
    if args.action == "install" and args.demo:
        parser.error("用户服务不能使用模拟会话。")
    if args.demo and args.connection_file:
        parser.error("模拟会话不能同时指定真实连接。")
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间。")
    if not args.demo and any(not getattr(args, name) for name in RESOURCE_OPTIONS if name != "tts_config_file"):
        parser.error("正式运行需要连接、场景、三种角色、唤醒和识别清单。")
    return args


def resolve_resources(args: argparse.Namespace, roots: tuple[Path, ...]) -> dict[str, Path]:
    return {name: bounded_file(getattr(args, name), roots) for name in RESOURCE_OPTIONS if getattr(args, name)}


def validate_resources(resources: dict[str, Path], roots: tuple[Path, ...]) -> None:
    """Reuse the application's validators; do not output connection credentials."""
    sys.path.insert(0, str(PROJECT))
    from mona_interaction.app import VENDOR_SHADER_FILES, WEB_ROOT, create_app
    from mona_interaction.asr_settings import ASRModelConfig
    from mona_interaction.character import CharacterBundle
    from mona_interaction.connector import ConnectionSettings, MonaConnector
    from mona_interaction.scene import SceneBundle
    from mona_interaction.wake_settings import WakeModelConfig
    from mona_interaction.tts_transport import build_command

    connector = MonaConnector(ConnectionSettings.from_file(resources["connection_file"])) if "connection_file" in resources else None
    scene = SceneBundle.from_file(resources["scene_file"]) if "scene_file" in resources else None
    if scene:
        bounded_root(scene.root, roots)
    poses = {}
    for pose in ("rest", "work", "dialogue"):
        key = f"{pose}_character_file"
        if key in resources:
            poses[pose] = CharacterBundle.from_file(resources[key])
            bounded_root(poses[pose].root, roots)
    if poses and (not scene or not {"rest_artwork", "work_artwork", "artwork"} <= scene.config.keys()):
        raise ValueError("场景缺少三种姿态的备用图。")
    if poses:
        if not (WEB_ROOT / "vendor/cubism-runtime.js").is_file() or any(
            not (WEB_ROOT / "vendor/shaders" / name).is_file() for name in VENDOR_SHADER_FILES
        ):
            raise ValueError("角色渲染资源尚未准备好。")
    for key, cls in (("wake_model_file", WakeModelConfig), ("asr_model_file", ASRModelConfig)):
        if key in resources:
            config = cls.from_file(resources[key])
            bounded_root(config.root, roots)
    if "wake_model_file" in resources or "asr_model_file" in resources:
        import numpy  # noqa: F401
        import sherpa_onnx  # noqa: F401
    if "tts_config_file" in resources:
        settings = json.loads(resources["tts_config_file"].read_text(encoding="utf-8"))
        bounded_root(Path(settings["runtime_root"]), roots)
        bounded_root(Path(settings["reference_root"]), roots)
        build_command(settings)
    create_app(connector=connector, scene=scene, office_characters=poses)


def systemd_quote(value: str) -> str:
    safe_text(value)
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


def service_text(project: Path, runtime_root: Path, executable: Path, args: list[str]) -> str:
    template = (project / "deploy/mona-interaction.service").read_text(encoding="utf-8")
    original = "ExecStart=@PYTHON_EXECUTABLE@ -m mona_interaction serve --host 127.0.0.1 --port 17880"
    if not template.startswith(MARKER) or template.count(original) != 1:
        raise ValueError("用户服务模板无效。")
    command = ["/bin/bash", str(project / "scripts/ubuntu-managed-launcher.sh"), "run",
               str(runtime_root), str(executable), *args]
    return template.replace(original, "ExecStart=:" + " ".join(systemd_quote(part) for part in command))


def install_service(project: Path, text: str) -> Path:
    home = Path.home().resolve(strict=True)
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config"))).expanduser()
    if not config.is_absolute():
        raise ValueError("用户配置目录必须是绝对路径。")
    config = config.resolve()
    if not config.is_relative_to(home):
        raise ValueError("用户配置目录超出允许范围。")
    directory = (config / "systemd/user").resolve()
    if not directory.is_relative_to(home):
        raise ValueError("用户服务目录超出允许范围。")
    directory.mkdir(parents=True, exist_ok=True)
    if not directory.resolve(strict=True).is_relative_to(home):
        raise ValueError("用户服务目录超出允许范围。")
    destination = directory / "mona-interaction.service"
    if destination.is_symlink() or (destination.exists() and not destination.read_text(encoding="utf-8").startswith(MARKER)):
        raise ValueError("已有用户服务不是由此安装器创建，已保留。")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=directory, prefix=".mona-interaction-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return destination


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        runtime_root = Path(safe_text(args.runtime_root)).expanduser().resolve(strict=True)
        executable = Path(os.path.abspath(safe_text(args.managed_python)))
        managed_environment(runtime_root, executable, Path(sys.prefix))
        if sys.version_info < (3, 11):
            raise ValueError("受管 Python 需要 3.11 或更新版本。")
        roots = tuple(dict.fromkeys((Path.home().resolve(strict=True), PROJECT, runtime_root)))
        resources = resolve_resources(args, roots)
        validate_resources(resources, roots)
        service_args = ["--port", str(args.port)]
        for name in RESOURCE_OPTIONS:
            if name in resources:
                service_args.extend(("--" + name.replace("_", "-"), str(resources[name])))
        if args.demo:
            service_args.append("--demo")
        if args.action == "install":
            install_service(PROJECT, service_text(PROJECT, runtime_root, executable, service_args))
            return
        os.chdir(PROJECT)
        sys.argv = ["mona_interaction", "serve", "--host", "127.0.0.1", *service_args]
        runpy.run_module("mona_interaction", run_name="__main__")
    except (OSError, RuntimeError, ValueError, ImportError, json.JSONDecodeError) as exc:
        # Resource validators never include connection contents in their errors.
        print(f"受管交互程序无法启动：{exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
