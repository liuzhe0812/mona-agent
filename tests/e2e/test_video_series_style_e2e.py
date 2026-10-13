"""HTTP-level saved style to freely authored video scene."""

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import mona.agent  # noqa: F401
import mona.api.server as server
from mona.api import video_series
from mona.api.video_director import OWNER_HEADER, handle_video_agent
from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token


async def test_saved_style_http_flow_accepts_authored_scene(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    monkeypatch.setattr(server, "get_workspace_path", lambda: tmp_path)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")
    app = web.Application()
    app.router.add_post("/api/video/series", video_series.handle_video_series_create)
    app.router.add_post("/api/video/series/{series_id}/style/lock", video_series.handle_video_style_lock)
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post("/api/video/project-save-chat-id", server.handle_video_project_save_chat_id)
    app.router.add_post("/api/video/agent", handle_video_agent)
    app.router.add_get("/api/video/project/scene/preview", server.handle_video_project_scene_preview)

    async with TestClient(TestServer(app)) as client:
        response = await client.post("/api/video/series", json={
            "name": "我的风格", "baseTemplateId": "tech-dark", "defaultAspectRatio": "16:9",
        })
        assert response.status == 201
        series_id = (await response.json())["series"]["id"]
        response = await client.post(f"/api/video/series/{series_id}/style/lock", json={"revision": 0})
        assert response.status == 200
        version = (await response.json())["version"]["version"]
        response = await client.post("/api/video/project/create", json={
            "name": "custom-video", "styleSeriesId": series_id, "styleVersion": version,
            "aspectVariant": "9:16",
        })
        assert response.status == 200
        project = tmp_path / "video_projects" / "custom-video"
        meta = server._load_video_meta(project)
        assert meta["resolution"] == "1080x1920"
        assert meta["authoringMode"] == "agent"
        assert not meta["structuredCompiler"]
        assert not meta.get("seriesId")
        response = await client.post("/api/video/project-save-chat-id", json={"name": "custom-video", "chatId": "test-director"})
        assert response.status == 200
        source = '<svg viewBox="0 0 1080 1920"><text x="100" y="200" fill="var(--mona-primary)">认识 AI 编程</text><path d="M 100 300 L 800 900" stroke="var(--mona-accent)"/></svg>'
        (project / "drafts" / "scene_01.html").write_text(source, encoding="utf-8")
        response = await client.post("/api/video/agent", headers={
            SERVICES_TOKEN_HEADER: get_services_token(), OWNER_HEADER: "test-director",
        }, json={"action": "sync", "name": "custom-video", "scene_index": 1, "scene": {
            "title": "认识 AI 编程", "duration": 5, "narration": "", "visual": "自由图解",
        }})
        assert response.status == 200
        assert (await response.json())["scene"]["authored"]
        assert (project / "scene_sources" / "scene_01.html").read_text(encoding="utf-8") == source
        response = await client.get("/api/video/project/scene/preview", params={"name": "custom-video", "index": "1"})
        assert response.status == 200
        rendered = await response.text()
        assert "认识 AI 编程" in rendered
        assert 'sandbox="allow-scripts"' in rendered
        assert "width:1080px;height:1920px" in rendered
