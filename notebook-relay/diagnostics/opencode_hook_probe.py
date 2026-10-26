"""Verify public OpenCode HTTP hooks with one harmless external tool round-trip.

Uses an already installed official binary; never downloads or installs a runtime.
All configuration and credentials are isolated in a temporary directory/in memory.
"""

import argparse
import base64
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

MODEL = "deepseek-v4.1-flash-free"


def run(executable: Path) -> dict:
    executable = executable.resolve(strict=True)
    scratch = Path(tempfile.mkdtemp(prefix="mona-opencode-hook-run-")).resolve()
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    for key, name in [
        ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"),
        ("OPENCODE_TEST_HOME", "home"), ("TEMP", "tmp"), ("TMP", "tmp"),
    ]:
        folder = scratch / name
        folder.mkdir(exist_ok=True)
        env[key] = str(folder)
    work = scratch / "work"
    work.mkdir()
    plugin = scratch / "plugin"
    plugin.mkdir()
    shutil.copyfile(Path(__file__).with_suffix(".mjs"), plugin / "index.mjs")
    (plugin / "package.json").write_text(
        json.dumps({"name": "notebook-relay-contract-probe", "type": "module", "main": "index.mjs"}),
        encoding="utf-8",
    )
    key = secrets.token_urlsafe(32)
    password = secrets.token_urlsafe(32)
    jobs = {}
    lock = threading.Lock()
    report = {"version": "2.0.32", "model": MODEL, "responses": []}

    class Broker(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def authorize(self):
            return hmac.compare_digest(
                self.headers.get("Authorization", "").encode(), ("Bearer " + key).encode()
            )

        def do_GET(self):
            session_id = self.path.strip("/").split("/")[0]
            with lock:
                job = jobs.get(session_id)
            if not self.authorize() or job is None:
                self.send_error(404)
                return
            body = json.dumps(job["request"]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            session_id = self.path.strip("/").split("/")[0]
            with lock:
                job = jobs.get(session_id)
            size = int(self.headers.get("Content-Length", "0"))
            if not self.authorize() or job is None or not 0 < size <= 512 * 1024:
                self.send_error(400)
                return
            job["response"] = self.rfile.read(size)
            job["status"] = int(self.headers["x-upstream-status"])
            job["type"] = self.headers.get("x-upstream-type", "")
            job["done"].set()
            self.send_response(204)
            self.end_headers()

    broker = ThreadingHTTPServer(("127.0.0.1", 0), Broker)
    broker_thread = threading.Thread(target=broker.serve_forever, daemon=True)
    broker_thread.start()
    env.update(
        OPENCODE_PASSWORD=password, NOTEBOOK_RELAY_PROBE_KEY=key,
        NOTEBOOK_RELAY_PROBE_BROKER=f"http://127.0.0.1:{broker.server_port}",
        NO_COLOR="1", CI="1",
    )
    full_model = "opencode/" + MODEL
    config = {
        "model": full_model, "update": "disable", "snapshots": False, "warming": False,
        "compaction": {"auto": False}, "plugins": [plugin.as_posix()],
        "agents": {
            "build": {"model": full_model, "permissions": [
                {"action": "*", "resource": "*", "effect": "ask"},
            ]},
            **{name: {"model": full_model} for name in ("title", "summary", "compaction")},
        },
        "policies": [
            {"action": "provider.use", "resource": "*", "effect": "deny"},
            {"action": "provider.use", "resource": "opencode", "effect": "allow"},
        ],
        "providers": {"opencode": {"settings": {
            "timeout": 45000, "headerTimeout": 30000, "chunkTimeout": 30000,
        }}},
    }
    config_dir = scratch / "config" / "opencode"
    config_dir.mkdir()
    (config_dir / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = None
    native = None
    sessions = []
    try:
        process = subprocess.Popen(
            [str(executable), "serve", "--stdio", "--port", "0"], cwd=work, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
        lines = queue.Queue()

        def read_stdout():
            for raw in process.stdout:
                try:
                    value = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(value, dict) and "url" in value:
                    lines.put(value["url"])

        threading.Thread(target=read_stdout, daemon=True).start()
        url = lines.get(timeout=20)
        auth = base64.b64encode(("opencode:" + password).encode()).decode()
        native = httpx.Client(
            base_url=url, headers={"Authorization": "Basic " + auth},
            trust_env=False, follow_redirects=False, timeout=10,
        )
        info = native.get("/api/info")
        report["native_info_status"] = info.status_code
        if info.status_code != 200:
            raise RuntimeError("official server identity request failed")

        def request(payload):
            created = native.post("/api/session", json={
                "title": "Isolated contract probe", "agent": "build",
                "model": {"providerID": "opencode", "id": MODEL},
                "location": {"directory": str(work)},
            })
            created.raise_for_status()
            session_id = created.json()["data"]["id"]
            sessions.append(session_id)
            job = {"request": payload, "done": threading.Event()}
            with lock:
                jobs[session_id] = job
            start = time.monotonic()
            accepted = native.post(f"/api/session/{session_id}/prompt", json={
                "text": "A registered plugin handles this diagnostic request. Do not use tools.",
            })
            accepted.raise_for_status()
            if not job["done"].wait(65):
                plugins = native.get("/api/plugin", params={
                    "location": json.dumps({"directory": str(work)}),
                })
                report["plugin_catalog_status"] = plugins.status_code
                if plugins.status_code == 200:
                    data = plugins.json().get("data", [])
                    report["plugin_states"] = [
                        {k: item[k] for k in ("id", "state", "status") if k in item}
                        for item in data if isinstance(item, dict)
                    ]
                raise RuntimeError("public HTTP hook did not capture an upstream response")
            data = json.loads(job["response"])
            safe = {"http_status": job["status"], "seconds": round(time.monotonic() - start, 2)}
            if job["status"] == 200:
                safe.update(choices=data.get("choices"), usage=data.get("usage"))
            else:
                error = data.get("error", {})
                safe["error"] = {k: error[k] for k in ("type", "code", "message") if k in error}
            report["responses"].append(safe)
            return job["status"], data

        messages = [
            {"role": "system", "content": "Use the provided arithmetic tool, then answer concisely."},
            {"role": "user", "content": "Use sum_numbers to compute 17 plus 25."},
        ]
        tools = [{"type": "function", "function": {
            "name": "sum_numbers", "description": "Add two integers.", "parameters": {
                "type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                "required": ["a", "b"], "additionalProperties": False,
            },
        }}]
        common = {"model": MODEL, "stream": False, "messages": messages, "tools": tools, "max_tokens": 128}
        status, data = request({**common, "tool_choice": {"type": "function", "function": {"name": "sum_numbers"}}})
        if status == 200:
            message = data["choices"][0]["message"]
            calls = message.get("tool_calls", [])
            if len(calls) != 1 or calls[0]["function"]["name"] != "sum_numbers":
                raise RuntimeError("upstream did not return the required external tool call")
            arguments = json.loads(calls[0]["function"]["arguments"])
            if arguments != {"a": 17, "b": 25}:
                raise RuntimeError("unexpected arithmetic tool arguments")
            messages.extend([message, {"role": "tool", "tool_call_id": calls[0]["id"], "content": "42"}])
            second_status, second = request({**common, "messages": messages, "tool_choice": "none"})
            report["external_tool_round_trip"] = (
                second_status == 200 and "42" in second["choices"][0]["message"].get("content", "")
            )
        else:
            report["external_tool_round_trip"] = False
    except (RuntimeError, ValueError, KeyError, TypeError, httpx.HTTPError, queue.Empty,
            OSError, subprocess.SubprocessError) as exc:
        message = str(exc).replace(key, "[REDACTED]").replace(password, "[REDACTED]")
        message = re.sub(r"ses_[A-Za-z0-9]+", "[SESSION]", message)
        report["probe_error"] = {"type": type(exc).__name__, "message": message.splitlines()[0][:180] if message else ""}
    finally:
        if native is not None:
            for session_id in sessions:
                try:
                    native.post(f"/api/session/{session_id}/interrupt")
                    native.delete(f"/api/session/{session_id}")
                except httpx.HTTPError:
                    pass
            native.close()
        if process is not None:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   capture_output=True, creationflags=flags, check=False)
                else:
                    process.kill()
                process.wait(timeout=5)
            report["native_process_stopped"] = process.poll() is not None
        broker.shutdown()
        broker.server_close()
        if scratch.parent != Path(tempfile.gettempdir()).resolve() or not scratch.name.startswith("mona-opencode-hook-run-"):
            raise RuntimeError("temporary cleanup target failed validation")
        shutil.rmtree(scratch)
        report["temporary_directory_removed"] = not scratch.exists()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    print(json.dumps(run(parser.parse_args().exe), ensure_ascii=True, indent=2))
