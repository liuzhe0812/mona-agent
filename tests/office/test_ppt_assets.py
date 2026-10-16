from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import struct
from pathlib import Path
from typing import Any

import pytest
from PIL import Image, PngImagePlugin

from mona.office import ppt_assets

ROOT = Path(__file__).resolve().parents[2]
PACK_DASHI_MEDIA = ROOT / "webui" / "office-editor" / "scripts" / "pack-dashi-media.py"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _png_chunks(data: bytes) -> dict[str, bytes]:
    chunks: dict[str, bytes] = {}
    position = 8
    while position + 12 <= len(data):
        length = struct.unpack(">I", data[position : position + 4])[0]
        name = data[position + 4 : position + 8]
        chunks[name.decode("ascii")] = data[position + 8 : position + 8 + length]
        position += length + 12
        if name == b"IEND":
            break
    return chunks


def _fixture_asset(
    root: Path,
    *,
    relative_file: str = "fixture.webp",
    icc_profile: bytes | None = None,
    chromaticity: bool = False,
) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    rgba = Image.new("RGBA", (3, 2), (31, 82, 147, 173))
    options: dict[str, Any] = {
        "format": "WEBP",
        "lossless": True,
        "quality": 100,
        "method": 6,
        "exact": True,
    }
    if icc_profile:
        options["icc_profile"] = icc_profile
    buffer = io.BytesIO()
    rgba.save(buffer, **options)
    webp_bytes = buffer.getvalue()

    color_chunks = {}
    if chromaticity:
        color_chunks["cHRM"] = struct.pack(">8I", 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000).hex()
    icc_record = {
        "sha256": _sha256(icc_profile) if icc_profile else None,
        "byteLength": len(icc_profile) if icc_profile else 0,
    }
    entry = {
        "id": "fixture-asset",
        "file": relative_file,
        "format": "image/webp",
        "width": 3,
        "height": 2,
        "sourceRelativePath": "fixture.png",
        "sourceSha256": "0" * 64,
        "compressedSha256": _sha256(webp_bytes),
        "rgbaSha256": _sha256(rgba.tobytes()),
        "alphaSha256": _sha256(rgba.getchannel("A").tobytes()),
        "pngColorChunks": color_chunks,
        "iccProfile": icc_record,
    }
    (root / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "assets": [entry]}), encoding="utf-8"
    )
    if not relative_file.startswith("../"):
        asset_path = root / relative_file
        asset_path.parent.mkdir(parents=True, exist_ok=True)
        asset_path.write_bytes(webp_bytes)
    return entry


def _load_media_packer() -> Any:
    spec = importlib.util.spec_from_file_location("pack_dashi_media", PACK_DASHI_MEDIA)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fixture_png(
    *, size: tuple[int, int], color: tuple[int, int, int, int], icc_profile: bytes
) -> bytes:
    png_info = PngImagePlugin.PngInfo()
    chromaticity = struct.pack(
        ">8I", 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000
    )
    png_info.add(b"cHRM", chromaticity)
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(
        buffer, format="PNG", pnginfo=png_info, icc_profile=icc_profile
    )
    return buffer.getvalue()


def test_dashi_media_packer_derives_lossless_assets_and_preserves_native_parts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    packer = _load_media_packer()
    project_root = tmp_path / "project"
    asset_root = project_root / "mona" / "skills" / "mona-pptx" / "assets" / "dashi"
    asset_root.mkdir(parents=True)
    monkeypatch.setattr(packer, "MONA_ROOT", project_root)
    monkeypatch.setattr(packer, "ASSET_ROOT", asset_root)

    dashi_manifest = json.loads((ppt_assets.ASSET_ROOT / "manifest.json").read_text(encoding="utf-8"))
    dashi_manifest["assets"] = dashi_manifest["assets"][:12]
    dashi_manifest["assetCount"] = 12
    reused_asset = dashi_manifest["assets"][0]
    reused_webp = (ppt_assets.ASSET_ROOT / reused_asset["file"]).read_bytes()
    (asset_root / reused_asset["file"]).write_bytes(reused_webp)
    original_png = ppt_assets.get_ppt_asset_png_bytes(reused_asset["id"])
    with Image.open(io.BytesIO(original_png)) as original_image:
        original_image.load()
        reencoded_buffer = io.BytesIO()
        original_image.save(reencoded_buffer, format="PNG", compress_level=0)
    reencoded_png = reencoded_buffer.getvalue()
    assert _sha256(reencoded_png) != reused_asset["sourceSha256"]
    (asset_root / "manifest.json").write_text(
        json.dumps(dashi_manifest), encoding="utf-8"
    )
    icc_profile = b"synthetic-icc-profile-for-container-roundtrip"
    slide_png = _fixture_png(size=(128, 96), color=(35, 86, 143, 171), icc_profile=icc_profile)
    chain_png = _fixture_png(size=(128, 96), color=(171, 86, 35, 203), icc_profile=icc_profile)
    screenshot_png = _fixture_png(size=(16, 9), color=(220, 221, 222, 255), icc_profile=b"")
    svg_bytes = b"<svg xmlns='http://www.w3.org/2000/svg'/>"
    media = {
        _sha256(slide_png): {"base64": base64.b64encode(slide_png).decode("ascii")},
        _sha256(chain_png): {"base64": base64.b64encode(chain_png).decode("ascii")},
        _sha256(reencoded_png): {"base64": base64.b64encode(reencoded_png).decode("ascii")},
        _sha256(screenshot_png): {"base64": base64.b64encode(screenshot_png).decode("ascii")},
        _sha256(svg_bytes): {"base64": base64.b64encode(svg_bytes).decode("ascii")},
    }
    picture = (
        '<p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/>'
        '<a:ext cx="1600" cy="900"/></a:xfrm></p:spPr>'
        '<p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>'
    )
    document = {
        "schemaVersion": 1,
        "pages": [
            {
                "id": "theme01_page001",
                "assetIds": ["stale"],
                "bundle": {
                    "slideXml": "<p:sld><p:sp><a:t>Editable</a:t></p:sp></p:sld>",
                    "rels": [],
                    "slideSize": {"cx": 1600, "cy": 900},
                    "partRefs": {
                        "ppt/media/background.png": _sha256(slide_png),
                        "ppt/media/reencoded-3d.png": _sha256(reencoded_png),
                        "ppt/media/shape.svg": _sha256(svg_bytes),
                    },
                    "chain": {"partRefs": {"ppt/media/layout.png": _sha256(chain_png)}},
                },
            },
            {
                "id": "theme01_page002",
                "assetIds": ["stale"],
                "bundle": {
                    "slideXml": f"<p:sld>{picture}</p:sld>",
                    "rels": [
                        {
                            "id": "rId1",
                            "type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                            "target": "/ppt/media/full.png",
                        }
                    ],
                    "slideSize": {"cx": 1600, "cy": 900},
                    "partRefs": {"ppt/media/full.png": _sha256(screenshot_png)},
                },
            },
        ],
        "parts": media,
    }
    (asset_root / "templates.json").write_text(
        json.dumps(document), encoding="utf-8"
    )

    result = packer.pack_dashi_media()

    packed = json.loads((asset_root / "templates.json").read_text(encoding="utf-8"))
    packed_manifest = json.loads((asset_root / "manifest.json").read_text(encoding="utf-8"))
    registry = json.loads((asset_root / "template-assets.json").read_text(encoding="utf-8"))
    assert packed_manifest["assets"][:12] == dashi_manifest["assets"]
    assert result["convertedParts"] == 3
    assert result["newAssets"] == 2
    assert result["reusedExistingParts"] == 1
    assert result["newWebpBytes"] < len(slide_png) + len(chain_png)
    assert result["retainedSvgBase64Bytes"] == len(base64.b64encode(svg_bytes))
    assert result["retainedOtherBase64Bytes"] == len(base64.b64encode(screenshot_png))
    assert result["retainedBase64Bytes"] == (
        result["retainedSvgBase64Bytes"] + result["retainedOtherBase64Bytes"]
    )
    assert packed["pages"][0]["assetIds"] == sorted(
        [
            f"derived-{_sha256(slide_png)[:16]}",
            f"derived-{_sha256(chain_png)[:16]}",
            reused_asset["id"],
        ]
    )
    assert packed["pages"][1]["assetIds"] == []
    assert packed["parts"][_sha256(slide_png)] == {
        "assetId": f"derived-{_sha256(slide_png)[:16]}"
    }
    assert packed["parts"][_sha256(chain_png)]["assetId"] == f"derived-{_sha256(chain_png)[:16]}"
    assert packed["parts"][_sha256(reencoded_png)] == {"assetId": reused_asset["id"]}
    assert packed["parts"][_sha256(screenshot_png)]["base64"]
    assert packed["parts"][_sha256(svg_bytes)]["base64"]
    assert registry["pages"] == [
        {"id": page["id"], "assetIds": page["assetIds"]} for page in packed["pages"]
    ]

    derived = next(
        entry
        for entry in packed_manifest["assets"]
        if entry["id"] == f"derived-{_sha256(slide_png)[:16]}"
    )
    assert derived["assetRole"] == "required-template-background-or-decoration"
    assert "not a whole-slide screenshot" in derived["description"]
    monkeypatch.setattr(ppt_assets, "ASSET_ROOT", asset_root)
    restored = ppt_assets.get_ppt_asset_png_bytes(derived["id"])
    with Image.open(io.BytesIO(slide_png)) as source_image:
        source_image.load()
        source_rgba = source_image.convert("RGBA").tobytes()
    with Image.open(io.BytesIO(restored)) as image:
        image.load()
        assert image.size == (128, 96)
        assert image.convert("RGBA").tobytes() == source_rgba
        assert image.info["icc_profile"] == icc_profile
    assert _png_chunks(restored)["cHRM"] == _png_chunks(slide_png)["cHRM"]


def test_registered_dashi_assets_restore_exact_png_pixels_and_metadata() -> None:
    manifest = json.loads((ppt_assets.ASSET_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["assets"]) == manifest["assetCount"] >= 12

    for asset in manifest["assets"]:
        png_bytes = ppt_assets.get_ppt_asset_png_bytes(asset["id"])
        with Image.open(io.BytesIO(png_bytes)) as image:
            image.load()
            assert image.format == "PNG"
            assert image.size == (asset["width"], asset["height"])
            rgba = image.convert("RGBA")
            assert _sha256(rgba.tobytes()) == asset["rgbaSha256"]
            assert _sha256(rgba.getchannel("A").tobytes()) == asset["alphaSha256"]

            icc = image.info.get("icc_profile")
            icc_record = asset["iccProfile"]
            assert (len(icc) if icc else 0) == icc_record["byteLength"]
            assert (_sha256(icc) if icc else None) == icc_record["sha256"]

        chunks = _png_chunks(png_bytes)
        for name, payload in asset["pngColorChunks"].items():
            assert chunks[name.encode("ascii").decode("ascii")] == bytes.fromhex(payload)

    first_id = manifest["assets"][0]["id"]
    data_url = ppt_assets.get_ppt_asset_data_url(first_id)
    assert data_url.startswith("data:image/png;base64,")
    assert base64.b64decode(data_url.partition(",")[2]) == ppt_assets.get_ppt_asset_png_bytes(first_id)


def test_icc_and_chromaticity_metadata_are_reembedded_in_png(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    icc_profile = b"synthetic-icc-profile-for-container-roundtrip"
    _fixture_asset(tmp_path, icc_profile=icc_profile, chromaticity=True)
    monkeypatch.setattr(ppt_assets, "ASSET_ROOT", tmp_path)

    png_bytes = ppt_assets.get_ppt_asset_png_bytes("fixture-asset")
    with Image.open(io.BytesIO(png_bytes)) as image:
        image.load()
        assert image.info["icc_profile"] == icc_profile
    chunks = _png_chunks(png_bytes)
    assert chunks["cHRM"] == struct.pack(
        ">8I", 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000
    )


def test_unregistered_asset_id_is_rejected() -> None:
    with pytest.raises(ppt_assets.PptAssetError, match="Unknown PPT asset ID"):
        ppt_assets.get_ppt_asset_png_bytes("../../outside.png")


def test_manifest_path_escape_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    asset_root = tmp_path / "assets"
    entry = _fixture_asset(asset_root, relative_file="../outside.webp")
    outside = tmp_path / "outside.webp"
    rgba = Image.new("RGBA", (3, 2), (31, 82, 147, 173))
    buffer = io.BytesIO()
    rgba.save(buffer, format="WEBP", lossless=True, quality=100, method=6, exact=True)
    outside.write_bytes(buffer.getvalue())
    entry["compressedSha256"] = _sha256(outside.read_bytes())
    (asset_root / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "assets": [entry]}), encoding="utf-8"
    )
    monkeypatch.setattr(ppt_assets, "ASSET_ROOT", asset_root)

    with pytest.raises(ppt_assets.PptAssetError, match="outside its fixed resource root"):
        ppt_assets.get_ppt_asset_png_bytes("fixture-asset")


def test_corrupted_webp_sha_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    asset_root = tmp_path / "assets"
    entry = _fixture_asset(asset_root)
    asset_path = asset_root / entry["file"]
    corrupted = bytearray(asset_path.read_bytes())
    corrupted[-1] ^= 1
    asset_path.write_bytes(corrupted)
    monkeypatch.setattr(ppt_assets, "ASSET_ROOT", asset_root)

    with pytest.raises(ppt_assets.PptAssetError, match="checksum does not match"):
        ppt_assets.get_ppt_asset_png_bytes("fixture-asset")
