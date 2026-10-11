import os
import subprocess

import pytest
from test_workbench_api import AUTH, setup_client


@pytest.mark.asyncio
async def test_project_media_returns_raw_image_with_restricted_headers(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    image = b"\x89PNG\r\n\x1a\nmedia bytes"
    (root / "preview.PNG").write_bytes(image)
    url = f"/api/development/projects/{project.id}/media"
    try:
        response = await client.get(url, params={"path": "preview.PNG"}, headers=AUTH)
        assert response.status == 200
        assert await response.read() == image
        assert response.content_type == "image/png"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Cache-Control"] == "private, no-store"
        assert response.headers["Content-Security-Policy"] == "sandbox; default-src 'none'"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_project_media_rejects_path_traversal(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    outside = tmp_path / "private.png"
    outside.write_bytes(b"private media")
    url = f"/api/development/projects/{project.id}/media"
    try:
        traversal = await client.get(url, params={"path": "../private.png"}, headers=AUTH)
        assert traversal.status == 422
        assert "private media" not in await traversal.text()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_project_media_rejects_symlink_escape(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "private.png").write_bytes(b"private media")
    link = root / "linked"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        if os.name != "nt":
            await client.close()
            pytest.skip("Directory symlinks are unavailable on this host")
        junction = subprocess.run(
            ["cmd.exe", "/c", "mklink", "/J", str(link), str(outside)],
            capture_output=True, check=False,
        )
        if junction.returncode:
            await client.close()
            pytest.skip("Windows junctions are unavailable on this host")
    url = f"/api/development/projects/{project.id}/media"
    try:
        escaped_link = await client.get(url, params={"path": "linked/private.png"}, headers=AUTH)
        assert escaped_link.status == 422
        assert "private media" not in await escaped_link.text()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_project_media_rejects_unsupported_type_and_requires_auth(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    (root / "notes.txt").write_text("not a media preview", encoding="utf-8")
    url = f"/api/development/projects/{project.id}/media"
    try:
        denied = await client.get(url, params={"path": "notes.txt"})
        assert denied.status == 401
        unsupported = await client.get(url, params={"path": "notes.txt"}, headers=AUTH)
        assert unsupported.status == 422
        assert (await unsupported.json())["error"]["code"] == "unsupported_media"
    finally:
        await client.close()
