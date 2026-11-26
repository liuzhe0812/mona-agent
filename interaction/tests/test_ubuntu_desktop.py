import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "ubuntu_desktop", Path(__file__).resolve().parents[1] / "scripts/ubuntu-desktop.py"
)
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


def test_install_is_idempotent_and_refuses_an_unrelated_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(desktop.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / ".local/share"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    app = tmp_path / ".local/share/applications" / desktop.APP_ID
    auto = tmp_path / ".config/autostart" / desktop.APP_ID
    app.parent.mkdir(parents=True)
    app.write_text("[Desktop Entry]\nName=Another application\n", encoding="utf-8")
    with pytest.raises(ValueError, match="已保留"):
        desktop.install_desktop(17880)
    assert "Another application" in app.read_text(encoding="utf-8")
    assert not auto.exists()
    app.unlink()
    desktop.install_desktop(17880)
    desktop.install_desktop(17880)
    assert app.read_text(encoding="utf-8") == auto.read_text(encoding="utf-8")
    assert "--port 17880" in app.read_text(encoding="utf-8")


def test_desktop_command_quotes_reserved_characters():
    assert desktop.desktop_quote('folder name/$literal%f') == '"folder name/\\\\$literal%%f"'
    with pytest.raises(ValueError):
        desktop.desktop_quote("line\nbreak")


def test_migrates_only_the_previous_documented_autostart(tmp_path, monkeypatch):
    monkeypatch.setattr(desktop.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / ".local/share"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    auto = tmp_path / ".config/autostart" / desktop.APP_ID
    auto.parent.mkdir(parents=True)
    auto.write_text(desktop.LEGACY_AUTOSTART + "\n", encoding="utf-8")
    desktop.install_desktop(17880)
    assert auto.read_text(encoding="utf-8").startswith(desktop.MARKER)
    auto.write_text(desktop.LEGACY_AUTOSTART.replace("xdg-open", "other-app"), encoding="utf-8")
    with pytest.raises(ValueError, match="已保留"):
        desktop.install_desktop(17880)
    assert "other-app" in auto.read_text(encoding="utf-8")


def test_find_surviving_mona_browser_ignores_other_profiles_and_children(tmp_path, monkeypatch):
    monkeypatch.setattr(desktop.os, "getuid", lambda: tmp_path.stat().st_uid, raising=False)
    profile = tmp_path / "mona profile"
    for pid, args in {
        "10": ["chrome", "--user-data-dir=/other", "--class=MonaInteraction"],
        "11": ["chrome", f"--user-data-dir={profile}", "--class=MonaInteraction", "--type=renderer"],
        "12": ["chrome", f"--user-data-dir={profile}", "--class=MonaInteraction"],
    }.items():
        directory = tmp_path / pid
        directory.mkdir()
        (directory / "cmdline").write_bytes(b"\0".join(map(desktop.os.fsencode, args)) + b"\0")
    assert desktop.existing_browser(profile, tmp_path) == 12
