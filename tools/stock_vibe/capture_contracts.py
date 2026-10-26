"""Capture actual native HTTP contracts in a disposable host data root."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx

from mona.runtime.process_tree import OwnedProcess


def capture(source_root: Path, python: Path, output: Path) -> dict:
    source_root = source_root.resolve(strict=True)
    python = python.resolve(strict=True)
    receipt = json.loads((source_root / "agent" / "mona-source.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mona-vibe-contract-") as temporary:
        root = Path(temporary)
        native_root = root / "native"
        native_root.mkdir()
        export_fixture = b"field,value\nread_contract_fixture,1\n"
        artifact = native_root / "runs" / "read-contract" / "artifacts" / "metrics.csv"
        artifact.parent.mkdir(parents=True)
        artifact.write_bytes(export_fixture)
        # Inherit OS essentials only. No ambient provider keys, path overrides or dotenv.
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
            "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATHEXT",
        }}
        token, instance_id = secrets.token_urlsafe(32), secrets.token_hex(16)
        env.update({"VIBE_TRADING_HOME": str(native_root), "VIBE_TRADING_HOSTED": "1",
                    "MONA_VIBE_INSTANCE_ID": instance_id, "API_AUTH_KEY": token,
                    "ENABLE_SESSION_RUNTIME": "true", "VIBE_TRADING_ENABLE_SCHEDULER": "false",
                    "VIBE_TRADING_CHANNELS_AUTO_START": "false", "PYTHONUTF8": "1",
                    "PYTHONDONTWRITEBYTECODE": "1"})
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        log_path = output / "native-startup.txt"
        records: list[dict] = []
        with log_path.open("w", encoding="utf-8") as log:
            owned = OwnedProcess(
                [str(python), str(source_root / "agent" / "api_server.py"), "--host", "127.0.0.1", "--port", str(port)],
                cwd=native_root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            )
            process = owned.process
            try:
                with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as client:
                    deadline = time.monotonic() + 45
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(f"Native startup exited ({process.returncode}); see {log_path}")
                        try:
                            if client.get("/live").status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        if time.monotonic() >= deadline:
                            raise TimeoutError(f"Native startup timed out; see {log_path}")
                        time.sleep(0.1)

                    def request(method: str, path: str, *, authorized: bool = True, body=None):
                        headers = {"Authorization": f"Bearer {token}"} if authorized else {}
                        request_id = secrets.token_hex(16) if method != "GET" else None
                        if request_id:
                            headers["X-Mona-Request-ID"] = request_id
                        response = client.request(method, path, json=body,
                                                  headers=headers)
                        try:
                            payload = response.json()
                        except ValueError:
                            payload = response.text
                        records.append({"method": method, "path": path, "authorized": authorized,
                                        "status": response.status_code, "body": payload,
                                        **({"request_id": request_id} if request_id else {})})
                        return response

                    identity = request("GET", "/mona/identity").json()
                    assert owned.owns_pid(identity["pid"])
                    assert identity["instance_id"] == instance_id
                    assert identity["source"] == receipt
                    assert identity["data_root_sha256"] == hashlib.sha256(str(native_root.resolve()).encode()).hexdigest()
                    assert request("GET", "/mona/identity", authorized=False).status_code == 401
                    for path in ("/live", "/health", "/ready", "/sessions", "/swarm/presets", "/swarm/runs",
                                 "/api/portfolio", "/api/portfolio/settings", "/scheduled-runs"):
                        request("GET", path)
                    response = request("POST", "/sessions", body={"title": "隔离契约样本"})
                    response.raise_for_status()
                    session_id = response.json()["session_id"]
                    request("GET", f"/sessions/{session_id}")
                    request("GET", f"/sessions/{session_id}/messages")
                    assert request("POST", "/sessions", authorized=False, body={"title": "forbidden"}).status_code == 401
                    events_path = f"/sessions/{session_id}/events"
                    assert request("GET", events_path, authorized=False).status_code == 401
                    events = []
                    headers = {"Authorization": f"Bearer {token}"}
                    with client.stream("GET", events_path, headers=headers, timeout=30) as stream:
                        stream.raise_for_status()
                        submitted = request("POST", f"/sessions/{session_id}/messages",
                                            body={"content": "协议验证：无模型配置，应明确失败，不生成金融结论。"})
                        submitted.raise_for_status()
                        frame = []
                        for line in stream.iter_lines():
                            if line:
                                frame.append(line)
                            elif frame:
                                events.append("\n".join(frame))
                                frame = []
                                if "event: attempt.failed" in events[-1]:
                                    break
                    assert events and any("event: attempt.failed" in event for event in events)
                    first_cursor = next(line[4:].strip() for line in events[0].splitlines() if line.startswith("id:"))
                    with client.stream("GET", events_path, headers={**headers, "Last-Event-ID": first_cursor}, timeout=5) as stream:
                        stream.raise_for_status()
                        replayed = next(line[4:].strip() for line in stream.iter_lines() if line.startswith("id:"))
                    assert replayed != first_cursor
                    records.append({"method": "GET", "path": events_path, "authorized": True, "status": 200,
                                    "events": events, "replay_after": first_cursor, "first_replayed_id": replayed})
                    request("GET", f"/sessions/{session_id}/messages")
                    request("GET", "/sessions")
                    if any(patch["path"] == "0010-host-reads.json" for patch in receipt["patches"]):
                        attempt_id = submitted.json()["attempt_id"]
                        state = request("GET", f"/mona/sessions/{session_id}/attempts/{attempt_id}")
                        state.raise_for_status()
                        assert state.json()["status"] == "failed"
                        assert state.json()["session_id"] == session_id
                        assert request("GET", f"/mona/sessions/{session_id}/attempts/{attempt_id}", authorized=False).status_code == 401
                        assert request("GET", "/mona/shadow-profiles").json() == {"profiles": [], "unavailable": []}
                        assert request("GET", "/mona/shadow-profiles/shadow_00000000").status_code == 404
                        downloaded = request("GET", "/mona/artifacts/run-metrics/read-contract")
                        assert downloaded.status_code == 200 and downloaded.content == export_fixture
                        assert "attachment" in downloaded.headers["content-disposition"]
                        assert request("GET", "/mona/artifacts/run-metrics/read-contract", authorized=False).status_code == 401
                        assert request("GET", "/mona/artifacts/arbitrary-file/read-contract").status_code == 404
                        outside = root / "outside"
                        outside.mkdir()
                        (outside / "metrics.csv").write_bytes(b"private-outside-sentinel")
                        link = native_root / "runs" / "escape-contract" / "artifacts"
                        link.parent.mkdir()
                        try:
                            link.symlink_to(outside, target_is_directory=True)
                        except OSError:
                            if os.name == "nt":
                                import _winapi

                                _winapi.CreateJunction(str(outside), str(link))
                            else:
                                records.append({"check": "artifact_symlink_escape", "status": "not_tested", "reason": "symlink creation unavailable"})
                        if link.exists():
                            assert request("GET", "/mona/artifacts/run-metrics/escape-contract").status_code == 404
                result = {"schema_version": 1, "source": receipt, "records": records,
                          "limitations": ["Only a deliberately unconfigured model attempt was dispatched. No completed research, Swarm run, broker login or financial result verified."]}
                (output / "http-contracts.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            finally:
                owned.close()
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = capture(args.source_root, args.python, args.output)
    print(json.dumps({"source": result["source"], "responses": len(result["records"])}))


if __name__ == "__main__":
    main()
