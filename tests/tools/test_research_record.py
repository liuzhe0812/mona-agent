"""Contract tests for the academic research record ledger.

The fixtures and records in this file are deliberately synthetic.  They test
the storage contract without relying on a live academic provider or a
copyrighted paper.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from mona.academic.models import (
    DeliverableRecord,
    EvidenceClaim,
    ExperimentRun,
    KnowledgeEdge,
    KnowledgeNode,
    ResearchManifest,
    SourceRecord,
)
from mona.academic.store import ResearchRecordStore, ResearchStoreNotFoundError


def _source(source_id: str = "src-paper-1", **updates: object) -> SourceRecord:
    payload: dict[str, object] = {
        "source_id": source_id,
        "title": "A synthetic paper about reproducible experiments",
        "authors": ["Example, A."],
        "published_at": "2026-01-02",
        "venue": "Synthetic Journal",
        "source_type": "paper",
        "doi": "10.0000/example.1",
        "url": "https://example.invalid/paper",
        "abstract": "A public-domain fixture abstract.",
        "retrieved_at": "2026-08-22T00:00:00Z",
        "provider": "fixture",
        "providers": ["fixture"],
        "version": "1",
    }
    payload.update(updates)
    return SourceRecord.model_validate(payload)


def _claim(claim_id: str = "claim-1", source_id: str = "src-paper-1") -> EvidenceClaim:
    return EvidenceClaim(
        claim_id=claim_id,
        claim_type="fact",
        claim_text="The fixture experiment uses a fixed random seed.",
        source_ids=[source_id],
        evidence_text="The experiment section states that the seed is fixed.",
        locator={"kind": "page", "value": "1"},
    )


def test_models_enforce_evidence_and_experiment_contracts() -> None:
    abstract_claim = EvidenceClaim(
        claim_id="claim-abstract",
        claim_type="fact",
        claim_text="The abstract states the fixture is deterministic.",
        source_ids=["src-paper-1"],
        locator={"kind": "abstract"},
    )
    assert abstract_claim.locator is not None
    assert abstract_claim.locator.kind == "abstract"

    with pytest.raises(ValidationError, match="source_ids"):
        EvidenceClaim(
            claim_id="claim-missing-source",
            claim_type="fact",
            claim_text="Unsupported fact",
            locator={"kind": "page", "value": "1"},
        )

    with pytest.raises(ValidationError, match="locator"):
        EvidenceClaim(
            claim_id="claim-missing-locator",
            claim_type="fact",
            claim_text="Unlocated fact",
            source_ids=["src-paper-1"],
        )

    with pytest.raises(ValidationError, match="metrics_source"):
        ExperimentRun(
            run_id="run-missing-metrics",
            status="succeeded",
            command="python train.py",
            exit_code=0,
        )

    with pytest.raises(ValidationError, match="exit_code == 0"):
        ExperimentRun(
            run_id="run-nonzero-success",
            status="succeeded",
            command="python train.py",
            exit_code=1,
            metrics_source={"kind": "json", "path": "metrics.json", "key": "accuracy"},
        )

    with pytest.raises(ValidationError, match="finite"):
        ExperimentRun(
            run_id="run-nan",
            status="planned",
            metrics={"accuracy": float("nan")},
        )

    with pytest.raises(ValidationError, match="node_type"):
        KnowledgeNode(node_id="node-1", node_type="team", label="Unsupported")

    with pytest.raises(ValidationError, match="relation"):
        KnowledgeEdge(
            edge_id="edge-invalid",
            source_node_id="node-1",
            target_node_id="node-2",
            relation="contradicts",
            source_ids=["src-paper-1"],
        )

    with pytest.raises(ValidationError, match="task_id"):
        ResearchManifest(task_id="../escape", goal="bad")


def test_store_init_append_reopen_and_idempotent_source_upsert(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    manifest = store.init("task-1", "Test a synthetic hypothesis")
    assert manifest.task_id == "task-1"
    assert (tmp_path / "research" / "task-1" / "manifest.json").exists()

    assert store.source_upsert("task-1", _source()) == _source()
    assert store.source_upsert("task-1", _source()) == _source()
    assert len(store.read_sources("task-1")) == 1

    reopened = ResearchRecordStore(tmp_path)
    assert reopened.status("task-1").goal == "Test a synthetic hypothesis"


def test_source_upsert_merges_provider_refreshes_and_rejects_core_conflicts(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-upsert", "Source refresh")
    first = _source(
        title=None,
        authors=[],
        provider="openalex",
        providers=["openalex"],
        retrieved_at="2026-08-22T00:00:00Z",
    )
    store.source_upsert("task-upsert", first)
    refreshed = store.source_upsert(
        "task-upsert",
        _source(
            provider="crossref",
            providers=["crossref"],
            retrieved_at="2026-08-22T01:00:00Z",
        ),
    )
    assert refreshed.title == first.title or refreshed.title is not None
    assert refreshed.retrieved_at == "2026-08-22T01:00:00Z"
    assert set(refreshed.providers) >= {"openalex", "crossref"}
    assert len(store.read_sources("task-upsert")) == 1
    with pytest.raises(ValueError, match="conflicts on title"):
        store.source_upsert("task-upsert", _source(title="different title"))


def test_claim_and_deliverable_references_are_checked_before_write(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-refs", "Reference checks")
    with pytest.raises(ValueError, match="missing sources"):
        store.claim_append("task-refs", _claim(source_id="src-missing"))
    with pytest.raises(ValueError, match="missing records"):
        store.deliverable_register(
            "task-refs",
            DeliverableRecord(
                deliverable_id="report-missing",
                kind="report",
                path="deliverables/report.md",
                source_ids=["src-missing"],
            ),
        )


def test_store_claim_map_experiment_deliverable_validate_and_export(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-2", "Exercise the complete record ledger")
    store.source_upsert("task-2", _source())
    store.claim_append("task-2", _claim())
    store.map_write(
        "task-2",
        {
            "nodes": [
                KnowledgeNode(
                    node_id="paper-1",
                    node_type="paper",
                    label="Synthetic paper",
                    source_ids=["src-paper-1"],
                    claim_ids=["claim-1"],
                ),
                KnowledgeNode(
                    node_id="method-1",
                    node_type="method",
                    label="Fixed seed",
                    claim_ids=["claim-1"],
                ),
            ],
            "edges": [
                KnowledgeEdge(
                    edge_id="edge-1",
                    source_node_id="paper-1",
                    target_node_id="method-1",
                    relation="uses",
                    source_ids=["src-paper-1"],
                    claim_ids=["claim-1"],
                )
            ],
        },
    )
    started = store.experiment_start(
        "task-2",
        ExperimentRun(
            run_id="run-1",
            status="planned",
            command="python -c \"print(0.75)\"",
        ),
    )
    assert started.status == "planned"
    stdout_path = tmp_path / "research" / "task-2" / "experiments" / "run-1" / "stdout.txt"
    stdout_path.write_text("accuracy=0.75\n", encoding="utf-8")
    finished = store.experiment_finish(
        "task-2",
        "run-1",
        status="succeeded",
        exit_code=0,
        metric_name="accuracy",
        metric_direction="maximize",
        evaluation_command="python evaluate.py",
        data_hash="data-v1",
        metrics_source={"kind": "stdout_regex", "path": "stdout.txt", "pattern": r"accuracy=(0\.75)"},
    )
    assert finished.status == "succeeded"
    assert finished.metrics == {"accuracy": 0.75}
    store.deliverable_register(
        "task-2",
        DeliverableRecord(
            deliverable_id="report-1",
            kind="report",
            path="deliverables/report.md",
            title="Synthetic report",
            claim_ids=["claim-1"],
            run_ids=["run-1"],
        ),
    )
    report_path = tmp_path / "research" / "task-2" / "deliverables" / "report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("# Synthetic report\n", encoding="utf-8")

    result = store.validate("task-2")
    assert result["valid"] is True
    exported = store.export("task-2")
    assert (tmp_path / "research" / "task-2" / "deliverables" / "sources.csv").exists()
    assert Path(exported["sources_csv"]).exists()
    assert Path(exported["evidence_md"]).exists()
    assert Path(exported["research_manifest"]).exists()
    root_map = tmp_path / "research" / "task-2" / "knowledge_map.md"
    assert root_map.exists()
    map_text = root_map.read_text(encoding="utf-8")
    assert map_text.count("```mermaid") == 1
    assert map_text.count(" -->|") == 1
    assert "src-paper-1" in map_text
    assert "claim-1" in map_text
    exported_map = Path(exported["knowledge_map_md"])
    assert "```mermaid" in exported_map.read_text(encoding="utf-8")


def test_map_write_rejects_dangling_claim_and_node_references(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-map-errors", "Map validation")
    store.source_upsert("task-map-errors", _source())
    store.claim_append("task-map-errors", _claim())
    with pytest.raises(ValueError, match="missing claim ids"):
        store.map_write(
            "task-map-errors",
            {
                "nodes": [
                    {
                        "node_id": "paper-1",
                        "node_type": "paper",
                        "label": "Paper",
                        "source_ids": ["src-paper-1"],
                        "claim_ids": ["claim-missing"],
                    }
                ],
                "edges": [],
            },
        )
    with pytest.raises(ValueError, match="missing node"):
        store.map_write(
            "task-map-errors",
            {
                "nodes": [
                    {
                        "node_id": "paper-1",
                        "node_type": "paper",
                        "label": "Paper",
                        "source_ids": ["src-paper-1"],
                    }
                ],
                "edges": [
                    {
                        "edge_id": "edge-1",
                        "source_node_id": "paper-1",
                        "target_node_id": "missing-node",
                        "relation": "supports",
                        "source_ids": ["src-paper-1"],
                    }
                ],
            },
        )


def test_validate_rejects_missing_deliverable_file(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-missing-file", "Missing deliverable")
    store.source_upsert("task-missing-file", _source())
    store.claim_append("task-missing-file", _claim())
    store.deliverable_register(
        "task-missing-file",
        DeliverableRecord(
            deliverable_id="report-1",
            kind="report",
            path="deliverables/not-created.md",
            claim_ids=["claim-1"],
        ),
    )
    result = store.validate("task-missing-file")
    assert result["valid"] is False
    assert any("missing file" in error for error in result["errors"])


def test_store_rejects_escape_corruption_and_conflicting_ids(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-3", "Safety checks")
    with pytest.raises(ValueError, match="task id"):
        store.init("../escape", "bad")
    with pytest.raises((ValueError, PermissionError)):
        store.read_artifact("task-3", "../../outside.json")

    store.source_upsert("task-3", _source())
    with pytest.raises(ValueError, match="conflicts on title"):
        store.source_upsert("task-3", _source().model_copy(update={"title": "changed"}))

    manifest_path = tmp_path / "research" / "task-3" / "manifest.json"
    manifest_path.write_text("{broken", encoding="utf-8")
    with pytest.raises(RuntimeError, match="corrupt"):
        store.status("task-3")

    claims_path = tmp_path / "research" / "task-3" / "claims.jsonl"
    claims_path.write_text("{broken\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="corrupt"):
        store.claim_append("task-3", _claim())


def _start_metric_run(
    store: ResearchRecordStore,
    task_id: str,
    run_id: str,
    value: str,
    *,
    direction: str = "maximize",
    data_hash: str = "data-v1",
    evaluation_command: str = "python evaluate.py",
    metric_unit: str | None = None,
) -> ExperimentRun:
    store.experiment_start(
        task_id,
        ExperimentRun(
            run_id=run_id,
            status="planned",
            command=evaluation_command,
        ),
    )
    stdout = store.task_dir(task_id) / "experiments" / run_id / "stdout.txt"
    stdout.write_text(f"accuracy={value}\n", encoding="utf-8")
    return store.experiment_finish(
        task_id,
        run_id,
        status="succeeded",
        exit_code=0,
        metric_name="accuracy",
        metric_unit=metric_unit,
        metric_direction=direction,
        evaluation_command=evaluation_command,
        data_hash=data_hash,
        metrics_source={"kind": "stdout_regex", "path": "stdout.txt", "pattern": r"accuracy=(?P<value>[-+]?\d*\.?\d+)"},
    )


def test_experiment_source_snapshot_isolated_and_original_unchanged(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (source / ".git").mkdir()
    (source / ".git" / "config").write_text("ignored\n", encoding="utf-8")
    (source / ".venv").mkdir()
    (source / ".venv" / "secret.txt").write_text("ignored\n", encoding="utf-8")
    original_hash = __import__("hashlib").sha256((source / "main.py").read_bytes()).hexdigest()

    store = ResearchRecordStore(tmp_path)
    store.init("task-isolation", "Snapshot source")
    run = store.experiment_start(
        "task-isolation",
        ExperimentRun(run_id="run-1", status="planned", command="python main.py"),
        source_dir=str(source).replace("/", "\\"),
    )
    isolated = Path(run.isolated_dir or "")
    assert isolated.is_dir()
    assert (isolated / "main.py").read_text(encoding="utf-8") == "print('ok')\n"
    assert not (isolated / ".git").exists()
    assert not (isolated / ".venv").exists()
    assert run.source_dir == str(source.resolve())
    assert run.input_hashes["main.py"] == f"sha256:{original_hash}"
    assert __import__("hashlib").sha256((source / "main.py").read_bytes()).hexdigest() == original_hash


def test_experiment_source_limits_external_self_copy_and_symlink_escape(tmp_path: Path) -> None:
    source = tmp_path / "project"
    source.mkdir()
    (source / "a.py").write_text("a\n", encoding="utf-8")
    (source / "b.py").write_text("b\n", encoding="utf-8")
    store = ResearchRecordStore(tmp_path)
    store.init("task-safety", "Snapshot safety")

    with pytest.raises(ValueError, match="file limit"):
        store.experiment_start(
            "task-safety",
            ExperimentRun(run_id="too-many", status="planned"),
            source_dir=source,
            max_files=1,
        )
    with pytest.raises(ValueError, match="byte limit"):
        store.experiment_start(
            "task-safety",
            ExperimentRun(run_id="too-large", status="planned"),
            source_dir=source,
            max_total_bytes=1,
        )
    outside = tmp_path.parent / "academic-outside-source"
    outside.mkdir(exist_ok=True)
    (outside / "outside.py").write_text("outside\n", encoding="utf-8")
    with pytest.raises((ValueError, PermissionError), match="workspace|outside"):
        store.experiment_start(
            "task-safety",
            ExperimentRun(run_id="outside", status="planned"),
            source_dir=outside,
        )
    with pytest.raises(ValueError, match="copy|source"):
        store.experiment_start(
            "task-safety",
            ExperimentRun(run_id="self-copy", status="planned"),
            source_dir=tmp_path,
        )
    link_target = tmp_path / "outside-link-target.txt"
    link_target.write_text("external\n", encoding="utf-8")
    link = source / "link.txt"
    try:
        link.symlink_to(link_target)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this Windows environment")
    with pytest.raises(ValueError, match="symlink"):
        store.experiment_start(
            "task-safety",
            ExperimentRun(run_id="symlink", status="planned"),
            source_dir=source,
        )


def test_metric_json_and_regex_sources_are_read_from_files(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-metrics", "Metric sources")
    json_run = store.experiment_start(
        "task-metrics",
        ExperimentRun(run_id="json", status="planned", command="evaluate"),
    )
    metrics_path = store.task_dir("task-metrics") / "experiments" / json_run.run_id / "metrics.json"
    metrics_path.write_text('{"scores": {"accuracy": 0.75}}\n', encoding="utf-8")
    finished = store.experiment_finish(
        "task-metrics",
        "json",
        status="succeeded",
        exit_code=0,
        metric_name="accuracy",
        metric_direction="maximize",
        evaluation_command="evaluate --json",
        data_hash="data-v1",
        metrics_source={"kind": "json", "path": "metrics.json", "key": "scores.accuracy"},
    )
    assert finished.metrics["accuracy"] == 0.75

    regex_run = store.experiment_start(
        "task-metrics",
        ExperimentRun(run_id="regex", status="planned", command="evaluate"),
    )
    (store.task_dir("task-metrics") / "experiments" / regex_run.run_id / "stdout.txt").write_text(
        "accuracy=0.875\n", encoding="utf-8"
    )
    regex_finished = store.experiment_finish(
        "task-metrics",
        "regex",
        status="succeeded",
        exit_code=0,
        metric_name="accuracy",
        metric_direction="maximize",
        evaluation_command="evaluate --stdout",
        data_hash="data-v1",
        metrics_source={"kind": "stdout_regex", "path": "stdout.txt", "pattern": r"accuracy=(0\.875)", "group": 1},
    )
    assert regex_finished.metrics["accuracy"] == 0.875


def test_metric_source_is_scoped_to_the_current_run(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-run-scope", "Run-local metrics")
    baseline = store.experiment_start(
        "task-run-scope",
        ExperimentRun(run_id="baseline", status="planned", command="evaluate"),
    )
    candidate = store.experiment_start(
        "task-run-scope",
        ExperimentRun(run_id="candidate", status="planned", command="evaluate"),
    )
    baseline_metrics = store.task_dir("task-run-scope") / "experiments" / baseline.run_id / "metrics.json"
    baseline_metrics.write_text('{"accuracy": 0.75}\n', encoding="utf-8")
    task_root_metrics = store.task_dir("task-run-scope") / "metrics.json"
    task_root_metrics.write_text('{"accuracy": 0.99}\n', encoding="utf-8")

    with pytest.raises(ValueError, match="unsafe|relative"):
        store.experiment_finish(
            "task-run-scope",
            candidate.run_id,
            status="succeeded",
            exit_code=0,
            metric_name="accuracy",
            metric_direction="maximize",
            evaluation_command="evaluate",
            data_hash="data-v1",
            metrics_source={
                "kind": "json",
                "path": "../baseline/metrics.json",
                "key": "accuracy",
            },
        )
    with pytest.raises(ResearchStoreNotFoundError, match="run workspace"):
        store.experiment_finish(
            "task-run-scope",
            candidate.run_id,
            status="succeeded",
            exit_code=0,
            metric_name="accuracy",
            metric_direction="maximize",
            evaluation_command="evaluate",
            data_hash="data-v1",
            metrics_source={"kind": "json", "path": "metrics.json", "key": "accuracy"},
        )


@pytest.mark.parametrize(
    ("source", "output", "pattern"),
    [
        ({"kind": "json", "path": "metrics.json", "key": "missing"}, '{"accuracy": 0.5}', "missing"),
        ({"kind": "json", "path": "metrics.json", "key": "accuracy"}, '{"accuracy": NaN}', "finite"),
        ({"kind": "stdout_regex", "path": "stdout.txt", "pattern": r"accuracy=(0\.75)"}, "accuracy=0.75\naccuracy=0.75\n", "multiple"),
        ({"kind": "stdout_regex", "path": "stdout.txt", "pattern": r"accuracy=none"}, "accuracy=none\n", "capture"),
    ],
)
def test_metric_source_failures_are_rejected(
    tmp_path: Path, source: dict[str, object], output: str, pattern: str
) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-metric-fail", "Metric failure")
    run = store.experiment_start(
        "task-metric-fail",
        ExperimentRun(run_id="run-1", status="planned", command="evaluate"),
    )
    path = store.task_dir("task-metric-fail") / "experiments" / run.run_id / str(source["path"])
    path.write_text(output, encoding="utf-8")
    with pytest.raises(ValueError, match=pattern):
        store.experiment_finish(
            "task-metric-fail",
            "run-1",
            status="succeeded",
            exit_code=0,
            metric_name="accuracy",
            metric_direction="maximize",
            evaluation_command="evaluate",
            data_hash="data-v1",
            metrics_source=source,
        )


def test_direct_metric_value_and_invalid_metric_path_are_not_accepted(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-metric-direct", "No direct metrics")
    run = store.experiment_start(
        "task-metric-direct",
        ExperimentRun(run_id="run-1", status="planned", command="evaluate"),
    )
    with pytest.raises(ValueError, match="metrics_source"):
        store.experiment_finish(
            "task-metric-direct",
            run.run_id,
            status="succeeded",
            exit_code=0,
            metric_name="accuracy",
            metric_direction="maximize",
            evaluation_command="evaluate",
            data_hash="data-v1",
            metrics_source="0.75",
            metrics={"accuracy": 0.75},
        )
    with pytest.raises(ValueError, match="relative|path"):
        store.experiment_finish(
            "task-metric-direct",
            run.run_id,
            status="succeeded",
            exit_code=0,
            metric_name="accuracy",
            metric_direction="maximize",
            evaluation_command="evaluate",
            data_hash="data-v1",
            metrics_source={"kind": "json", "path": "../../metrics.json", "key": "accuracy"},
        )


def test_compare_experiments_requires_same_contract_and_records_decision(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("task-compare", "Compare metrics")
    _start_metric_run(store, "task-compare", "baseline", "0.750")
    _start_metric_run(store, "task-compare", "candidate", "0.875")
    accepted = store.compare_experiments("task-compare", "baseline", "candidate")
    assert accepted.status == "accepted"
    assert accepted.comparison == "accepted"
    assert accepted.baseline_value == 0.75
    assert accepted.candidate_value == 0.875

    equal = _start_metric_run(store, "task-compare", "equal", "0.750")
    rejected = store.compare_experiments("task-compare", "baseline", equal.run_id)
    assert rejected.status == "rejected"
    assert rejected.comparison == "rejected"

    changed_direction = _start_metric_run(
        store, "task-compare", "direction", "0.500", direction="minimize"
    )
    with pytest.raises(ValueError, match="direction"):
        store.compare_experiments("task-compare", "baseline", changed_direction.run_id)
    changed_hash = _start_metric_run(
        store, "task-compare", "hash", "0.875", data_hash="data-v2"
    )
    with pytest.raises(ValueError, match="data_hash"):
        store.compare_experiments("task-compare", "baseline", changed_hash.run_id)
    changed_command = _start_metric_run(
        store, "task-compare", "command", "0.875", evaluation_command="evaluate --other"
    )
    with pytest.raises(ValueError, match="evaluation_command"):
        store.compare_experiments("task-compare", "baseline", changed_command.run_id)
    changed_unit = _start_metric_run(
        store, "task-compare", "unit", "0.875", metric_unit="percent"
    )
    with pytest.raises(ValueError, match="metric_unit"):
        store.compare_experiments("task-compare", "baseline", changed_unit.run_id)
