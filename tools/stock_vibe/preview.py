"""Run the real stock UI against an isolated Services/native runtime for development."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import shutil
import socket
import subprocess
from pathlib import Path

from aiohttp import web

from mona.api.stock_model_bridge import register_routes as register_model_bridge
from mona.config.loader import load_config
from mona.materials.auth import materials_auth_middleware
from mona.runtime.process_tree import OwnedProcess
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime

REPO = Path(__file__).resolve().parents[2]


async def _serve(app: web.Application) -> tuple[web.AppRunner, int]:
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, site._server.sockets[0].getsockname()[1]


async def preview(runtime_root: Path, output: Path, data_root: Path | None = None) -> None:
    runtime_root, output = runtime_root.resolve(strict=True), output.resolve()
    scratch = (REPO / ".codex_tmp").resolve()
    if not runtime_root.is_relative_to(scratch) or not output.is_relative_to(scratch):
        raise ValueError("Preview must use worktree scratch roots, never a user's active runtime/data store")
    private_data = data_root.resolve(strict=True) if data_root is not None else output / "private" / "native"
    if not private_data.is_relative_to(scratch):
        raise ValueError("Preview data must remain inside this worktree's scratch root")
    if output.exists():
        raise FileExistsError("Use a fresh preview output directory")
    report = json.loads((runtime_root / "verification.json").read_text(encoding="utf-8"))
    if report.get("status") != "verified":
        raise ValueError("Preview requires a verified isolated offline installation")
    output.mkdir(parents=True)
    config = load_config().model_copy(deep=True)
    config.stock_vibe.model_preset = None
    config.stock_vibe.tushare_token = ""
    os.environ.pop("MONA_STOCK_VIBE__TUSHARE_TOKEN", None)
    token = secrets.token_urlsafe(32)
    os.environ["MONA_SERVICES_TOKEN"] = token
    gateway = web.Application()
    register_model_bridge(gateway, lambda: config)
    gateway_runner, gateway_port = await _serve(gateway)
    config.gateway.port = gateway_port
    config.stock_vibe.watched_symbols = []
    runtime = StockVibeRuntime(runtime_root=runtime_root, data_root=private_data, config_loader=lambda: config,
                               automation_allowed=lambda: True)
    def write_attention(values):
        for key, value in values.items():
            setattr(config.stock_vibe, key, value)

    services = web.Application(client_max_size=16 * 1024 * 1024, middlewares=[materials_auth_middleware])
    register_stock_vibe_routes(services, runtime=runtime,
                               model_writer=lambda value: setattr(config.stock_vibe, "model_preset", value),
                               attention_writer=write_attention)
    services_runner, services_port = await _serve(services)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        ui_port = listener.getsockname()[1]
    webui = REPO / "webui"
    vite_config = output / "vite.config.mjs"
    vite_module = (webui / "node_modules/vite/dist/node/index.js").as_uri()
    react_module = (webui / "node_modules/@vitejs/plugin-react/dist/index.js").as_uri()
    vite_config.write_text(
        f"import {{defineConfig}} from {json.dumps(vite_module)};\n"
        f"import react from {json.dumps(react_module)};\n"
        "export default defineConfig({"
        f"root:{json.dumps(webui.as_posix())},cacheDir:{json.dumps((output / 'vite-cache').as_posix())},"
        "plugins:[react()],resolve:{alias:{"
        f"'@':{json.dumps((webui / 'src').as_posix())}"
        "}},optimizeDeps:{entries:['stock-vibe-dev.html']},server:{host:'127.0.0.1',strictPort:true,"
        f"port:{ui_port},cors:{{origin:{json.dumps(f'http://127.0.0.1:{ui_port}')}}},"
        "proxy:{'/api/stock-vibe':{target:process.env.MONA_STOCK_VIBE_DEV_SERVICES,changeOrigin:true,"
        "headers:{'X-Mona-Token':process.env.MONA_STOCK_VIBE_DEV_TOKEN}}}}});\n", encoding="utf-8")
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
        "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATHEXT",
    }}
    env.update(MONA_STOCK_VIBE_DEV_SERVICES=f"http://127.0.0.1:{services_port}", MONA_STOCK_VIBE_DEV_TOKEN=token)
    log = (output / "ui.log").open("w", encoding="utf-8")
    owned = None
    try:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node is required for the development preview")
        owned = OwnedProcess([node, str(webui / "node_modules/vite/bin/vite.js"), "--config", str(vite_config)],
                             cwd=webui, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        metadata = {"ui_url": f"http://127.0.0.1:{ui_port}/stock-vibe-dev.html",
                    "services_port": services_port, "gateway_port": gateway_port, "data_root": str(runtime.data_root),
                    "runtime_root": str(runtime_root), "model_selection": "explicit UI choice required"}
        (output / "preview.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(metadata), flush=True)
        while owned.poll() is None:
            await asyncio.sleep(1)
        raise RuntimeError("UI preview exited; see ui.log")
    finally:
        if owned is not None:
            await asyncio.to_thread(owned.close)
        log.close()
        await services_runner.cleanup()
        await gateway_runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, help="Reuse an explicit private scratch root for upgrade/restart checks")
    args = parser.parse_args()
    try:
        asyncio.run(preview(args.runtime_root, args.output, args.data_root))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
