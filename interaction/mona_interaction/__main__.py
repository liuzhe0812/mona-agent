"""Start the standalone interaction development service."""

import argparse

from aiohttp import web

from .app import _loopback, create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Mona 独立交互模块")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="启动本机交互演示")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=17880, type=int)
    args = parser.parse_args()
    if not _loopback(args.host):
        parser.error("首个开发基线仅支持本机监听；远程连接将在配对鉴权接入后开放。")
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间。")
    web.run_app(create_app(), host=args.host, port=args.port, access_log=None)


if __name__ == "__main__":
    main()
