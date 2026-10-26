from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

import pytest

from mona.config.schema import Config, ModelPresetConfig, _resolve_tool_config_refs
from mona.runtime.process_tree import OwnedProcessInfo
from mona.services.stock_vibe.runtime import StockVibeRuntime, StockVibeUnavailableError

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RUNTIME_ROOT = REPO_ROOT / ".codex_tmp" / "stock-vibe-runtime-verify-current"


def _lifecycle_config():
    _resolve_tool_config_refs()
    config = Config()
    config.model_presets = {"synthetic-trigger": ModelPresetConfig(model="synthetic-no-call")}
    config.gateway.port = 1
    return config


def test_model_signature_ignores_catalog_updates_but_tracks_effective_request_configuration():
    config = _lifecycle_config()
    config.stock_vibe.model_preset = "synthetic-trigger"
    config.model_presets["synthetic-trigger"].provider = "openai"
    config.providers.openai.api_key = uuid.uuid4().hex
    before = StockVibeRuntime._model_signature(config)
    config.providers.openai.display_name = "Another display label"
    config.providers.openai.model = "another-model"
    config.providers.openai.enabled_models = ["synthetic-no-call", "another-model"]
    config.providers.openai.model_engines = {"another-model": "mona"}
    config.providers.openai.discovered_models = [{"id": "another-model", "context_window": 8192}]
    assert StockVibeRuntime._model_signature(config) == before
    config.providers.openai.api_key = uuid.uuid4().hex
    assert StockVibeRuntime._model_signature(config) != before
    changed = StockVibeRuntime._model_signature(config)
    config.model_presets["synthetic-trigger"].max_tokens += 1
    assert StockVibeRuntime._model_signature(config) != changed


def test_removed_selected_model_reference_invalidates_the_live_binding():
    config = _lifecycle_config()
    config.stock_vibe.model_preset = "synthetic-trigger"
    bound = StockVibeRuntime._model_signature(config)
    del config.model_presets["synthetic-trigger"]
    assert StockVibeRuntime._model_signature(config) == "unconfigured"
    assert bound != "unconfigured"


def test_tushare_secret_uses_only_scoped_config_and_hashes_restart_signature(monkeypatch):
    config = _lifecycle_config()
    monkeypatch.delenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", raising=False)
    monkeypatch.setenv("TUSHARE_TOKEN", "standalone-vibe-sentinel")

    assert StockVibeRuntime._tushare_token(config) == ""
    assert StockVibeRuntime._tushare_environment(config) == {}
    assert StockVibeRuntime._runtime_signature(config) == StockVibeRuntime._model_signature(config)

    configured = "synthetic-mona-tushare-token"
    config.stock_vibe.tushare_token = configured
    first_signature = StockVibeRuntime._runtime_signature(config)
    assert StockVibeRuntime._tushare_token(config) == configured
    assert StockVibeRuntime._tushare_environment(config) == {"TUSHARE_TOKEN": configured}
    assert configured not in first_signature
    assert configured not in repr(config.stock_vibe)

    config.stock_vibe.tushare_token = "synthetic-rotated-token"
    assert StockVibeRuntime._runtime_signature(config) != first_signature

    monkeypatch.setenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", "scoped-env-sentinel")
    assert StockVibeRuntime._tushare_token(config) == "scoped-env-sentinel"
    assert StockVibeRuntime._tushare_environment(config) == {"TUSHARE_TOKEN": "scoped-env-sentinel"}


def _verified_runtime_root() -> Path:
    return Path(os.environ.get("STOCK_VIBE_RUNTIME_ROOT", DEFAULT_RUNTIME_ROOT)).resolve()


@pytest.fixture
def installed_runtime_root() -> Path:
    root = _verified_runtime_root()
    report_path = root / "verification.json"
    if not report_path.is_file():
        pytest.skip(
            "run tools/stock_vibe/verify_install.py against the current package first"
        )
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report.get("status") == "verified", report.get("error")
    return root


@pytest.mark.asyncio
async def test_services_runtime_lifecycle_reuses_reclaims_and_preserves_sessions(
    tmp_path: Path, installed_runtime_root: Path
) -> None:
    if os.name != "nt":
        pytest.skip("Job Object process-count acceptance is currently verified on Windows only")

    data_root = tmp_path / "native"
    data_root.mkdir()
    config = _lifecycle_config()
    runtime = StockVibeRuntime(
        runtime_root=installed_runtime_root,
        data_root=data_root,
        config_loader=lambda: config,
    )
    engine_log = data_root.parent / "host" / "engine.log"
    prior_shutdown_count = 0

    async def concurrent_lease(
        arrivals: list[int], arrivals_lock: asyncio.Lock, both_entered: asyncio.Event
    ) -> tuple[object, dict[str, object], int]:
        async with runtime.lease() as client:
            identity_response = await client.get("/mona/identity")
            identity_response.raise_for_status()
            ready_response = await client.get("/ready")
            async with arrivals_lock:
                arrivals.append(1)
                if len(arrivals) == 2:
                    both_entered.set()
            await asyncio.wait_for(both_entered.wait(), timeout=5)
            return client, identity_response.json(), ready_response.status_code

    try:
        arrivals: list[int] = []
        arrivals_lock = asyncio.Lock()
        both_entered = asyncio.Event()
        first, second = await asyncio.wait_for(
            asyncio.gather(
                concurrent_lease(arrivals, arrivals_lock, both_entered),
                concurrent_lease(arrivals, arrivals_lock, both_entered),
            ),
            timeout=20,
        )
        assert first[0] is second[0]
        assert first[1]["instance_id"] == second[1]["instance_id"]
        assert first[2] == second[2] == 503
        assert first[1]["service"] == "mona-stock-vibe"

        async with runtime.lease() as client:
            original_identity = (await client.get("/mona/identity")).json()
            create_response = await client.post(
                "/sessions",
                headers={"X-Mona-Request-ID": uuid.uuid4().hex},
                json={"title": "Synthetic lifecycle persistence"},
            )
            assert create_response.status_code == 201, create_response.text
            old_session_id = create_response.json()["session_id"]

            config.stock_vibe.model_preset = "synthetic-trigger"
            with pytest.raises(StockVibeUnavailableError, match="当前股票任务结束"):
                async with runtime.lease():
                    raise AssertionError("changed model preset unexpectedly received a lease")
            config.stock_vibe.model_preset = None
            current_identity = (await client.get("/mona/identity")).json()
            assert current_identity["instance_id"] == original_identity["instance_id"]
            assert runtime._process is not None and runtime._process.poll() is None

            contender = StockVibeRuntime(
                runtime_root=installed_runtime_root,
                data_root=data_root,
                config_loader=lambda: config,
            )
            try:
                with pytest.raises(StockVibeUnavailableError, match="另一个服务使用"):
                    async with contender.lease():
                        raise AssertionError("second supervisor unexpectedly acquired the data root")
                assert contender._process is None
                assert contender._ownership is None
            finally:
                await contender.close()

            retained_client = client

        idle = (await retained_client.get("/mona/activity")).json()
        assert idle["active"] is False
        assert idle["session_inflight"] == 0
        assert idle["swarm_active"] == 0
        assert idle["alpha_bench_active"] == 0
        assert idle["alpha_compare_active"] == 0
        assert idle["scheduler_enabled"] is False
        first_process = runtime._process
        assert first_process is not None
        assert runtime._baseline_process_ids is not None
        process_count = first_process.process_count()
        current_process_ids = first_process.process_ids()
        assert current_process_ids == runtime._baseline_process_ids
        assert process_count == len(runtime._baseline_process_ids), (
            f"owned_pid={first_process.pid}, native_pid={original_identity['pid']}, "
            f"baseline_pids={sorted(runtime._baseline_process_ids)}, active_processes={process_count}"
        )

        runtime._last_used = time.monotonic() - config.stock_vibe.idle_timeout_sec - 1
        deadline = time.monotonic() + 6
        while runtime._process is not None and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        assert runtime._process is None, "real idle loop did not reclaim the expired process"
        assert first_process.poll() is not None
        assert first_process.process_count() == 0
        assert first_process.process_ids() == set()
        assert engine_log.is_file()
        assert "Application shutdown complete" in engine_log.read_text(encoding="utf-8")
        prior_shutdown_count = engine_log.read_text(encoding="utf-8").count(
            "Application shutdown complete"
        )

        async with runtime.lease() as restarted_client:
            new_identity = (await restarted_client.get("/mona/identity")).json()
            assert new_identity["instance_id"] != original_identity["instance_id"]
            old_session = await restarted_client.get(f"/sessions/{old_session_id}")
            assert old_session.status_code == 200, old_session.text
            assert old_session.json()["title"] == "Synthetic lifecycle persistence"

        second_process = runtime._process
        assert second_process is not None
        restarted_idle = (await restarted_client.get("/mona/activity")).json()
        assert restarted_idle["active"] is False
        assert runtime._baseline_process_ids is not None
        assert second_process.process_ids() == runtime._baseline_process_ids
        assert second_process.process_count() == len(runtime._baseline_process_ids)
        await runtime.close()
        assert second_process.poll() is not None
        assert second_process.process_count() == 0
        assert runtime._process is None and runtime._ownership is None
        assert data_root.is_dir()
        assert (data_root / "sessions").is_dir()
        assert engine_log.read_text(encoding="utf-8").count(
            "Application shutdown complete"
        ) >= prior_shutdown_count + 1
    finally:
        await runtime.close()


def test_runtime_rejects_corrupted_program_hash_without_shared_install_mutation(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "isolated-bundle"
    originals = {
        "agent/api_server.py": b"synthetic-native-program\n",
        "agent/src/api/stock.py": b"synthetic-route-module\n",
        "agent/src/tools/provider.py": b"synthetic-provider-module\n",
    }
    items = []
    for relative, original in originals.items():
        program = bundle / relative
        program.parent.mkdir(parents=True, exist_ok=True)
        program.write_bytes(original)
        items.append({
            "role": "program",
            "path": relative,
            "bytes": len(original),
            "sha256": hashlib.sha256(original).hexdigest(),
        })
    receipt = {
        "inventory": {
            "files": items
        }
    }
    (bundle / "source-receipt.json").write_text(
        json.dumps(receipt), encoding="utf-8"
    )

    StockVibeRuntime._verify_bundle(bundle)
    for relative, original in originals.items():
        program = bundle / relative
        program.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        assert program.stat().st_size == len(original)
        with pytest.raises(StockVibeUnavailableError, match="校验失败"):
            StockVibeRuntime._verify_bundle(bundle)
        program.write_bytes(original)

    outside = tmp_path / "outside.py"
    outside.write_bytes(b"synthetic-outside-program\n")
    receipt["inventory"]["files"] = [{
        "role": "program",
        "path": "../outside.py",
        "bytes": outside.stat().st_size,
        "sha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
    }]
    (bundle / "source-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    with pytest.raises(StockVibeUnavailableError, match="文件损坏"):
        StockVibeRuntime._verify_bundle(bundle)


def test_startup_baseline_allows_only_launcher_chain_and_system_conhost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    system_root = tmp_path / "Windows"
    conhost = system_root / "System32" / "conhost.exe"
    conhost.parent.mkdir(parents=True)
    conhost.write_bytes(b"system conhost fixture")
    monkeypatch.setenv("SYSTEMROOT", str(system_root))
    snapshot = {
        100: OwnedProcessInfo(parent_pid=1, executable=tmp_path / "venv" / "python.exe"),
        101: OwnedProcessInfo(parent_pid=100, executable=tmp_path / "agent" / "api_server.py"),
        102: OwnedProcessInfo(parent_pid=100, executable=conhost),
    }

    assert StockVibeRuntime._verified_startup_process_ids(
        snapshot, launcher_pid=100, server_pid=101
    ) == {100, 101, 102}

    snapshot[103] = OwnedProcessInfo(
        parent_pid=101, executable=tmp_path / "worker" / "backtest.exe"
    )
    with pytest.raises(StockVibeUnavailableError, match="未识别的子进程"):
        StockVibeRuntime._verified_startup_process_ids(
            snapshot, launcher_pid=100, server_pid=101
        )
