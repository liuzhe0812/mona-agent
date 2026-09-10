import json

from app.config import settings


def test_distribution_catalogs_are_served_from_vps_files(client, tmp_path, monkeypatch):
    expert_catalog = tmp_path / "experts.json"
    runtime_catalog = tmp_path / "runtimes.json"
    expert_catalog.write_text(
        json.dumps({"schemaVersion": 1, "generatedAt": "2026-08-29T00:00:00Z", "experts": []}),
        encoding="utf-8",
    )
    runtime_catalog.write_text(
        json.dumps({"schemaVersion": 1, "generatedAt": "2026-08-29T00:00:00Z", "components": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr(settings, "expert_catalog_path", str(expert_catalog))
    monkeypatch.setattr(settings, "runtime_catalog_path", str(runtime_catalog))

    experts = client.get("/config/experts/catalog-v1.json")
    runtimes = client.get("/config/runtimes/catalog-v1.json")

    assert experts.status_code == 200
    assert experts.json()["experts"] == []
    assert experts.headers["cache-control"] == "no-cache"
    assert runtimes.status_code == 200
    assert runtimes.json()["components"] == []


def test_unpublished_distribution_catalog_returns_404(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "expert_catalog_path", str(tmp_path / "missing.json"))

    response = client.get("/config/experts/catalog-v1.json")

    assert response.status_code == 404
