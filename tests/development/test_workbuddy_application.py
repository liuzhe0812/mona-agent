from __future__ import annotations

import json
import os
import plistlib
from pathlib import Path

import pytest

from mona.development.executors import workbuddy_application as application


class _RegistryKey:
    def __init__(
        self,
        subkeys: tuple[str, ...] = (),
        values: dict[str, str] | None = None,
        entries: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self.subkeys = subkeys
        self.values = values or {}
        self.entries = entries or {}

    def __enter__(self) -> _RegistryKey:
        return self

    def __exit__(self, *_exc_info: object) -> None:
        return None


class _Registry:
    HKEY_CURRENT_USER = "HKCU"
    HKEY_LOCAL_MACHINE = "HKLM"
    KEY_READ = 1
    KEY_WOW64_32KEY = 2
    KEY_WOW64_64KEY = 4

    def __init__(self, entries: dict[tuple[str, int], dict[str, dict[str, str]]]) -> None:
        self.entries = entries
        self.queries: list[str] = []
        self.OpenKey = self.open_key
        self.EnumKey = self.enum_key
        self.QueryValueEx = self.query_value_ex

    def open_key(self, root: object, path: str, _reserved: int = 0, access: int = 0) -> _RegistryKey:
        if path == r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall":
            view = access & (self.KEY_WOW64_32KEY | self.KEY_WOW64_64KEY)
            entries = self.entries.get((str(root), view))
            if entries is None:
                raise FileNotFoundError(path)
            return _RegistryKey(tuple(entries), entries=entries)
        values = root.entries.get(path) if isinstance(root, _RegistryKey) else None
        if values is None:
            raise FileNotFoundError(path)
        return _RegistryKey(values=values)

    def enum_key(self, key: _RegistryKey, index: int) -> str:
        try:
            return key.subkeys[index]
        except IndexError as exc:
            raise OSError(259, "No more registry items") from exc

    def query_value_ex(self, key: _RegistryKey, name: str) -> tuple[str, int]:
        self.queries.append(name)
        if name == "UninstallString":
            raise AssertionError("UninstallString must never be read")
        if name not in key.values:
            raise FileNotFoundError(name)
        return key.values[name], 1


def _registry_with_entry(*, display_name: str, values: dict[str, str], view: int = 4) -> _Registry:
    return _Registry({("HKLM", view): {"workbuddy-entry": {"DisplayName": display_name, **values}}})


def _create_workbuddy_app(app_root: Path, *, run_as_node: int = 1) -> tuple[Path, Path, Path]:
    executable = app_root / "WorkBuddy.exe"
    executable.parent.mkdir(parents=True, exist_ok=True)
    sentinel = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
    executable.write_bytes(b"MZ" + sentinel + bytes((1, 1, ord(str(run_as_node)))))

    package = app_root / "resources" / "app.asar.unpacked" / "cli"
    entry = package / "bin" / "codebuddy"
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    (package / "dist").mkdir()
    (package / "dist" / "codebuddy.js").write_text("// fixture\n", encoding="utf-8")
    package_json = package / "package.json"
    package_json.write_text(json.dumps({
        "name": "@genie/agent-cli",
        "bin": {"codebuddy": "./bin/codebuddy"},
    }), encoding="utf-8")
    return executable, entry, package_json


@pytest.mark.skipif(os.name != "nt", reason="the registry-backed detector uses Windows paths")
def test_windows_detects_workbuddy_from_registry_metadata_and_existing_app_file(tmp_path: Path) -> None:
    install_dir = tmp_path / "WorkBuddy"
    install_dir.mkdir()
    (install_dir / "WorkBuddy.exe").write_text("fixture", encoding="utf-8")
    registry = _registry_with_entry(
        display_name="WorkBuddy",
        values={"InstallLocation": str(install_dir), "UninstallString": "must not be inspected"},
    )

    assert application._locate_windows_workbuddy(registry) == ((install_dir / "WorkBuddy.exe").resolve(), False)
    assert "UninstallString" not in registry.queries


def test_codebuddy_cli_alone_is_not_detected_as_workbuddy_desktop_app(tmp_path: Path) -> None:
    cli_dir = tmp_path / "codebuddy-cli"
    cli_dir.mkdir()
    (cli_dir / "codebuddy.exe").write_text("CLI fixture", encoding="utf-8")
    registry = _Registry({})

    assert application._locate_windows_workbuddy(registry) == (None, False)


def test_unregistered_custom_install_is_detected_from_start_menu_shortcut(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = tmp_path / "custom apps" / "WorkBuddy" / "WorkBuddy.exe"
    executable.parent.mkdir(parents=True)
    executable.write_text("desktop application fixture", encoding="utf-8")
    monkeypatch.setattr(application, "_windows_shortcut_targets", lambda: [executable])

    assert application._locate_windows_desktop_app(_Registry({})) == (executable.resolve(), False)
    executable.unlink()
    assert application._locate_windows_desktop_app(_Registry({})) == (None, False)


def test_shortcut_to_managed_cli_does_not_count_as_desktop_application(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = tmp_path / "codebuddy-headless.exe"
    executable.write_text("CLI fixture", encoding="utf-8")
    monkeypatch.setattr(application, "_windows_shortcut_targets", lambda: [executable])

    assert application._locate_windows_desktop_app(_Registry({})) == (None, False)


def test_unavailable_shortcut_lookup_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(application, "_windows_shortcut_targets", lambda: None)

    assert application._locate_windows_desktop_app(_Registry({})) == (None, True)


@pytest.mark.skipif(os.name != "nt", reason="the registry-backed detector uses Windows paths")
def test_workbuddy_cli_display_icon_is_not_a_desktop_app(tmp_path: Path) -> None:
    executable = tmp_path / "CodeBuddy" / "codebuddy.exe"
    executable.parent.mkdir()
    executable.write_text("CLI fixture", encoding="utf-8")
    registry = _registry_with_entry(
        display_name="WorkBuddy CLI",
        values={"DisplayIcon": str(executable)},
    )

    assert application._locate_windows_workbuddy(registry) == (None, False)


@pytest.mark.skipif(os.name != "nt", reason="the registry-backed detector uses Windows paths")
def test_windows_display_icon_must_point_to_an_existing_application_file(tmp_path: Path) -> None:
    executable = tmp_path / "WorkBuddy Application" / "WorkBuddy.exe"
    executable.parent.mkdir()
    executable.write_text("fixture", encoding="utf-8")
    registry = _registry_with_entry(
        display_name="WorkBuddy",
        values={"DisplayIcon": f'"{executable}",0'},
    )

    assert application._locate_windows_workbuddy(registry) == (executable.resolve(), False)
    executable.unlink()
    assert application._locate_windows_workbuddy(registry) == (None, False)


def test_windows_permission_error_is_unknown_not_not_installed() -> None:
    class DeniedRegistry(_Registry):
        def open_key(self, root: object, path: str, _reserved: int = 0, access: int = 0) -> _RegistryKey:
            if path == r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall":
                raise PermissionError("access denied")
            return super().OpenKey(root, path, _reserved, access)

    assert application._locate_windows_workbuddy(DeniedRegistry({})) == (None, True)


def test_macos_requires_workbuddy_bundle_name_and_declared_executable(tmp_path: Path) -> None:
    app = tmp_path / "WorkBuddy.app"
    contents = app / "Contents"
    executable = contents / "MacOS" / "WorkBuddy"
    executable.parent.mkdir(parents=True)
    executable.write_text("fixture", encoding="utf-8")
    info = {"CFBundleDisplayName": "WorkBuddy", "CFBundleExecutable": "WorkBuddy"}
    with (contents / "Info.plist").open("wb") as output:
        plistlib.dump(info, output)

    assert application._locate_macos_workbuddy((tmp_path,)) == (executable.resolve(), False)

    executable.unlink()
    assert application._locate_macos_workbuddy((tmp_path,)) == (None, False)


def test_unsupported_platform_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(application.sys, "platform", "linux")

    assert application.detect_workbuddy_desktop_app() is None


def test_using_managed_uses_resolved_path_containment(tmp_path: Path) -> None:
    component_root = tmp_path / "components" / "codebuddy-cli"
    managed = component_root / "bin" / "codebuddy.exe"
    managed.parent.mkdir(parents=True)
    managed.write_text("managed", encoding="utf-8")
    external = tmp_path / "system" / "codebuddy.exe"
    external.parent.mkdir()
    external.write_text("system", encoding="utf-8")

    assert application.is_managed_executable(str(managed), component_root)
    assert not application.is_managed_executable(str(external), component_root)
    assert not application.is_managed_executable(None, component_root)


def test_discover_workbuddy_cli_returns_the_verified_bundled_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable, entry, _package_json = _create_workbuddy_app(tmp_path / "WorkBuddy")
    monkeypatch.setattr(application, "locate_workbuddy_desktop_app", lambda: (executable, False))

    assert application.discover_workbuddy_cli() == entry.resolve()


@pytest.mark.parametrize("invalid_part", ["package_name", "entry", "run_as_node"])
def test_discover_workbuddy_cli_rejects_invalid_or_unlaunchable_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, invalid_part: str,
) -> None:
    executable, entry, package_json = _create_workbuddy_app(tmp_path / "WorkBuddy")
    if invalid_part == "package_name":
        metadata = json.loads(package_json.read_text(encoding="utf-8"))
        metadata["name"] = "@example/unrelated-cli"
        package_json.write_text(json.dumps(metadata), encoding="utf-8")
    elif invalid_part == "entry":
        entry.unlink()
    else:
        sentinel = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
        executable.write_bytes(b"MZ" + sentinel + bytes((1, 1, ord("0"))))
    monkeypatch.setattr(application, "locate_workbuddy_desktop_app", lambda: (executable, False))

    assert application.discover_workbuddy_cli() is None


def test_discover_workbuddy_cli_rejects_bundle_symlink_escape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_root = tmp_path / "WorkBuddy"
    executable, entry, _package_json = _create_workbuddy_app(app_root)
    outside = tmp_path / "external-codebuddy"
    outside.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    entry.unlink()
    try:
        entry.symlink_to(outside)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")
    monkeypatch.setattr(application, "locate_workbuddy_desktop_app", lambda: (executable, False))

    assert application.discover_workbuddy_cli() is None


def test_desktop_sdk_transport_uses_node_launcher_and_verified_entry(
    tmp_path: Path,
) -> None:
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from mona.development.executors.codebuddy_transport import desktop_transport

    app_executable, entry, _package_json = _create_workbuddy_app(tmp_path / "WorkBuddy")
    options = sdk.CodeBuddyAgentOptions(
        codebuddy_code_path=str(entry),
        setting_sources=[],
        extra_args={"strict-mcp-config": None, "settings": "{}"},
    )
    transport = desktop_transport(str(entry), options=options)

    assert transport._get_cli_path() == str(app_executable)
    args = transport._build_args()
    assert args[0] == str(entry)
    assert args[args.index("--setting-sources") + 1] == "none"
    assert "--strict-mcp-config" in args


def test_desktop_sdk_auth_transport_restores_factory_after_exception(
    tmp_path: Path,
) -> None:
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk import auth

    from mona.development.executors.codebuddy_transport import desktop_auth_transport

    app_executable, entry, _package_json = _create_workbuddy_app(tmp_path / "WorkBuddy")
    original = auth.SubprocessTransport
    options = sdk.CodeBuddyAgentOptions(
        codebuddy_code_path=str(entry),
        setting_sources=[],
        extra_args={"strict-mcp-config": None, "settings": "{}"},
    )

    with pytest.raises(RuntimeError, match="test cleanup"):
        with desktop_auth_transport(str(entry)):
            transport = auth.SubprocessTransport(options=options)
            assert transport._get_cli_path() == str(app_executable)
            assert transport._build_args()[0] == str(entry)
            raise RuntimeError("test cleanup")

    assert auth.SubprocessTransport is original


@pytest.mark.asyncio
@pytest.mark.parametrize("account,authentication", [({}, "required"), ({"invalid": True}, "unknown")])
async def test_desktop_cli_catalog_uses_app_runtime_and_handles_omitted_user_info(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, account: dict, authentication: str,
) -> None:
    from mona.development.contracts import ExecutorId
    from mona.development.executors.codebuddy_catalog import inspect_codebuddy_catalog
    from mona.development.executors.rpc import JsonRpcProcess
    from mona.development.executors.sdk_policy import prepare_sdk_profile

    app, entry, _metadata = _create_workbuddy_app(tmp_path / "WorkBuddy")
    project = tmp_path / "project"
    project.mkdir()
    profile = prepare_sdk_profile(ExecutorId.CODEBUDDY, entry, tmp_path / "native-home", project)
    methods = []
    class Connection:
        closed = False

        async def request(self, method, _params):
            methods.append(method)
            return {"protocolVersion": 1} if method == "initialize" else account

        async def close(self):
            self.closed = True
    connection = Connection()

    async def spawn(command, **kwargs):
        assert command[:3] == (str(app), str(entry), "--acp")
        assert kwargs["env"]["ELECTRON_RUN_AS_NODE"] == "1"
        assert kwargs["env"]["HOME"] == str(tmp_path / "native-home")
        assert command[command.index("--tools") + 1] == ""
        assert command[command.index("--setting-sources") + 1] == ""
        return connection
    monkeypatch.setattr(JsonRpcProcess, "spawn", spawn)

    result = await inspect_codebuddy_catalog(profile)

    assert result.protocol_verified and result.authentication == authentication
    assert methods == ["initialize", "_codebuddy.ai/getUserInfo"]
    assert connection.closed
