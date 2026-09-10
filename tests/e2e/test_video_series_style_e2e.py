"""HTTP-level series style flow through deterministic scene generation."""

import json
import types

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import mona.agent  # noqa: F401
import mona.api.server as server
from mona.api import video_series


async def test_series_style_http_flow_compiles_scene(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    monkeypatch.setattr(server, "get_workspace_path", lambda: tmp_path)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")

    class Provider:
        async def chat_with_retry(self, **_kwargs):
            return types.SimpleNamespace(
                content=json.dumps(
                    {
                        "schemaVersion": 1,
                        "sceneIndex": 1,
                        "role": "content",
                        "layout": "content-outline",
                        "backgroundSlot": "content",
                        "animationPreset": "fade-rise",
                        "duration": 5,
                        "content": {
                            "title": "认识 AI 编程",
                            "bullets": ["理解需求", "生成页面", "持续优化"],
                        },
                    },
                    ensure_ascii=False,
                )
            )

    import mona.providers.factory as factory

    monkeypatch.setattr(
        factory,
        "load_provider_snapshot",
        lambda: types.SimpleNamespace(provider=Provider(), model="test"),
    )

    app = web.Application()
    app.router.add_post("/api/video/series", video_series.handle_video_series_create)
    app.router.add_get(
        "/api/video/series/{series_id}/style/draft",
        video_series.handle_video_style_draft_get,
    )
    app.router.add_post(
        "/api/video/series/{series_id}/style/lock",
        video_series.handle_video_style_lock,
    )
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post(
        "/api/video/project/lock-storyboard",
        server.handle_video_project_lock_storyboard,
    )
    app.router.add_post("/api/video/ai/scene-html", server.handle_video_ai_scene_html)
    app.router.add_get(
        "/api/video/project/scene/preview",
        server.handle_video_project_scene_preview,
    )

    async with TestClient(TestServer(app)) as client:
        response = await client.post(
            "/api/video/series",
            json={
                "name": "AI 编程实战课",
                "baseTemplateId": "tech-dark",
                "defaultAspectRatio": "16:9",
            },
        )
        assert response.status == 201
        created = await response.json()
        series_id = created["series"]["id"]

        response = await client.post(
            f"/api/video/series/{series_id}/style/lock", json={"revision": 0}
        )
        assert response.status == 200
        version = (await response.json())["version"]["version"]

        response = await client.post(
            "/api/video/project/create",
            json={
                "name": "episode-01",
                "seriesId": series_id,
                "styleVersion": version,
                "aspectVariant": "16:9",
            },
        )
        assert response.status == 200

        project = tmp_path / "video_projects" / "episode-01"
        meta = server._load_video_meta(project)
        meta["scenes"] = [
            {
                "index": 1,
                "title": "认识 AI 编程",
                "role": "content",
                "layout": "content-outline",
                "backgroundSlot": "content",
                "duration": 5,
                "durationRaw": "5s",
                "visual": "标题和三个要点",
                "animation": "淡入",
                "narration": "AI 编程让需求更快变成页面。",
                "assets": [],
            }
        ]
        server._sync_storyboard(project, meta["scenes"])
        server._save_video_meta(project, meta)

        response = await client.post(
            "/api/video/project/lock-storyboard", json={"name": "episode-01"}
        )
        assert response.status == 200

        response = await client.post(
            "/api/video/ai/scene-html", json={"name": "episode-01", "index": 1}
        )
        assert response.status == 200
        assert (project / "scene_specs" / "scene_01.json").is_file()
        assert (project / "scenes" / "scene_01.html").is_file()

        response = await client.get(
            "/api/video/project/scene/preview",
            params={"name": "episode-01", "index": "1"},
        )
        assert response.status == 200
        html = await response.text()
        assert "认识 AI 编程" in html
        assert "window.__timelines" in html
