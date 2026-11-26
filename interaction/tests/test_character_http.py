import json
import sys
from urllib.parse import quote, unquote, urljoin

import pytest
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

from mona_interaction import app as app_module
from mona_interaction.app import create_app
from mona_interaction.character import CharacterBundle


@pytest.fixture
def character_bundle(tmp_path):
    root = tmp_path / "素材"
    model_dir = root / "角色 壹"
    model_dir.mkdir(parents=True)
    core_dir = root / "运行 组件"
    core_dir.mkdir()
    model = {
        "Version": 3,
        "FileReferences": {"Moc": "模型.moc3", "Textures": ["纹理 01.png"]},
    }
    (model_dir / "Mona.model3.json").write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
    (model_dir / "模型.moc3").write_bytes(b"model-data")
    (model_dir / "纹理 01.png").write_bytes(b"texture-data")
    (core_dir / "core.js").write_text("core-data", encoding="utf-8")
    (model_dir / "原画.psd").write_bytes(b"private-artwork")
    (model_dir / "unrelated.json").write_text("private-json", encoding="utf-8")
    (core_dir / "other.js").write_text("private-code", encoding="utf-8")
    (tmp_path / "outside.json").write_text("outside-root", encoding="utf-8")
    manifest = {
        "version": 1,
        "asset_root": "素材",
        "model": "角色 壹/Mona.model3.json",
        "core": "运行 组件/core.js",
    }
    path = tmp_path / "character.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return CharacterBundle.from_file(path)


@pytest.mark.asyncio
async def test_unconfigured_character_has_no_assets():
    async with TestClient(TestServer(create_app())) as client:
        async with client.get("/character") as response:
            assert response.status == 200
            assert await response.json() == {"available": False}
            assert response.headers["Cache-Control"] == "no-store"
        async with client.get("/character/assets/Mona.model3.json") as response:
            assert response.status == 404


@pytest.mark.asyncio
async def test_character_urls_serve_only_the_configured_model_assets(character_bundle):
    async with TestClient(TestServer(create_app(character=character_bundle))) as client:
        async with client.get("/character") as response:
            assert response.status == 200
            config = await response.json()
            assert config["available"] is True
            assert response.headers["Cache-Control"] == "no-store"
        assert unquote(config["model_url"]) == "/character/assets/角色 壹/Mona.model3.json"
        assert unquote(config["core_url"]) == "/character/assets/运行 组件/core.js"
        async with client.get(config["model_url"]) as response:
            assert response.status == 200
            assert (await response.json())["FileReferences"]["Textures"] == ["纹理 01.png"]
        assets = {
            config["core_url"]: b"core-data",
            "/character/assets/" + quote("角色 壹/纹理 01.png", safe="/"): b"texture-data",
            "/character/assets/" + quote("角色 壹/模型.moc3", safe="/"): b"model-data",
        }
        for url, content in assets.items():
            async with client.get(url) as response:
                assert response.status == 200
                assert await response.read() == content


@pytest.mark.asyncio
async def test_character_route_blocks_unreferenced_files_traversal_and_foreign_origins(character_bundle):
    async with TestClient(TestServer(create_app(character=character_bundle))) as client:
        for name in ("角色 壹/原画.psd", "角色 壹/unrelated.json", "运行 组件/other.js"):
            async with client.get("/character/assets/" + quote(name, safe="/")) as response:
                assert response.status == 404
        for url in (
            "/character/assets/%2E%2E%2Foutside.json",
            "/character/assets/%2E%2E%2F%2E%2E%2Foutside.json",
            "/character/assets/%5C..%5Coutside.json",
            "/character/assets/%252E%252E%252Foutside.json",
        ):
            async with client.get(URL(url, encoded=True)) as response:
                assert response.status in (403, 404)
        async with client.get("/character", headers={"Origin": "https://foreign.example"}) as response:
            assert response.status == 403
        async with client.get("/character", headers={"Host": "foreign.example"}) as response:
            assert response.status == 403


def make_work_bundle(tmp_path):
    root = tmp_path / "work-assets"
    model_dir = root / "工作 角色"
    model_dir.mkdir(parents=True)
    (root / "core.js").write_text("core-data", encoding="utf-8")
    (model_dir / "work.model3.json").write_text(json.dumps({
        "Version": 3, "FileReferences": {"Moc": "work.moc3", "Textures": ["work.png"]},
    }), encoding="utf-8")
    (model_dir / "work.moc3").write_bytes(b"work-model")
    (model_dir / "work.png").write_bytes(b"work-texture")
    path = tmp_path / "work-character.json"
    path.write_text(json.dumps({"version": 1, "asset_root": "work-assets",
                                "model": "工作 角色/work.model3.json", "core": "core.js"},
                               ensure_ascii=False), encoding="utf-8")
    return CharacterBundle.from_file(path)


@pytest.mark.asyncio
async def test_office_characters_are_independent_allowlisted_bundles(character_bundle, tmp_path):
    work = make_work_bundle(tmp_path)
    app = create_app(character=character_bundle, office_characters={"rest": character_bundle, "work": work})
    async with TestClient(TestServer(app)) as client:
        async with client.get("/office-character/rest") as response:
            rest = await response.json()
            assert response.headers["Cache-Control"] == "no-store"
            assert unquote(rest["model_url"]) == "/office-character/rest/assets/角色 壹/Mona.model3.json"
            assert unquote(rest["core_url"]) == "/office-character/rest/assets/运行 组件/core.js"
        async with client.get(urljoin(rest["model_url"], quote("纹理 01.png"))) as response:
            assert response.status == 200
            assert await response.read() == b"texture-data"
        async with client.get("/office-character/work") as response:
            config = await response.json()
            assert unquote(config["model_url"]) == "/office-character/work/assets/工作 角色/work.model3.json"
        async with client.get(urljoin(config["model_url"], "work.moc3")) as response:
            assert response.status == 200
            assert await response.read() == b"work-model"
        async with client.get("/office-character/work/assets/" + quote("角色 壹/模型.moc3", safe="/")) as response:
            assert response.status == 404
        async with client.get("/office-character/dialogue") as response:
            assert response.status == 200
            assert await response.json() == {"available": False}
        for url in ("/office-character/unknown", "/office-character/unknown/assets/core.js",
                    "/office-character/rest/assets/%2E%2E%2Foutside.json"):
            async with client.get(URL(url, encoded=True)) as response:
                assert response.status in (403, 404)
        async with client.get("/character") as response:
            assert unquote((await response.json())["model_url"]) == "/character/assets/角色 壹/Mona.model3.json"


def test_office_characters_reject_different_core_contents(character_bundle, tmp_path):
    work = make_work_bundle(tmp_path)
    (work.root / "core.js").write_text("different-core", encoding="utf-8")
    with pytest.raises(ValueError, match="相同版本"):
        create_app(office_characters={"rest": character_bundle, "work": work})
    with pytest.raises(ValueError, match="角色配置"):
        create_app(office_characters={"unknown": character_bundle})


def test_office_character_cli_loads_only_supplied_manifests(character_bundle, tmp_path, monkeypatch):
    from mona_interaction import __main__ as entry

    make_work_bundle(tmp_path)
    web_root = tmp_path / "web"
    (web_root / "vendor").mkdir(parents=True)
    (web_root / "vendor" / "cubism-runtime.js").write_text("renderer", encoding="utf-8")
    monkeypatch.setattr(entry, "WEB_ROOT", web_root)
    monkeypatch.setattr(sys, "argv", ["mona_interaction", "serve", "--character-file",
                    str(tmp_path / "character.json"), "--rest-character-file", str(tmp_path / "character.json"),
                    "--work-character-file", str(tmp_path / "work-character.json")])
    invoked = []
    monkeypatch.setattr(entry.web, "run_app", lambda app, **kwargs: invoked.append(app))
    entry.main()
    assert invoked[0][app_module.CHARACTER].model_name == character_bundle.model_name
    assert set(invoked[0][app_module.OFFICE_CHARACTERS]) == {"rest", "work"}


@pytest.mark.asyncio
async def test_vendor_shader_route_is_strictly_allowlisted(tmp_path, monkeypatch):
    web_root = tmp_path / "web"
    shaders = web_root / "vendor" / "shaders"
    shaders.mkdir(parents=True)
    for name in app_module.VENDOR_SHADER_FILES:
        (shaders / name).write_text(name, encoding="utf-8")
    (shaders / "unrelated.frag").write_text("private", encoding="utf-8")
    monkeypatch.setattr(app_module, "WEB_ROOT", web_root.resolve())
    async with TestClient(TestServer(create_app())) as client:
        for name in app_module.VENDOR_SHADER_FILES:
            async with client.get("/vendor/shaders/" + name) as response:
                assert response.status == 200
                assert await response.text() == name
        for url in ("/vendor/shaders/unrelated.frag", "/vendor/shaders/%2E%2E%2Funrelated.frag",
                    "/vendor/shaders/%5C..%5Cunrelated.frag"):
            async with client.get(URL(url, encoded=True)) as response:
                assert response.status in (403, 404)


@pytest.mark.asyncio
async def test_vendor_route_only_serves_allowlisted_files(tmp_path, monkeypatch):
    root = tmp_path / "web"
    vendor = root / "vendor"
    vendor.mkdir(parents=True)
    allowed = ("cubism-runtime.js", "cubism-runtime.js.LEGAL.txt", "CubismFramework-LICENSE.md")
    for name in (*allowed, "unrelated.js", "server.py"):
        (vendor / name).write_text(name, encoding="utf-8")
    monkeypatch.setattr(app_module, "WEB_ROOT", root.resolve())
    async with TestClient(TestServer(create_app())) as client:
        for name in allowed:
            async with client.get("/vendor/" + name) as response:
                assert response.status == 200
                assert await response.text() == name
        for name in ("unrelated.js", "server.py", "__init__.py"):
            async with client.get("/vendor/" + name) as response:
                assert response.status == 404
        async with client.get(URL("/vendor/%2E%2E%2Fserver.py", encoded=True)) as response:
            assert response.status in (403, 404)
