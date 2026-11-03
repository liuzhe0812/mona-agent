"""Start the standalone interaction development service."""

import argparse

from aiohttp import web

from .app import _loopback, create_app
from .connector import ConnectionSettings, MonaConnector


def main() -> None:
    parser = argparse.ArgumentParser(description="Mona 独立交互模块")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="启动独立交互程序")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=17880, type=int)
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
    web.run_app(create_app(connector, demo=args.demo), host=args.host, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
