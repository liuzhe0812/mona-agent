import ast
import hashlib
import json
import subprocess
import sys
import textwrap
import tomllib
import types
import zipfile
from importlib.metadata import Distribution
from pathlib import Path

import pytest

_ALLOWED_SCRIPTS = {
    "mona/skills/mona-pptx/scripts/extract_source_images.py",
    "mona/skills/pdf/scripts/helpers/convert.py",
    "mona/skills/mona-motion/scripts/render.py",
    "mona/skills/mona-motion/scripts/nested/storyboard.py",
}
_EXCLUDED_SCRIPTS = {
    "mona/skills/pdf/scripts/tests/test_helper.py",
    "mona/skills/pdf/scripts/test/fixture.py",
    "mona/skills/pdf/scripts/__pycache__/cached.py",
    "mona/skills/mona-motion/scripts/node_modules/pkg/ignored.py",
    "mona/skills/mona-motion/scripts/.git/ignored.py",
}
_ORDINARY_MODULE = "mona/ordinary_module.py"
_WEB_DIST_FILES = {
    "mona/web/dist/index.html",
    "mona/web/dist/assets/chunk.js",
}
_OFFICE_ROOT = "src-tauri/resources/office-editor"
_FFMPEG_LICENSE_ROOT = "mona/runtime/licenses/ffmpeg-6.1.1"
_NATIVE_CATALOG = "mona/runtime/native-tools.json"


def test_desktop_package_does_not_publish_global_cli() -> None:
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]

    assert "scripts" not in project


def test_wheel_includes_macos_media_license_resources() -> None:
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    assert f"{_FFMPEG_LICENSE_ROOT}/**" in project["tool"]["hatch"]["build"]["include"]
    assert _NATIVE_CATALOG in project["tool"]["hatch"]["build"]["include"]
    assert (root / _NATIVE_CATALOG).is_file()
    assert all((root / _FFMPEG_LICENSE_ROOT / name).is_file() for name in (
        "LICENSE.md", "COPYING.GPLv2", "sources.md",
    ))


def test_scientific_libraries_stay_outside_gateway_base() -> None:
    from packaging.requirements import Requirement

    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert not {"numpy", "matplotlib", "scipy", "pandas"} & {
        Requirement(item).name.lower() for item in project["dependencies"]
    }
    for path in (root / "mona-gateway.spec", root / "src-tauri" / "mona-gateway.spec"):
        excluded: set[str] = set()
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "excludes" for target in node.targets):
                excluded.update(ast.literal_eval(node.value))
            elif isinstance(node, ast.keyword) and node.arg == "excludes" and isinstance(node.value, ast.List):
                excluded.update(ast.literal_eval(node.value))
        assert {"numpy", "matplotlib", "scipy", "pandas"} <= excluded


def test_document_pdf_and_sdk_paths_work_without_numpy(tmp_path: Path) -> None:
    script = textwrap.dedent("""
        import asyncio, base64, importlib.abc, json, struct, sys
        from pathlib import Path

        class NoNumpy(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname == 'numpy' or fullname.startswith('numpy.'):
                    raise ModuleNotFoundError('NumPy excluded from Gateway', name=fullname)

        sys.meta_path.insert(0, NoNumpy())
        root = Path(sys.argv[1])
        from docx import Document
        from openpyxl import Workbook
        from pptx import Presentation
        from mona.agent.tools.document import _parse_docx, _parse_xlsx, _parse_pptx

        doc = Document(); doc.add_paragraph('document content'); doc.save(root / 'sample.docx')
        assert 'document content' in _parse_docx(root / 'sample.docx')
        book = Workbook(); book.active.append(['value', 42]); book.save(root / 'sample.xlsx')
        assert '42' in _parse_xlsx(root / 'sample.xlsx')
        deck = Presentation(); slide = deck.slides.add_slide(deck.slide_layouts[0])
        slide.shapes.title.text = 'slide content'; deck.save(root / 'sample.pptx')
        assert 'slide content' in _parse_pptx(root / 'sample.pptx')

        import pymupdf, pdfplumber, pypdfium2, tiktoken
        from mona.agent.tools.pdf import PdfTool
        with pymupdf.open() as pdf:
            page = pdf.new_page(); page.insert_text((72, 72), 'PDF content'); pdf.save(root / 'sample.pdf')
        result = json.loads(asyncio.run(PdfTool(workspace=root).execute(
            action='render', path='sample.pdf', pages=[1], output='page.png')))
        assert result['ok'] and (root / 'page.png').is_file()
        with pdfplumber.open(root / 'sample.pdf') as pdf:
            assert 'PDF content' in pdf.pages[0].extract_text()
        with pypdfium2.PdfDocument(root / 'sample.pdf') as pdf:
            bitmap = pdf[0].render(); bitmap.to_pil().save(root / 'pdfium.png'); bitmap.close()
        encoding = tiktoken.Encoding(name='local-test', pat_str='.',
            mergeable_ranks={bytes([value]): value for value in range(256)}, special_tokens={})
        assert encoding.encode('report')

        import httpx
        from openai import OpenAI
        encoded = base64.b64encode(struct.pack('<ff', 1.0, 2.0)).decode()
        def response(request):
            return httpx.Response(200, json={
                'object': 'list', 'data': [{'object': 'embedding', 'index': 0, 'embedding': encoded}],
                'model': 'local-test', 'usage': {'prompt_tokens': 1, 'total_tokens': 1}})
        with OpenAI(api_key='local-test', http_client=httpx.Client(transport=httpx.MockTransport(response))) as client:
            assert client.embeddings.create(model='local-test', input='report').data[0].embedding == [1.0, 2.0]
    """)
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-c", script, str(tmp_path)],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_default_tts_dependency_and_gateway_specs_include_edge_tts() -> None:
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))

    assert "edge-tts==7.3.1" in project["project"]["dependencies"]

    for spec_path in (root / "mona-gateway.spec", root / "src-tauri" / "mona-gateway.spec"):
        tree = ast.parse(spec_path.read_text(encoding="utf-8"))
        package_hooks = {
            (node.func.id, node.args[0].value)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"collect_submodules", "collect_data_files", "copy_metadata"}
            and node.args
            and isinstance(node.args[0], ast.Constant)
        }

        assert ("collect_submodules", "edge_tts") in package_hooks
        assert ("collect_data_files", "edge_tts") in package_hooks
        assert ("copy_metadata", "edge-tts") in package_hooks


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
    _write_fixture_file(root, "mona/development/sandbox_node/component.json")
    _write_fixture_file(root, "mona/skills/mona-motion/runtime/mona-player.js")
    _write_fixture_file(root, "mona/skills/mona-design/provenance.json")
    _write_fixture_file(root, _NATIVE_CATALOG)
    for name in ("LICENSE.md", "COPYING.GPLv2", "sources.md"):
        _write_fixture_file(root, f"{_FFMPEG_LICENSE_ROOT}/{name}")
    if include_office:
        _write_fixture_file(root, f"{_OFFICE_ROOT}/manifest.json")
    runtime = root / "src-tauri/resources/runtime-base"
    runtime.mkdir(parents=True)
    components = []
    manifests = [
        {"id": "python-base", "version": "3.13.15", "kind": "python-runtime",
         "entrypoints": {"python": "python/python.exe"}, "dependencies": []},
        {"id": "node-base", "version": "22.23.2", "kind": "node-runtime",
         "entrypoints": {"node": "node/node.exe"}, "dependencies": []},
        {"id": "python-common", "version": "1.0.0", "kind": "python-pack",
         "entrypoints": {}, "dependencies": ["python-base@3.13.15"],
         "pythonRequirements": "requirements.lock", "pythonWheelhouse": "wheels",
         "healthImports": ["defusedxml", "lxml.etree", "PIL", "pymupdf", "websockets"]},
    ]
    for manifest in manifests:
        manifest["schemaVersion"] = 1
        archive = runtime / f"{manifest['id']}-{manifest['version']}.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("runtime-manifest.json", json.dumps(manifest))
            for entry in manifest["entrypoints"].values():
                bundle.writestr(entry, "fixture")
            if manifest["id"] == "python-common":
                bundle.writestr("requirements.lock", "fixture")
                bundle.writestr("wheels/fixture.whl", "fixture")
        data = archive.read_bytes()
        components.append({"archive": archive.name, "size": len(data),
                           "sha256": hashlib.sha256(data).hexdigest(), "manifest": manifest})
    (runtime / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "platform": "win32", "architecture": "x64",
                    "components": components}), encoding="utf-8"
    )


def _run_root_spec(monkeypatch, tmp_path):
    captured: dict[str, object] = {}

    from mona.runtime import bundled

    load_bundled_runtime = bundled.load_bundled_runtime
    monkeypatch.setattr(
        bundled, "load_bundled_runtime",
        lambda root: load_bundled_runtime(root, current_platform="win32", current_architecture="x64"),
    )

    def collect_all(package: str):
        if package == "mona":
            return (
                [
                    (_ORDINARY_MODULE, "mona"),
                    ("mona/web/dist/index.html", "mona/web/dist"),
                    ("mona/web/dist/assets/chunk.js", "mona/web/dist/assets"),
                    ("mona/skills/pdf/tests/fixture.txt", "mona/skills/pdf/tests"),
                    ("stale/native-tools.json", "mona/runtime"),
                    ("stale/LICENSE.md", "mona/runtime/licenses/ffmpeg-6.1.1"),
                ],
                [],
                ["mona.feature", "mona.tests.test_feature", "freetype.__pyinstaller.hook_freetype"],
            )
        return [], [], []

    hooks = types.ModuleType("PyInstaller.utils.hooks")
    hooks.collect_all = collect_all
    hooks.collect_submodules = lambda package: []
    hooks.collect_data_files = lambda package: []
    hooks.copy_metadata = lambda package, **kwargs: []
    sdk_policy = types.ModuleType("mona.development.executors.sdk_policy")
    sdk_policy.SDK_MODULES = {}
    sdk_policy.SDK_PACKAGES = {}
    sdk_policy.sdk_version = lambda executor: ""
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
    monkeypatch.setitem(sys.modules, "mona.development.executors.sdk_policy", sdk_policy)

    spec_globals = {
        "Analysis": StubAnalysis,
        "PYZ": stub_object,
        "EXE": stub_object,
        "COLLECT": collect_artifacts,
        "workpath": str(tmp_path / "work"),
        "SPECPATH": str(Path(__file__).resolve().parents[1]),
    }

    monkeypatch.chdir(tmp_path)
    spec_path = Path(__file__).resolve().parents[1] / "mona-gateway.spec"
    exec(compile(spec_path.read_text(encoding="utf-8"), str(spec_path), "exec"), spec_globals)
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
    assert "stale/native-tools.json" not in source_paths
    assert "stale/LICENSE.md" not in source_paths

    office_entries = {
        (_relative_source(source, tmp_path), str(destination).replace("\\", "/"))
        for source, destination in datas
    }
    assert (_OFFICE_ROOT, "desktop-resources/office-editor") in office_entries
    assert ("src-tauri/resources/runtime-base", "desktop-resources/runtime-base") in office_entries
    assert (_FFMPEG_LICENSE_ROOT, _FFMPEG_LICENSE_ROOT) in office_entries
    assert (_NATIVE_CATALOG, "mona/runtime") in office_entries


def test_root_gateway_spec_requires_office_resources(monkeypatch, tmp_path) -> None:
    _prepare_fixture(tmp_path, include_office=False)

    with pytest.raises(FileNotFoundError, match="office-editor"):
        _run_root_spec(monkeypatch, tmp_path)


def test_root_gateway_spec_requires_media_licenses(monkeypatch, tmp_path) -> None:
    _prepare_fixture(tmp_path, include_office=True)
    (tmp_path / _FFMPEG_LICENSE_ROOT / "COPYING.GPLv2").unlink()

    with pytest.raises(FileNotFoundError, match="FFmpeg license"):
        _run_root_spec(monkeypatch, tmp_path)


def test_root_gateway_spec_rejects_corrupt_bundled_runtime(monkeypatch, tmp_path) -> None:
    _prepare_fixture(tmp_path, include_office=True)
    archive = tmp_path / "src-tauri/resources/runtime-base/python-base-3.13.15.zip"
    archive.write_bytes(archive.read_bytes() + b"corrupt")

    with pytest.raises(RuntimeError, match="Bundled runtime resources are missing or invalid"):
        _run_root_spec(monkeypatch, tmp_path)


def test_alternate_gateway_spec_collects_every_skill_resource(monkeypatch, tmp_path) -> None:
    _prepare_fixture(tmp_path, include_office=True)
    resources = {
        "mona/skills/mona-docx/SKILL.md",
        "mona/skills/mona-xlsx/SKILL.md",
        "mona/skills/mona-pptx/SKILL.md",
        "mona/skills/mona-motion/pyproject.toml",
        "mona/skills/mona-visualizer/assets/widget.js",
    }
    excluded = {
        "mona/skills/pdf/tests/fixture.txt",
        "mona/skills/mona-motion/node_modules/pkg/data.js",
        "mona/skills/mona-design/ai-image-comparison/data.txt",
    }
    for resource in resources | excluded:
        _write_fixture_file(tmp_path, resource)

    def collect_data_files(package: str):
        if package != "mona":
            return []
        return [(str(tmp_path / item), str(Path(item).parent).replace("\\", "/"))
                for item in resources | excluded]

    hooks = types.ModuleType("PyInstaller.utils.hooks")
    hooks.collect_all = lambda package: ([], [], [])
    hooks.collect_submodules = lambda package: []
    hooks.collect_data_files = collect_data_files
    hooks.copy_metadata = lambda package, **kwargs: []
    pyinstaller = types.ModuleType("PyInstaller")
    pyinstaller.__path__ = []
    utils = types.ModuleType("PyInstaller.utils")
    utils.__path__ = []
    pyinstaller.utils = utils
    utils.hooks = hooks
    monkeypatch.setitem(sys.modules, "PyInstaller", pyinstaller)
    monkeypatch.setitem(sys.modules, "PyInstaller.utils", utils)
    monkeypatch.setitem(sys.modules, "PyInstaller.utils.hooks", hooks)

    # The spec only needs this package's resource directory, not its SDK imports.
    lark = types.ModuleType("lark_oapi")
    lark.__file__ = str(tmp_path / "lark_oapi" / "__init__.py")
    monkeypatch.setitem(sys.modules, "lark_oapi", lark)

    captured: dict[str, object] = {}

    class StubAnalysis:
        def __init__(self, *args, **kwargs):
            captured["datas"] = list(kwargs["datas"])
            self.pure = []
            self.scripts = []
            self.binaries = []
            self.datas = []
            self.zipped_data = []
            self.zipfiles = []

    def stub_object(*args, **kwargs):
        return object()

    spec_globals = {
        "Analysis": StubAnalysis,
        "PYZ": stub_object,
        "EXE": stub_object,
        "COLLECT": stub_object,
        "workpath": str(tmp_path / "work"),
        "SPECPATH": str(tmp_path / "src-tauri"),
    }
    monkeypatch.chdir(tmp_path)
    spec_path = Path(__file__).resolve().parents[1] / "src-tauri" / "mona-gateway.spec"
    exec(compile(spec_path.read_text(encoding="utf-8"), str(spec_path), "exec"), spec_globals)

    data = captured["datas"]
    sources = {str(source).replace("\\", "/") for source, _ in data}
    assert {str(tmp_path / item).replace("\\", "/") for item in resources} <= sources
    assert {str(tmp_path / item).replace("\\", "/") for item in excluded}.isdisjoint(sources)
    assert any(destination == "desktop-resources/runtime-base" for _, destination in data)
    assert any(destination == _FFMPEG_LICENSE_ROOT for _, destination in data)
    assert any(
        str(destination).replace("\\", "/") == "mona/runtime"
        and _relative_source(source, tmp_path) == _NATIVE_CATALOG
        for source, destination in data
    )
