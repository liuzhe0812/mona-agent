from __future__ import annotations

import base64
import hashlib
import json
import re
from io import BytesIO
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote, urlsplit

import pytest
from PIL import Image

from mona.agent.partners import MONA_AGENT_ID
from mona.agent.skills import SkillsLoader

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = REPO_ROOT / "mona" / "skills"
DESIGN_ROOT = SKILLS_ROOT / "mona-design"
PARTNER_AGENT_ID = "com.example.mona-design-test"
STYLE_GROUPS = {"app": 12, "east": 12, "info": 20, "ppt": 20, "web": 20}
OVERVIEW_IMAGES = {
    "sheet-app.jpg",
    "sheet-east.jpg",
    "sheet-info.jpg",
    "sheet-ppt.jpg",
    "sheet-web.jpg",
}


def _make_loader(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, agent_id: str) -> SkillsLoader:
    from mona.config import paths as config_paths

    monkeypatch.setattr(
        config_paths,
        "get_agent_skills_dir",
        lambda current_agent: tmp_path / "private-skills" / current_agent,
    )
    return SkillsLoader(
        workspace=tmp_path,
        builtin_skills_dir=SKILLS_ROOT,
        agent_id=agent_id,
    )


def _decode_jpeg(path: Path) -> None:
    with Image.open(path) as image:
        assert image.format == "JPEG"
        image.load()
        assert image.width > 0
        assert image.height > 0


def test_provenance_hashes_retained_files_and_records_music_exclusions() -> None:
    manifest = json.loads((DESIGN_ROOT / "provenance.json").read_text(encoding="utf-8"))
    rows = manifest["files"]

    assert manifest["upstream"]["repository"] == "https://github.com/alchaincyf/huashu-design"
    assert manifest["integration"] == {"name": "mona-design", "displayName": "Mona Design"}
    assert manifest["upstream"]["commit"] == "4fc7bfdbd5ec3fa2d43ce7a6433de60976a5e4b1"
    assert manifest["upstreamFileCount"] == 389
    assert manifest["upstream"]["license"] == "MIT"
    assert "raw Git blob bytes" in manifest["hashBasis"]
    assert len(rows) == manifest["sourceFileCount"]
    assert sum(row["sizeBytes"] for row in rows) == manifest["sourceBytes"]
    assert len({row["originalPath"] for row in rows}) == len(rows)
    assert len({row["targetPath"] for row in rows}) == len(rows)
    excluded = [row for row in manifest["excluded"] if "originalPath" in row]
    assert len(rows) + len(excluded) == manifest["upstreamFileCount"]
    removed = {row["targetPath"] for row in excluded}
    assert removed == {
        "assets/bgm-ad.mp3", "assets/bgm-educational-alt.mp3", "assets/bgm-educational.mp3",
        "assets/bgm-tech.mp3", "assets/bgm-tutorial-alt.mp3", "assets/bgm-tutorial.mp3",
        "scripts/add-music.sh",
    }
    for row in excluded:
        assert not (DESIGN_ROOT / row["targetPath"]).exists()
        assert row["reason"]

    for row in rows:
        assert re.fullmatch(r"[0-9a-f]{64}", row["sha256"])
        target = (DESIGN_ROOT / row["targetPath"]).resolve(strict=True)
        assert target.is_relative_to(DESIGN_ROOT.resolve())
        data = target.read_bytes()
        assert len(data) == row["sizeBytes"], row["originalPath"]
        assert hashlib.sha256(data).hexdigest() == row["sha256"], row["originalPath"]
        if "upstreamSha256" in row:
            assert row["adaptationReason"]
            assert re.fullmatch(r"[0-9a-f]{64}", row["upstreamSha256"])

    upstream_skill = next(row for row in rows if row["originalPath"] == "SKILL.md")
    assert upstream_skill["targetPath"] == "references/upstream-skill.md"
    assert (DESIGN_ROOT / "SKILL.md").is_file()
    assert not (SKILLS_ROOT / "huashu-design").exists()


def test_all_84_style_sources_and_five_overviews_are_present_and_decodable() -> None:
    specimen_root = DESIGN_ROOT / "assets" / "style-specimens"
    seen_styles: set[tuple[str, str]] = set()

    for group, expected_count in STYLE_GROUPS.items():
        group_root = specimen_root / group
        html_files = {path.stem: path for path in group_root.glob("*.html")}
        jpg_files = {path.stem: path for path in group_root.glob("*.jpg")}
        assert len(html_files) == expected_count
        assert html_files.keys() == jpg_files.keys()
        for stem, html_path in html_files.items():
            source = html_path.read_text(encoding="utf-8")
            assert "<html" in source.lower(), html_path
            _decode_jpeg(jpg_files[stem])
            seen_styles.add((group, stem))

    assert len(seen_styles) == 84
    overview_files = {path.name for path in specimen_root.glob("sheet-*.jpg")}
    assert overview_files == OVERVIEW_IMAGES
    for name in overview_files:
        _decode_jpeg(specimen_root / name)


def test_mona_entry_links_and_ppt_design_references_resolve_locally() -> None:
    skill_text = (DESIGN_ROOT / "SKILL.md").read_text(encoding="utf-8")
    link_pattern = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
    local_links = 0
    for match in link_pattern.finditer(skill_text):
        destination = match.group(1).strip().split(maxsplit=1)[0].strip("<>")
        parsed = urlsplit(destination)
        if parsed.scheme or destination.startswith("#"):
            continue
        local_path = unquote(parsed.path)
        if not local_path:
            continue
        assert not Path(local_path).is_absolute()
        assert not PureWindowsPath(local_path).is_absolute()
        resolved = (DESIGN_ROOT / local_path).resolve(strict=True)
        assert resolved.is_relative_to(DESIGN_ROOT.resolve()), destination
        assert resolved.is_file(), destination
        local_links += 1
    assert local_links >= 10

    ppt_skill = (SKILLS_ROOT / "mona-pptx" / "SKILL.md").read_text(encoding="utf-8")
    references = re.findall(
        r'skill_reference_read\(skill="mona-design", ref_path="([^"]+)"\)',
        ppt_skill,
    )
    assert references
    for reference in references:
        target = Path(reference)
        if target.parts[0] in {"assets", "demos", "scripts"}:
            resolved = (DESIGN_ROOT / target).resolve(strict=True)
        else:
            resolved = (DESIGN_ROOT / "references" / target).resolve(strict=True)
        assert resolved.is_relative_to(DESIGN_ROOT.resolve())
        assert resolved.is_file(), reference


@pytest.mark.asyncio
async def test_skill_reference_tool_reads_design_docs_images_and_paged_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mona.agent.tools import skill_tools

    loader = _make_loader(tmp_path, monkeypatch, MONA_AGENT_ID)
    seen_agent_ids: list[str] = []

    def resolve_loader(agent_id: str) -> SkillsLoader:
        seen_agent_ids.append(agent_id)
        return loader

    monkeypatch.setattr(skill_tools, "_skills_loader", resolve_loader)
    tool = skill_tools.SkillReferenceReadTool(track_usage=False)

    native_pptx = await tool.execute(skill="mona-design", ref_path="native-pptx.md")
    assert isinstance(native_pptx, list)
    native_text = json.loads(native_pptx[0]["text"])
    assert "Office" in native_text["content"]
    assert "Mona Design → Mona 原生 PPT" in native_text["content"]
    attached = [block for block in native_pptx if block.get("type") == "image_url"]
    assert len(attached) == 2
    for block, name in zip(attached, ("sheet-ppt.jpg", "sheet-east.jpg"), strict=True):
        actual_bytes = base64.b64decode(block["image_url"]["url"].split(",", 1)[1])
        assert actual_bytes == (DESIGN_ROOT / "assets" / "style-specimens" / name).read_bytes()

    image_result = await tool.execute(
        skill="mona-design", ref_path="assets/style-specimens/sheet-ppt.jpg"
    )
    assert isinstance(image_result, list)
    image_block = next(block for block in image_result if block.get("type") == "image_url")
    header, encoded = image_block["image_url"]["url"].split(",", 1)
    assert header.startswith("data:image/jpeg;base64")
    image_bytes = base64.b64decode(encoded, validate=True)
    assert image_bytes.startswith(b"\xff\xd8\xff")
    with Image.open(BytesIO(image_bytes)) as image:
        image.load()
        assert image.width > 0 and image.height > 0

    for resource_path in (
        "assets/style-specimens/web/01-editorial-brutalism.html",
        "scripts/design_lint.py",
        "references/design-styles.md",
    ):
        source = (DESIGN_ROOT / resource_path).read_bytes().decode("utf-8-sig")
        first = json.loads(
            await tool.execute(skill="mona-design", ref_path=resource_path, offset=0, limit=128)
        )
        second = json.loads(
            await tool.execute(skill="mona-design", ref_path=resource_path, offset=128, limit=128)
        )
        assert first["content"] == source[:128]
        assert first["nextOffset"] == 128
        assert second["content"] == source[128:256]
        assert second["offset"] == 128

    default_reference = json.loads(
        await tool.execute(skill="mona-design", ref_path="design-styles.md")
    )
    reference_source = (DESIGN_ROOT / "references" / "design-styles.md").read_text(encoding="utf-8")
    assert default_reference["content"] == reference_source[:16000]
    assert default_reference["nextOffset"] == 16000

    escaped = await tool.execute(skill="mona-design", ref_path="../LICENSE")
    absolute = await tool.execute(skill="mona-design", ref_path=str((DESIGN_ROOT / "LICENSE").resolve()))
    assert isinstance(escaped, str) and escaped.startswith("Error:")
    assert isinstance(absolute, str) and absolute.startswith("Error:")
    assert seen_agent_ids and set(seen_agent_ids) == {MONA_AGENT_ID}


@pytest.mark.asyncio
async def test_partner_can_read_builtin_mona_design_without_user_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mona.agent.tools import skill_tools

    loader = _make_loader(tmp_path, monkeypatch, PARTNER_AGENT_ID)
    assert loader.get_skill_metadata("mona-design")["name"] == "mona-design"
    assert loader.resolve_skill_dir("huashu-design") is None
    assert any(
        entry["name"] == "mona-design"
        for entry in loader.list_skills(filter_unavailable=False)
    )
    assert loader.resolve_skill_dir("mona-design") == DESIGN_ROOT

    seen_agent_ids: list[str] = []

    def resolve_loader(agent_id: str) -> SkillsLoader:
        seen_agent_ids.append(agent_id)
        return loader

    monkeypatch.setattr(skill_tools, "_skills_loader", resolve_loader)
    tool = skill_tools.SkillReferenceReadTool(
        agent_id=PARTNER_AGENT_ID,
        track_usage=False,
    )
    result = await tool.execute(skill="mona-design", ref_path="native-pptx.md")
    assert isinstance(result, list)
    assert "Mona Design → Mona 原生 PPT" in json.loads(result[0]["text"])["content"]
    assert len([block for block in result if block.get("type") == "image_url"]) == 2
    assert seen_agent_ids == [PARTNER_AGENT_ID]


@pytest.mark.asyncio
async def test_three_ppt_style_previews_reach_chat_as_fetchable_images(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.agent.loop import previewable_delivered_media
    from mona.agent.tools import skill_tools
    from mona.agent.tools.context import RequestContext
    from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META, DeliverFileTool
    from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
    from mona.bus.queue import MessageBus
    from mona.channels.websocket import WebSocketChannel
    from mona.config.paths import get_agent_output_dir

    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    loader = _make_loader(tmp_path, monkeypatch, MONA_AGENT_ID)
    monkeypatch.setattr(skill_tools, "_skills_loader", lambda _agent_id: loader)
    workspace = tmp_path / "workspace"
    output = get_agent_output_dir(workspace, MONA_AGENT_ID)
    bus = MessageBus()
    pending: list[dict] = []
    delivery = DeliverFileTool(bus.publish_outbound, workspace=workspace, restrict_to_workspace=True)
    delivery._agent_id = MONA_AGENT_ID
    delivery.set_context(RequestContext(
        channel="websocket", chat_id="ppt-style-choice", session_key="websocket:ppt-style-choice",
        metadata={DELIVER_FILES_PENDING_META: pending},
    ))
    names = ["09-bento-grid.jpg", "10-dark-hairline-terminal.jpg", "16-institutional-swiss.jpg"]
    destinations = [f"风格推荐/{index}-{name}" for index, name in enumerate(names, 1)]
    token = set_current_workspace(output)
    try:
        copier = skill_tools.SkillAssetCopyTool(track_usage=False)
        for name, dest in zip(names, destinations, strict=True):
            result = await copier.execute(skill="mona-design", asset=f"style-specimens/ppt/{name}", dest=dest)
            assert not result.startswith("Error"), result
            assert (output / dest).read_bytes() == (DESIGN_ROOT / "assets/style-specimens/ppt" / name).read_bytes()
        result = await delivery.execute(paths=destinations, summary="PPT 风格推荐样张")
    finally:
        reset_current_workspace(token)
    assert result == "Prepared 3 file(s) for final delivery"
    assert [item["path"] for item in pending] == destinations
    assert all(item["artifact_ref"]["session_id"] == "websocket:ppt-style-choice" for item in pending)
    paths = previewable_delivered_media(pending)
    assert paths == [str(output / dest) for dest in destinations]

    channel = WebSocketChannel({"enabled": True}, bus)
    for path in paths:
        attachment = channel._sign_or_stage_media_path(Path(path))
        assert attachment is not None
        signature, payload = attachment["url"].removeprefix("/api/media/").split("/", 1)
        response = channel._handle_media_fetch(signature, payload)
        assert response.status_code == 200
        assert response.headers["Content-Type"] == "image/jpeg"
        assert response.body == Path(path).read_bytes()
