import base64
import json
from urllib.parse import quote, unquote

import pytest
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

from mona_interaction.app import create_app
from mona_interaction.scene import SceneBundle

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
)


def save_manifest(path, manifest):
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def scene_files(tmp_path):
    root = tmp_path / "素材"
    scene_dir = root / "办公室"
    scene_dir.mkdir(parents=True)
    for name in ("背景.png", "人物.png", "未引用.png"):
        (scene_dir / name).write_bytes(PNG)
    (tmp_path / "outside.png").write_bytes(PNG)
    manifest = {
        "version": 1,
        "asset_root": "素材",
        "background": "办公室/背景.png",
        "artwork": "办公室/人物.png",
        "width": 1,
        "height": 1,
        "clock": {"x": 0.63, "y": 0.15, "diameter": 0.07},
        "window": [[0, 0], [0.3, 0], [0.3, 0.5], [0, 0.5]],
    }
    path = tmp_path / "scene.json"
    save_manifest(path, manifest)
    return root, manifest, path


def test_bundle_exposes_only_the_two_referenced_images(scene_files):
    root, manifest, path = scene_files
    bundle = SceneBundle.from_file(path)
    config = bundle.public_config()
    assert config["available"] is True
    assert unquote(config["background_url"]) == "/scene/assets/办公室/背景.png"
    assert unquote(config["artwork_url"]) == "/scene/assets/办公室/人物.png"
    assert "asset_root" not in config
    for value in config.values():
        if isinstance(value, str):
            assert str(root) not in value
            assert str(path.parent) not in value
    assert bundle.asset(manifest["background"]) == (root / manifest["background"]).resolve()
    assert bundle.asset(manifest["artwork"]) == (root / manifest["artwork"]).resolve()
    assert bundle.asset("办公室/未引用.png") is None
    assert bundle.asset("../outside.png") is None


def test_optional_night_background_is_whitelisted_and_validated(scene_files):
    root, manifest, path = scene_files
    name = "办公室/夜景.png"
    (root / name).write_bytes(PNG)
    manifest["night_background"] = name
    save_manifest(path, manifest)
    bundle = SceneBundle.from_file(path)
    assert unquote(bundle.public_config()["night_background_url"]) == "/scene/assets/" + name
    assert bundle.asset(name) == (root / name).resolve()
    (root / name).write_bytes(b"not a PNG")
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    manifest["night_background"] = "../outside.png"
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


def test_cloud_layers_are_complete_safe_and_scoped_to_sky(scene_files):
    root, manifest, path = scene_files
    for name in ("办公室/晴空.png", "办公室/云.png"):
        (root / name).write_bytes(PNG)
    manifest.update(day_sky="办公室/晴空.png", cloud_artwork="办公室/云.png",
                    cloud_regions=[[[0, 0], [0.3, 0], [0.3, 0.4]]])
    save_manifest(path, manifest)
    bundle = SceneBundle.from_file(path)
    config = bundle.public_config()
    assert unquote(config["day_sky_url"]) == "/scene/assets/办公室/晴空.png"
    assert unquote(config["cloud_artwork_url"]) == "/scene/assets/办公室/云.png"
    assert config["cloud_regions"] == manifest["cloud_regions"]
    assert bundle.asset(manifest["cloud_artwork"]) == (root / manifest["cloud_artwork"]).resolve()

    manifest["cloud_artwork"] = "../outside.png"
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    manifest["cloud_artwork"] = "办公室/云.png"
    manifest["cloud_regions"] = [[[0, 0], [1.1, 0], [0, 1]]]
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    del manifest["cloud_regions"]
    save_manifest(path, manifest)
    with pytest.raises(ValueError, match="同时配置"):
        SceneBundle.from_file(path)


def test_optional_work_artwork_is_whitelisted_and_validated(scene_files):
    root, manifest, path = scene_files
    name = "办公室/工作.png"
    (root / name).write_bytes(PNG)
    manifest["work_artwork"] = name
    save_manifest(path, manifest)
    bundle = SceneBundle.from_file(path)
    assert unquote(bundle.public_config()["work_artwork_url"]) == "/scene/assets/" + name
    assert bundle.asset(name) == (root / name).resolve()
    (root / name).write_bytes(b"not a PNG")
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    manifest["work_artwork"] = "../outside.png"
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


def test_optional_rest_artwork_uses_same_asset_boundary(scene_files):
    root, manifest, path = scene_files
    name = "办公室/休息.png"
    (root / name).write_bytes(PNG)
    manifest["rest_artwork"] = name
    save_manifest(path, manifest)
    bundle = SceneBundle.from_file(path)
    assert unquote(bundle.public_config()["rest_artwork_url"]) == "/scene/assets/" + name
    assert bundle.asset(name) == (root / name).resolve()
    manifest["rest_artwork"] = "../outside.png"
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


def test_rest_foreground_is_validated_and_published_as_a_separate_mask(scene_files):
    _, manifest, path = scene_files
    rest_mask = [[0.4, 0.7], [1, 0.7], [1, 1], [0.2, 1]]
    manifest["rest_foreground"] = rest_mask
    save_manifest(path, manifest)
    assert SceneBundle.from_file(path).public_config()["rest_foreground"] == rest_mask
    manifest["rest_foreground"] = [[0, 0], [1.1, 0], [0, 1]]
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


@pytest.mark.parametrize(("idle", "still"), [
    ("rest_idle", "rest_artwork"), ("dialogue_idle", "artwork"), ("work_idle", "work_artwork"),
])
def test_idle_artwork_requires_safe_same_size_png_and_static_fallback(scene_files, idle, still):
    root, manifest, path = scene_files
    name = "办公室/动态.png"
    (root / name).write_bytes(PNG)
    manifest[idle] = name
    manifest[still] = manifest["artwork"]
    save_manifest(path, manifest)
    bundle = SceneBundle.from_file(path)
    assert unquote(bundle.public_config()[f"{idle}_url"]) == "/scene/assets/" + name
    assert "idle_unavailable" not in bundle.public_config()
    assert bundle.asset(name) == (root / name).resolve()
    mismatch = bytearray(PNG)
    mismatch[19] = 2
    (root / name).write_bytes(mismatch)
    unusable = SceneBundle.from_file(path)
    assert f"{idle}_url" not in unusable.public_config()
    assert unusable.public_config()["idle_unavailable"] == [idle.removesuffix("_idle")]
    assert unusable.asset(name) is None
    (root / name).write_bytes(b"not a PNG")
    assert SceneBundle.from_file(path).public_config()["idle_unavailable"] == [idle.removesuffix("_idle")]
    (root / name).unlink()
    missing = SceneBundle.from_file(path).public_config()
    assert f"{idle}_url" not in missing
    assert missing["idle_unavailable"] == [idle.removesuffix("_idle")]
    assert name not in json.dumps(missing, ensure_ascii=False)
    manifest[idle] = "../outside.png"
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    del manifest[still]
    manifest[idle] = name
    save_manifest(path, manifest)
    with pytest.raises(ValueError, match="静态备用图"):
        SceneBundle.from_file(path)


@pytest.mark.parametrize("reference", ["../outside.png", "办公室/../../outside.png", "/outside.png"])
def test_manifest_rejects_paths_outside_asset_root(scene_files, reference):
    _, manifest, path = scene_files
    manifest["background"] = reference
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


def test_symlink_outside_root_is_rejected_before_and_after_loading(scene_files, tmp_path):
    root, manifest, path = scene_files
    image = root / manifest["background"]
    backup = image.with_name("原始背景.png")
    image.rename(backup)
    try:
        image.symlink_to(tmp_path / "outside.png")
    except (OSError, NotImplementedError):
        backup.rename(image)
        pytest.skip("symlinks unavailable")
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    image.unlink()
    backup.rename(image)
    bundle = SceneBundle.from_file(path)
    image.unlink()
    image.symlink_to(tmp_path / "outside.png")
    assert bundle.asset(manifest["background"]) is None


def test_scene_rejects_mismatched_canvas_and_invalid_png(scene_files):
    root, manifest, path = scene_files
    manifest["width"] = 2
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)
    manifest["width"] = 1
    save_manifest(path, manifest)
    (root / manifest["artwork"]).write_bytes(b"not a PNG")
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


@pytest.mark.parametrize("clock", [
    {"x": -0.01, "y": 0.15, "diameter": 0.07},
    {"x": True, "y": 0.15, "diameter": 0.07},
    {"x": 0.63, "y": 0.15, "diameter": 0},
    {"x": 0.63, "y": 0.15, "diameter": 0.31},
    {"x": 0.63, "y": float("nan"), "diameter": 0.07},
    {"x": 0.63, "y": 0.15},
])
def test_scene_rejects_invalid_clock(scene_files, clock):
    _, manifest, path = scene_files
    manifest["clock"] = clock
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


@pytest.mark.parametrize("window", [
    [[0, 0], [0.3, 0]],
    [[0, 0], [1.1, 0], [0, 0.5]],
    [[0, 0], [0.3, True], [0, 0.5]],
])
def test_scene_rejects_invalid_window(scene_files, window):
    _, manifest, path = scene_files
    manifest["window"] = window
    save_manifest(path, manifest)
    with pytest.raises(ValueError):
        SceneBundle.from_file(path)


@pytest.mark.asyncio
async def test_scene_endpoint_serves_only_listed_images_and_office_entry(scene_files):
    root, manifest, path = scene_files
    manifest["night_background"] = "办公室/夜景.png"
    (root / manifest["night_background"]).write_bytes(PNG)
    manifest["work_artwork"] = "办公室/工作.png"
    (root / manifest["work_artwork"]).write_bytes(PNG)
    manifest["work_idle"] = "办公室/动态.png"
    (root / manifest["work_idle"]).write_bytes(PNG)
    save_manifest(path, manifest)
    async with TestClient(TestServer(create_app(scene=SceneBundle.from_file(path)))) as client:
        async with client.get("/") as response:
            assert response.status == 200
            assert 'id="office"' in await response.text()
        async with client.get("/scene") as response:
            assert response.status == 200
            config = await response.json()
            assert response.headers["Cache-Control"] == "no-store"
        assert config["available"] is True
        assert "asset_root" not in config
        assert all(str(root) not in value for value in config.values() if isinstance(value, str))
        for name in ("background", "artwork", "work_artwork", "work_idle", "night_background"):
            async with client.get(config[f"{name}_url"]) as response:
                assert response.status == 200
                assert response.content_type == "image/png"
                assert await response.read() == PNG
        for resource in ("/office-pose.js", "/pose-state.js", "/office-voice.js", "/office-voice.css"):
            async with client.get(resource) as response:
                assert response.status == 200
        for url in (
            "/scene/assets/" + quote("办公室/未引用.png", safe="/"),
            "/scene/assets/%2E%2E%2Foutside.png",
            "/scene/assets/%252E%252E%252Foutside.png",
        ):
            async with client.get(URL(url, encoded=True)) as response:
                assert response.status in (403, 404)


@pytest.mark.asyncio
async def test_unconfigured_scene_keeps_original_entry():
    async with TestClient(TestServer(create_app())) as client:
        async with client.get("/") as response:
            assert response.status == 200
            assert 'class="terminal"' in await response.text()
        async with client.get("/scene") as response:
            assert response.status == 200
            assert await response.json() == {"available": False}
        async with client.get("/scene/assets/office.png") as response:
            assert response.status == 404
