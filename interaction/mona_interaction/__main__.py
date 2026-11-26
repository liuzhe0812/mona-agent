"""Start the standalone interaction development service."""

import argparse
import json
from pathlib import Path

from aiohttp import web

from .app import WEB_ROOT, _loopback, create_app
from .asr_settings import ASRModelConfig
from .character import CharacterBundle
from .connector import ConnectionSettings, MonaConnector
from .scene import SceneBundle
from .voice_wake import SherpaWakeDetector, WakeModelError
from .voice_asr import ASRModelError, SherpaOnlineASR
from .wake_settings import WakeModelConfig
from .tts_transport import build_command


def main() -> None:
    parser = argparse.ArgumentParser(description="Mona 独立交互模块")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="启动独立交互程序")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=17880, type=int)
    serve.add_argument("--character-file", help="本机 Live2D 角色资源清单")
    serve.add_argument("--rest-character-file", help="本机休息姿态角色资源清单")
    serve.add_argument("--work-character-file", help="本机工作姿态角色资源清单")
    serve.add_argument("--dialogue-character-file", help="本机对话姿态角色资源清单")
    serve.add_argument("--scene-file", help="本机办公室场景素材清单")
    serve.add_argument("--wake-model-file", help="本机语音唤醒资源清单")
    serve.add_argument("--asr-model-file", help="本机流式语音识别资源清单")
    serve.add_argument("--tts-config-file", help="本机语音合成资源清单")
    connection = serve.add_mutually_exclusive_group()
    connection.add_argument("--connection-file", help="Mona 交互渠道生成的本机连接文件")
    connection.add_argument("--demo", action="store_true", help="仅用于开发验证的模拟会话")
    args = parser.parse_args()
    if not _loopback(args.host):
        parser.error("首个开发基线仅支持本机监听；远程连接将在配对鉴权接入后开放。")
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间。")
    connector = None
    if args.connection_file:
        try:
            connector = MonaConnector(ConnectionSettings.from_file(args.connection_file))
        except (ValueError, OSError):
            parser.error("连接文件无法使用，请检查文件位置与交互渠道配置。")
    character = None
    if args.character_file:
        try:
            character = CharacterBundle.from_file(args.character_file)
        except (ValueError, OSError) as exc:
            parser.error(f"角色资源无法使用：{exc}")
    office_characters = {}
    for pose in ("rest", "work", "dialogue"):
        path = getattr(args, f"{pose}_character_file")
        if path:
            try:
                office_characters[pose] = CharacterBundle.from_file(path)
            except (ValueError, OSError) as exc:
                parser.error(f"角色资源无法使用：{exc}")
    if (character is not None or office_characters) and not (WEB_ROOT / "vendor" / "cubism-runtime.js").is_file():
        parser.error("角色渲染组件尚未构建，请按交互模块说明完成构建。")
    scene = None
    if args.scene_file:
        try:
            scene = SceneBundle.from_file(args.scene_file)
        except (ValueError, OSError, RuntimeError) as exc:
            parser.error(f"场景资源无法使用：{exc}")
    wake_factory = None
    if args.wake_model_file:
        try:
            wake = WakeModelConfig.from_file(args.wake_model_file)
        except (WakeModelError, ValueError, OSError, RuntimeError) as exc:
            parser.error(f"语音唤醒资源清单无法使用：{exc}")
        wake_factory = lambda: SherpaWakeDetector(wake.root, wake.files)
    asr_factory = None
    if args.asr_model_file:
        try:
            asr = ASRModelConfig.from_file(args.asr_model_file)
        except (ASRModelError, ValueError, OSError, RuntimeError) as exc:
            parser.error(f"语音识别资源清单无法使用：{exc}")
        asr_factory = lambda: SherpaOnlineASR(asr.root, asr.files)
    tts_command = None
    if args.tts_config_file:
        try:
            tts_command = build_command(json.loads(Path(args.tts_config_file).read_text(encoding="utf-8")))
        except (ValueError, TypeError, KeyError, OSError):
            parser.error("本地语音合成资源清单无法使用。")
    try:
        app = create_app(connector, demo=args.demo, character=character, scene=scene,
                         wake_factory=wake_factory, asr_factory=asr_factory,
                         office_characters=office_characters, tts_command=tts_command)
    except ValueError as exc:
        parser.error(str(exc))
    web.run_app(app, host=args.host, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
