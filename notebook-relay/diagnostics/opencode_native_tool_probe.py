"""Exercise a genuine OpenCode plugin tool with execution in an external client.

No HTTP request rewriting, synthetic response or identity-header emulation.
The caller supplies an installed official binary; all test state is temporary.
"""

import argparse
import hmac
import json
import os
import queue
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


def run(executable: Path, with_history: bool = False) -> dict:
    executable = executable.resolve(strict=True)
    scratch = Path(tempfile.mkdtemp(prefix="mona-native-tool-run-")).resolve()
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"}}
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
    (plugin / "package.json").write_text(json.dumps({
        "name": "notebook-relay-native-tool-probe", "type": "module", "main": "index.mjs",
    }), encoding="utf-8")
    secret = secrets.token_urlsafe(32)
    pending = threading.Event()
    resolved = threading.Event()
    state = {"observations": [], "requests": []}
    report = {"model": MODEL, "request_body_rewritten": False,
              "response_replaced": False, "identity_headers_modified": False}

    class Broker(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path != "/context" or not hmac.compare_digest(
                self.headers.get("Authorization", "").encode(), ("Bearer " + secret).encode()
            ):
                self.send_error(404)
                return
            body = json.dumps({
                "system": "Use the requested arithmetic tool. Reply with the remembered codeword, a colon, and the sum.",
                "messages": [
                    {"role": "user", "content": "Remember the codeword BRIDGE_WORD_47."},
                    {"role": "assistant", "content": "I will remember BRIDGE_WORD_47."},
                    {"role": "user", "content": "Call relay_probe_sum with a=17 and b=25, then give the requested final answer."},
                ],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(),
                                       ("Bearer " + secret).encode()):
                self.send_error(401)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 512 * 1024:
                self.send_error(413)
                return
            raw = self.rfile.read(size)
            if self.path == "/observe":
                state["observations"].append({
                    "status": int(self.headers["x-upstream-status"]), "body": raw,
                })
                self.send_response(204)
                self.end_headers()
                return
            data = json.loads(raw)
            if self.path == "/request-summary":
                state["requests"].append(data)
                self.send_response(204)
                self.end_headers()
            elif self.path == "/tool":
                state["call"] = data
                pending.set()
                if not resolved.wait(30):
                    self.send_error(504)
                    return
                body = json.dumps({"result": state["result"]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif self.path == "/result" and data.get("call_id") == state.get("call", {}).get("call_id"):
                state["result"] = data["result"]
                resolved.set()
                self.send_response(204)
                self.end_headers()
            else:
                self.send_error(400)

    broker = ThreadingHTTPServer(("127.0.0.1", 0), Broker)
    threading.Thread(target=broker.serve_forever, daemon=True).start()
    broker_url = f"http://127.0.0.1:{broker.server_port}"
    env.update(NOTEBOOK_RELAY_PROBE_BROKER=broker_url, NOTEBOOK_RELAY_PROBE_KEY=secret,
               NO_COLOR="1", CI="1")
    if with_history:
        env["NOTEBOOK_RELAY_PROBE_CONTEXT"] = "1"
    full_model = "opencode/" + MODEL
    config = {
        "model": full_model, "plugins": [plugin.as_posix()], "update": "disable",
        "warming": False, "snapshots": False, "compaction": {"auto": False},
        "agents": {"build": {"model": full_model, "permissions": [
            {"action": "*", "resource": "*", "effect": "ask"},
        ]}, **{name: {"model": full_model} for name in ("title", "summary", "compaction")}},
        "policies": [{"action": "provider.use", "resource": "*", "effect": "deny"},
                     {"action": "provider.use", "resource": "opencode", "effect": "allow"}],
        "providers": {"opencode": {"settings": {
            "timeout": 45000, "headerTimeout": 30000, "chunkTimeout": 30000,
        }}},
    }
    config_dir = scratch / "config" / "opencode"
    config_dir.mkdir()
    (config_dir / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = None
    try:
        prompt = ("NATIVE_BRIDGE_INPUT" if with_history else
                  "Call relay_probe_sum exactly once with a=17 and b=25. "
                  "Use no other tools. After receiving its result, reply with exactly the sum.")
        args = [str(executable), "run", "--standalone", "--model", full_model,
                "--format", "json", "--title", "Native external tool probe", "--",
                prompt]
        start = time.monotonic()
        process = subprocess.Popen(args, cwd=work, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   creationflags=flags)
        events = queue.Queue()

        def read_stdout():
            for raw in process.stdout:
                try:
                    events.put(json.loads(raw))
                except ValueError:
                    continue

        reader = threading.Thread(target=read_stdout, daemon=True)
        reader.start()
        supplied = False
        with httpx.Client(trust_env=False, timeout=5) as client:
            while process.poll() is None:
                if time.monotonic() - start > 80:
                    raise TimeoutError("native tool probe exceeded time limit")
                if pending.wait(.05) and not supplied:
                    call = state["call"]
                    if call.get("input") != {"a": 17, "b": 25}:
                        raise ValueError("unexpected arithmetic arguments")
                    # This is client-side execution, outside OpenCode and the HTTP broker handler.
                    answer = call["input"]["a"] + call["input"]["b"]
                    result = client.post(broker_url + "/result", headers={"Authorization": "Bearer " + secret},
                                         json={"call_id": call["call_id"], "result": str(answer)})
                    result.raise_for_status()
                    supplied = True
        reader.join(timeout=2)
        output = []
        errors = []
        event_types = []
        while not events.empty():
            event = events.get_nowait()
            kind = event.get("type")
            event_types.append(kind)
            if kind == "text":
                output.append(event.get("part", {}).get("text", ""))
            if kind == "error":
                error = event.get("error", {})
                errors.append({key: str(error[key]).replace(secret, "[REDACTED]")
                               for key in ("type", "message") if key in error})
        usage = []
        for observed in state["observations"]:
            for line in observed["body"].splitlines():
                if not line.startswith(b"data:") or line[5:].strip() == b"[DONE]":
                    continue
                try:
                    chunk = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if chunk.get("usage"):
                    usage.append(chunk["usage"])
        expected_text = "BRIDGE_WORD_47:42" if with_history else "42"
        report.update(exit_code=process.returncode, seconds=round(time.monotonic() - start, 2),
                      native_event_types=event_types, texts=output, errors=errors,
                      tool_called=pending.is_set(), external_result_supplied=supplied,
                      upstream_statuses=[item["status"] for item in state["observations"]],
                      usage=usage, caller_history_injected=with_history,
                      wire_roles=[[m.get("role") for m in request["messages"]] for request in state["requests"]],
                      native_registered_tool_present=bool(state["requests"]) and all(
                          "relay_probe_sum" in request["tool_names"] for request in state["requests"]
                      ),
                      passed=process.returncode == 0 and supplied and expected_text in "".join(output) and not errors)
    except (RuntimeError, ValueError, KeyError, TypeError, TimeoutError, OSError, httpx.HTTPError) as exc:
        report["probe_error"] = {"type": type(exc).__name__, "message": str(exc).replace(secret, "[REDACTED]")[:180]}
    finally:
        resolved.set()
        if process is not None and process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               capture_output=True, creationflags=flags, check=False)
            else:
                process.kill()
            process.wait(timeout=5)
        broker.shutdown()
        broker.server_close()
        if scratch.parent != Path(tempfile.gettempdir()).resolve() or not scratch.name.startswith("mona-native-tool-run-"):
            raise RuntimeError("temporary cleanup target failed validation")
        shutil.rmtree(scratch)
        report["native_process_stopped"] = process is None or process.poll() is not None
        report["temporary_directory_removed"] = not scratch.exists()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--with-history", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.exe, args.with_history), ensure_ascii=True, indent=2))
