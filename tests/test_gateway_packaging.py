import runpy
import sys
import tomllib
import types
from importlib.metadata import Distribution
from pathlib import Path

import pytest

_ALLOWED_SCRIPTS = {
    "mona/skills/pdf/scripts/helpers/convert.py",
    "mona/skills/mona-video/scripts/render.py",
    "mona/skills/mona-video/scripts/nested/storyboard.py",
}
_EXCLUDED_SCRIPTS = {
    "mona/skills/pdf/scripts/tests/test_helper.py",
    "mona/skills/pdf/scripts/test/fixture.py",
    "mona/skills/pdf/scripts/__pycache__/cached.py",
    "mona/skills/mona-video/scripts/node_modules/pkg/ignored.py",
    "mona/skills/mona-video/scripts/.git/ignored.py",
}
_ORDINARY_MODULE = "mona/ordinary_module.py"
_WEB_DIST_FILES = {
    "mona/web/dist/index.html",
    "mona/web/dist/assets/chunk.js",
}
_OFFICE_ROOT = "src-tauri/resources/office-editor"


def test_desktop_package_does_not_publish_global_cli() -> None:
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert "scripts" not in project


def _write_fixture_file(root: Path, relative: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("fixture\n", encoding="utf-8")


def _relative_source(source: object, root: Path) -> str:
    path = Path(str(source))
    if not path.is_absolute():
        path = root / path
    return path.resolve().relative_to(root.resolve()).as_posix()


def _prepare_fixture(root: Path, *, include_office: bool) -> None:
    (root / "pyproject.toml").write_text('[project]\nversion = "9.8.7"\n', encoding="utf-8")
    for relative in _ALLOWED_SCRIPTS | _EXCLUDED_SCRIPTS | {_ORDINARY_MODULE} | _WEB_DIST_FILES:
        _write_fixture_file(root, relative)
    if include_office:
        _write_fixture_file(root, f"{_OFFICE_ROOT}/manifest.json")


def _run_root_spec(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    def collect_all(package: str):
        if package == "mona":
            return (
                [
                    (_ORDINARY_MODULE, "mona"),
                    ("mona/web/dist/index.html", "mona/web/dist"),
                    ("mona/web/dist/assets/chunk.js", "mona/web/dist/assets"),
                    ("mona/skills/pdf/tests/fixture.txt", "mona/skills/pdf/tests"),
                ],
                [],
                ["mona.feature", "mona.tests.test_feature", "freetype.__pyinstaller.hook_freetype"],
            )
        return [], [], []

    hooks = types.ModuleType("PyInstaller.utils.hooks")
    hooks.collect_all = collect_all
    hooks.collect_submodules = lambda package: []
    pyinstaller = types.ModuleType("PyInstaller")
    pyinstaller.__path__ = []
    utils = types.ModuleType("PyInstaller.utils")
    utils.__path__ = []
    pyinstaller.utils = utils
    utils.hooks = hooks

    class StubAnalysis:
        def __init__(self, *args, **kwargs):
            captured["datas"] = list(kwargs["datas"])
            assert "mona.feature" in kwargs["hiddenimports"]
            assert "mona.tests.test_feature" not in kwargs["hiddenimports"]
            assert "freetype.__pyinstaller.hook_freetype" not in kwargs["hiddenimports"]
            self.pure = []
            self.scripts = []
            self.binaries = []
            self.datas = [("mona_ai-0.1.0.dist-info/METADATA", "old-metadata", "DATA")]
            self.zipfiles = []

    def stub_object(*args, **kwargs):
        return object()

    def collect_artifacts(*args, **kwargs):
        metadata_entries = [entry for entry in args[2] if entry[0].endswith("/METADATA")]
        assert len(metadata_entries) == 1
        destination, source, _ = metadata_entries[0]
        assert destination == "mona_ai-9.8.7.dist-info/METADATA"
        assert Distribution.at(Path(source).parent).version == "9.8.7"
        return object()

    monkeypatch.setitem(sys.modules, "PyInstaller", pyinstaller)
    monkeypatch.setitem(sys.modules, "PyInstaller.utils", utils)
    monkeypatch.setitem(sys.modules, "PyInstaller.utils.hooks", hooks)

    spec_globals = {
        "Analysis": StubAnalysis,
        "PYZ": stub_object,
        "EXE": stub_object,
        "COLLECT": collect_artifacts,
        "workpath": str(tmp_path / "work"),
    }

    monkeypatch.chdir(tmp_path)
    spec_path = Path(__file__).resolve().parents[1] / "mona-gateway.spec"
    runpy.run_path(str(spec_path), run_name="__main__", init_globals=spec_globals)
    return captured["datas"]


def test_root_gateway_spec_collects_skill_scripts_without_building(monkeypatch, tmp_path) -> None:
    _prepare_fixture(tmp_path, include_office=True)
    datas = _run_root_spec(monkeypatch, tmp_path)

    assert isinstance(datas, list)
    source_paths = {
        _relative_source(source, tmp_path)
        for source, _destination in datas
    }

    assert _ALLOWED_SCRIPTS <= source_paths
    assert _ORDINARY_MODULE not in source_paths
    assert all(not path.startswith("mona/web/dist/") for path in source_paths)
    assert _EXCLUDED_SCRIPTS.isdisjoint(source_paths)
    assert "mona/skills/pdf/tests/fixture.txt" not in source_paths

    office_entries = {
        (_relative_source(source, tmp_path), str(destination).replace("\\", "/"))
        for source, destination in datas
    }
    assert (_OFFICE_ROOT, "desktop-resources/office-editor") in office_entries


def test_root_gateway_spec_requires_office_resources(monkeypatch, tmp_path) -> None:
    _prepare_fixture(tmp_path, include_office=False)

    with pytest.raises(FileNotFoundError, match="office-editor"):
        _run_root_spec(monkeypatch, tmp_path)
