import json
from urllib.parse import unquote

import pytest

from mona_interaction.character import MAX_JSON_BYTES, CharacterBundle


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def character_files(tmp_path):
    root = tmp_path / "素材"
    model_dir = root / "Mona 人形"
    texture_dir = model_dir / "texture"
    texture_dir.mkdir(parents=True)
    core_dir = root / "sdk"
    core_dir.mkdir()
    (core_dir / "core.js").write_text("", encoding="utf-8")
    (model_dir / "mona.moc3").write_bytes(b"moc")
    (texture_dir / "01.png").write_bytes(b"png")
    (model_dir / "physics.json").write_text("{}", encoding="utf-8")
    (model_dir / "pose.json").write_text("{}", encoding="utf-8")
    model = {
        "Version": 3,
        "FileReferences": {
            "Moc": "mona.moc3", "Textures": ["texture/01.png"],
            "Physics": "physics.json", "Pose": "pose.json",
            "UserData": "not-served.json",
        },
    }
    model_path = model_dir / "Mona.model3.json"
    write_json(model_path, model)
    manifest_path = tmp_path / "character.json"
    manifest = {"version": 1, "asset_root": "素材", "model": "Mona 人形/Mona.model3.json", "core": "sdk/core.js"}
    write_json(manifest_path, manifest)
    return root, model, model_path, manifest, manifest_path


def test_valid_bundle_only_exposes_registered_files(character_files):
    root, _, _, manifest, manifest_path = character_files
    manifest["bindings"] = [{"source": "headYaw", "parameter": "ParamAngleX", "scale": 30, "offset": 1}]
    write_json(manifest_path, manifest)
    (root / "unrelated.json").write_text("{}", encoding="utf-8")
    bundle = CharacterBundle.from_file(manifest_path)
    config = bundle.public_config()
    assert config["available"] is True
    assert unquote(config["model_url"]) == "/character/assets/Mona 人形/Mona.model3.json"
    assert config["core_url"] == "/character/assets/sdk/core.js"
    assert config["bindings"] == manifest["bindings"]
    assert str(root) not in json.dumps(config, ensure_ascii=False)
    for name in (
        "Mona 人形/Mona.model3.json", "sdk/core.js", "Mona 人形/mona.moc3",
        "Mona 人形/texture/01.png", "Mona 人形/physics.json", "Mona 人形/pose.json",
    ):
        assert bundle.asset(name) == (root / name).resolve()
    for name in ("unrelated.json", "Mona 人形/not-served.json", "../character.json", "sdk/other.js"):
        assert bundle.asset(name) is None
    config["bindings"][0]["scale"] = 123
    assert bundle.public_config()["bindings"][0]["scale"] == 30


@pytest.mark.parametrize("reference", [
    "../outside.png", "/outside.png", "C:/outside.png", "//host/file.png", "http://host/image.png",
    "dir//image.png", "dir\\image.png", "image.png?x=1", "image.png#x", "image%2epng", "bad\n.png", "",
])
def test_untrusted_texture_paths_are_rejected(character_files, reference):
    _, model, model_path, _, manifest_path = character_files
    model["FileReferences"]["Textures"] = [reference]
    write_json(model_path, model)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)


@pytest.mark.parametrize("edit", [
    {"version": True}, {"version": 2}, {"asset_root": []}, {"model": "../Mona.model3.json"},
    {"core": "http://example.com/core.js"}, {"bindngs": []},
])
def test_invalid_manifest_is_rejected(character_files, edit):
    _, _, _, manifest, manifest_path = character_files
    manifest.update(edit)
    write_json(manifest_path, manifest)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)


def test_invalid_model_metadata_and_json_size_are_rejected(character_files):
    _, model, model_path, _, manifest_path = character_files
    model["Version"] = True
    write_json(model_path, model)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    model["Version"] = 3
    model["FileReferences"]["Moc"] = "mona.txt"
    write_json(model_path, model)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    model["FileReferences"]["Moc"] = "mona.moc3"
    model["FileReferences"]["Textures"] = []
    write_json(model_path, model)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    model["FileReferences"]["Textures"] = ["texture/01.png"] * 17
    write_json(model_path, model)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    model_path.write_bytes(b" " * (MAX_JSON_BYTES + 1))
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    manifest_path.write_bytes(b" " * (MAX_JSON_BYTES + 1))
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)


def test_missing_and_malformed_fields_are_reported(character_files):
    _, model, model_path, _, manifest_path = character_files
    model["FileReferences"] = None
    write_json(model_path, model)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    for raw in (b"[]", b"{", b'{"version": 1}'):
        manifest_path.write_bytes(raw)
        with pytest.raises(ValueError):
            CharacterBundle.from_file(manifest_path)


@pytest.mark.parametrize("bindings", [
    {},
    [{"source": "other", "parameter": "ParamX", "scale": 1, "offset": 0}],
    [{"source": "eyeX", "parameter": "参数", "scale": 1, "offset": 0}],
    [{"source": "eyeX", "parameter": "ParamX", "scale": True, "offset": 0}],
    [{"source": "eyeX", "parameter": "ParamX", "scale": float("nan"), "offset": 0}],
    [{"source": "eyeX", "parameter": "ParamX", "scale": 361, "offset": 0}],
    [{"source": "eyeX", "parameter": "ParamX", "scale": 1}],
    [{"source": "eyeX", "parameter": "ParamX", "scale": 1, "offset": 0, "extra": 1}],
    [{"source": "eyeX", "parameter": "ParamX", "scale": 1, "offset": 0}] * 2,
    [{"source": "eyeX", "parameter": f"Param{i}", "scale": 1, "offset": 0} for i in range(33)],
])
def test_invalid_bindings_are_rejected(character_files, bindings):
    _, _, _, manifest, manifest_path = character_files
    manifest["bindings"] = bindings
    write_json(manifest_path, manifest)
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)


def test_symlink_escape_is_rejected_even_after_bundle_load(character_files, tmp_path):
    root, _, _, _, manifest_path = character_files
    source = root / "Mona 人形" / "texture" / "01.png"
    external = tmp_path / "outside.png"
    external.write_bytes(b"outside")
    backup = source.with_name("original.png")
    source.rename(backup)
    try:
        source.symlink_to(external)
    except (OSError, NotImplementedError):
        backup.rename(source)
        pytest.skip("symlinks unavailable")
    with pytest.raises(ValueError):
        CharacterBundle.from_file(manifest_path)
    source.unlink()
    backup.rename(source)
    bundle = CharacterBundle.from_file(manifest_path)
    source.unlink()
    source.symlink_to(external)
    assert bundle.asset("Mona 人形/texture/01.png") is None
