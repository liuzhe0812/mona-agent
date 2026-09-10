"""HTTP contract for video series and style editor clients."""

import json
from unittest.mock import AsyncMock, MagicMock

from PIL import Image

from mona.api import video_series


def _request(body: dict | None = None, **match_info: str) -> MagicMock:
    request = MagicMock()
    request.match_info = match_info
    request.query = {}
    request.json = AsyncMock(return_value=body or {})
    return request


def _body(response) -> dict:
    return json.loads(response.body)


async def test_series_api_matches_style_editor_contract(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created = await video_series.handle_video_series_create(
        _request(
            {
                "name": "AI 编程实战课",
                "baseTemplateId": "tech-dark",
                "defaultAspectRatio": "16:9",
            }
        )
    )
    assert created.status == 201
    created_body = _body(created)
    series_id = created_body["series"]["id"]
    assert created_body["draft"]["revision"] == 0

    draft_response = await video_series.handle_video_style_draft_get(
        _request(series_id=series_id)
    )
    draft = _body(draft_response)
    assert draft["seriesId"] == series_id

    saved_response = await video_series.handle_video_style_draft_put(
        _request(
            {
                **draft,
                "revision": 0,
                "tokens": {
                    **draft["tokens"],
                    "colors": {**draft["tokens"]["colors"], "primary": "#2563EB"},
                },
            },
            series_id=series_id,
        )
    )
    saved = _body(saved_response)["draft"]
    assert saved["revision"] == 1
    assert saved["tokens"]["colors"]["primary"] == "#2563EB"

    validation_response = await video_series.handle_video_style_validate(
        _request(saved, series_id=series_id)
    )
    validation = _body(validation_response)
    assert validation == {"ok": True, "valid": True, "issues": []}

    locked_response = await video_series.handle_video_style_lock(
        _request({"revision": 1}, series_id=series_id)
    )
    locked = _body(locked_response)
    assert locked["ok"] is True
    assert locked["version"]["version"] == 1

    listed = _body(await video_series.handle_video_series_list(_request()))
    assert listed["series"][0]["latestStyleVersion"] == 1
    assert listed["series"][0]["styleSummary"]["primaryColor"] == "#2563EB"


async def test_style_draft_revision_conflict_is_409(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created = _body(
        await video_series.handle_video_series_create(
            _request({"name": "版本测试", "baseTemplateId": "minimal-business"})
        )
    )
    series_id = created["series"]["id"]
    draft = created["draft"]
    first = await video_series.handle_video_style_draft_put(
        _request(draft, series_id=series_id)
    )
    assert first.status == 200

    conflict = await video_series.handle_video_style_draft_put(
        _request(draft, series_id=series_id)
    )
    assert conflict.status == 409
    assert _body(conflict)["error"] == "STYLE_DRAFT_REVISION_CONFLICT"


async def test_brand_kit_api_creates_versions_and_applies_locked_tokens(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created_series = _body(
        await video_series.handle_video_series_create(
            _request({"name": "品牌系列", "baseTemplateId": "tech-dark"})
        )
    )
    series_id = created_series["series"]["id"]
    brand_response = await video_series.handle_video_brand_kit_create(
        _request(
            {
                "name": "企业品牌",
                "displayName": "MONA",
                "tokens": {
                    "colors": {
                        "primary": "#275DFF",
                        "secondary": "#00A88F",
                    },
                    "typography": {
                        "headingFamily": "Noto Sans SC",
                        "bodyFamily": "Noto Sans SC",
                    },
                },
            }
        )
    )
    assert brand_response.status == 201
    brand = _body(brand_response)
    kit_id = brand["brandKit"]["id"]
    assert brand["version"]["version"] == 1

    applied_response = await video_series.handle_video_series_apply_brand_kit(
        _request(
            {"brandKitId": kit_id, "version": 1},
            series_id=series_id,
        )
    )
    applied = _body(applied_response)["draft"]
    assert applied["tokens"]["colors"]["primary"] == "#275DFF"
    assert applied["brandKit"]["id"] == kit_id

    locked_change = await video_series.handle_video_style_draft_put(
        _request(
            {
                "revision": applied["revision"],
                "tokens": {"colors": {"primary": "#FF0000"}},
            },
            series_id=series_id,
        )
    )
    assert locked_change.status == 409
    assert _body(locked_change)["error"] == "BRAND_FIELDS_LOCKED"

    listed = _body(await video_series.handle_video_brand_kits(_request()))
    assert listed["brandKits"][0]["latestVersion"] == 1


async def test_series_create_applies_brand_version_atomically(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    brand = _body(
        await video_series.handle_video_brand_kit_create(
            _request(
                {
                    "name": "创建即绑定品牌",
                    "displayName": "MONA LAB",
                    "tokens": {
                        "colors": {
                            "primary": "#275DFF",
                            "secondary": "#00A88F",
                        },
                        "typography": {
                            "headingFamily": "Noto Sans SC",
                            "bodyFamily": "Noto Sans SC",
                        },
                    },
                }
            )
        )
    )

    response = await video_series.handle_video_series_create(
        _request(
            {
                "name": "品牌原子系列",
                "baseTemplateId": "tech-dark",
                "brandKitId": brand["brandKit"]["id"],
                "brandKitVersion": brand["version"]["version"],
            }
        )
    )

    assert response.status == 201
    created = _body(response)
    assert created["draft"]["brandKit"]["id"] == brand["brandKit"]["id"]
    assert created["draft"]["brandKit"]["version"] == 1
    assert created["draft"]["tokens"]["colors"]["primary"] == "#275DFF"

    failed = await video_series.handle_video_series_create(
        _request(
            {
                "name": "不能留下半成品",
                "baseTemplateId": "tech-dark",
                "brandKitId": brand["brandKit"]["id"],
                "brandKitVersion": 99,
            }
        )
    )
    assert failed.status == 404
    assert len(list((tmp_path / "video_series").iterdir())) == 1


async def test_brand_logo_api_creates_a_new_immutable_version(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    brand = _body(
        await video_series.handle_video_brand_kit_create(
            _request(
                {
                    "name": "Logo API 品牌",
                    "displayName": "MONA",
                    "tokens": {
                        "colors": {"primary": "#275DFF", "secondary": "#00A88F"},
                        "typography": {
                            "headingFamily": "Noto Sans SC",
                            "bodyFamily": "Noto Sans SC",
                        },
                    },
                }
            )
        )
    )
    source = tmp_path / "brand-logo.png"
    Image.new("RGBA", (96, 64), (39, 93, 255, 255)).save(source)

    uploaded_response = await video_series.handle_video_brand_logo_import(
        _request(
            {
                "filePath": str(source),
                "variant": "light",
                "rightsStatus": "owned",
                "alt": "MONA Logo",
            },
            kit_id=brand["brandKit"]["id"],
        )
    )
    assert uploaded_response.status == 200
    uploaded = _body(uploaded_response)
    assert uploaded["logo"]["commercialUse"] is True
    assert uploaded["brandKit"]["revision"] == 1

    locked_response = await video_series.handle_video_brand_kit_lock(
        _request(
            {"revision": uploaded["brandKit"]["revision"]},
            kit_id=brand["brandKit"]["id"],
        )
    )
    assert locked_response.status == 200
    locked = _body(locked_response)["version"]
    assert locked["version"] == 2
    assert locked["brand"]["logo"]["light"]["path"].startswith("assets/")

    created = _body(
        await video_series.handle_video_series_create(
            _request(
                {
                    "name": "Logo 预览系列",
                    "baseTemplateId": "tech-dark",
                    "brandKitId": brand["brandKit"]["id"],
                    "brandKitVersion": 2,
                }
            )
        )
    )
    preview = _body(
        await video_series.handle_video_style_preview(
            _request(
                {
                    "style": created["draft"],
                    "role": "outro",
                    "aspectRatio": "16:9",
                },
                series_id=created["series"]["id"],
            )
        )
    )["html"]
    assert 'class="brand-logo"' in preview
    assert 'src="data:image/webp;base64,' in preview


async def test_style_preview_uses_the_production_scene_compiler(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created = _body(
        await video_series.handle_video_series_create(
            _request({"name": "真实预览", "baseTemplateId": "tech-dark"})
        )
    )
    series_id = created["series"]["id"]
    draft = created["draft"]

    previews = {}
    for role in ("cover", "content", "data", "outro"):
        preview_style = draft
        if role == "outro":
            preview_style = {**draft, "brand": {"displayName": "MONA LAB"}}
        response = await video_series.handle_video_style_preview(
            _request(
                {"style": preview_style, "role": role, "aspectRatio": "16:9"},
                series_id=series_id,
            )
        )
        assert response.status == 200
        html = _body(response)["html"]
        assert 'data-template="neon-core"' in html
        assert f'data-role="{role}"' in html
        previews[role] = html
    assert len(set(previews.values())) == 4
    assert "MONA LAB" in previews["outro"]


async def test_empty_series_can_be_deleted(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created = _body(
        await video_series.handle_video_series_create(
            _request({"name": "待删除系列", "baseTemplateId": "tech-dark"})
        )
    )
    series_id = created["series"]["id"]

    deleted = await video_series.handle_video_series_delete(
        _request(series_id=series_id)
    )

    assert deleted.status == 200
    assert _body(deleted) == {
        "ok": True,
        "deletedSeriesId": series_id,
        "detachedEpisodeCount": 0,
    }
    assert not (tmp_path / "video_series" / series_id).exists()


async def test_series_can_be_renamed_archived_and_restored_without_losing_projects(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created = _body(
        await video_series.handle_video_series_create(
            _request({"name": "旧系列名", "baseTemplateId": "tech-dark"})
        )
    )
    series_id = created["series"]["id"]
    project = tmp_path / "video_projects" / "episode"
    project.mkdir(parents=True)
    (project / "meta.json").write_text(
        json.dumps(
            {"name": "episode", "seriesId": series_id, "seriesName": "旧系列名"},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    renamed = await video_series.handle_video_series_update(
        _request({"name": "新系列名"}, series_id=series_id)
    )
    assert renamed.status == 200
    assert _body(renamed)["series"]["name"] == "新系列名"
    project_meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert project_meta["seriesName"] == "新系列名"

    archived = await video_series.handle_video_series_update(
        _request({"archived": True}, series_id=series_id)
    )
    assert archived.status == 200
    assert _body(archived)["series"]["archivedAt"]
    active = _body(await video_series.handle_video_series_list(_request()))
    assert active["series"] == []
    all_request = _request()
    all_request.query = {"includeArchived": "true"}
    all_series = _body(await video_series.handle_video_series_list(all_request))
    assert all_series["series"][0]["name"] == "新系列名"

    restored = await video_series.handle_video_series_update(
        _request({"archived": False}, series_id=series_id)
    )
    assert restored.status == 200
    assert not _body(restored)["series"].get("archivedAt")
    assert project.is_dir()


async def test_series_delete_requires_explicit_detach_and_preserves_episodes(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    created = _body(
        await video_series.handle_video_series_create(
            _request({"name": "课程系列", "baseTemplateId": "tech-dark"})
        )
    )
    series_id = created["series"]["id"]
    project = tmp_path / "video_projects" / "episode-01"
    (project / "style").mkdir(parents=True)
    (project / "style" / "design-system.json").write_text("{}", encoding="utf-8")
    (project / "meta.json").write_text(
        json.dumps(
            {
                "name": "episode-01",
                "seriesId": series_id,
                "seriesName": "课程系列",
                "styleVersion": 1,
                "episodeNumber": 1,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    blocked = await video_series.handle_video_series_delete(
        _request(series_id=series_id)
    )
    assert blocked.status == 409
    assert _body(blocked)["error"] == "SERIES_HAS_EPISODES"

    confirmed_request = _request(series_id=series_id)
    confirmed_request.query = {"detachEpisodes": "true"}
    deleted = await video_series.handle_video_series_delete(confirmed_request)

    assert deleted.status == 200
    assert _body(deleted)["detachedEpisodeCount"] == 1
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert "seriesId" not in meta
    assert meta["styleVersion"] == 1
    assert meta["detachedFromSeries"] is True
    assert (project / "style" / "design-system.json").is_file()
    assert not (tmp_path / "video_series" / series_id).exists()
