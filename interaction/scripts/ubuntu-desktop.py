#!/usr/bin/env python3
"""Open the local interaction window and register its Ubuntu desktop entry."""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
MARKER = "# Installed by Mona Interaction.\n"
APP_ID = "mona-interaction.desktop"
WINDOW_CLASS = "MonaInteraction"
LEGACY_AUTOSTART = """[Desktop Entry]
Type=Application
Name=Mona Interaction
Exec=xdg-open http://127.0.0.1:17880/
Terminal=false"""


def desktop_quote(value: str) -> str:
    if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("启动路径包含无效字符。")
    value = value.replace("\\", "\\\\\\\\")
    for char in ('"', "`", "$"):
        value = value.replace(char, "\\\\" + char)
    return '"' + value.replace("%", "%%") + '"'


def user_directory(variable: str, default: Path, home: Path) -> Path:
    value = Path(os.environ.get(variable, str(default))).expanduser()
    if not value.is_absolute():
        raise ValueError("用户配置目录必须是绝对路径。")
    value = value.resolve()
    if not value.is_relative_to(home):
        raise ValueError("用户配置目录超出用户目录。")
    return value


def desktop_entry(port: int) -> str:
    script = PROJECT / "scripts/ubuntu-desktop.py"
    icon = PROJECT / "mona_interaction/web/mona-original.png"
    if not script.is_file() or not icon.is_file():
        raise ValueError("Mona 桌面资源未准备好。")
    icon_value = str(icon)
    if any(ord(char) < 32 or ord(char) == 127 for char in icon_value):
        raise ValueError("图标路径包含无效字符。")
    return (
        MARKER + "[Desktop Entry]\nType=Application\nName=Mona\n"
        + f"Exec=/usr/bin/python3 {desktop_quote(str(script))} open --port {port}\n"
        + f"Icon={icon_value.replace(chr(92), chr(92) * 2)}\nStartupWMClass={WINDOW_CLASS}\n"
        + "Terminal=false\nCategories=Utility;\nX-GNOME-Autostart-enabled=true\n"
    )


def install_desktop(port: int) -> None:
    home = Path.home().resolve(strict=True)
    data = user_directory("XDG_DATA_HOME", home / ".local/share", home)
    config = user_directory("XDG_CONFIG_HOME", home / ".config", home)
    contents = desktop_entry(port)
    targets = [data / "applications" / APP_ID, config / "autostart" / APP_ID]
    for target in targets:
        if not target.parent.resolve().is_relative_to(home) or target.is_symlink():
            raise ValueError("桌面入口超出用户目录。")
        if target.exists():
            existing = target.read_text(encoding="utf-8")
            if not existing.startswith(MARKER) and not (target == targets[1] and existing.strip() == LEGACY_AUTOSTART):
                raise ValueError("已有同名桌面入口，已保留原文件。")
    for target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()


def notify(message: str) -> None:
    if shutil.which("zenity"):
        subprocess.Popen(["zenity", "--error", "--title=Mona", "--text", message])
    elif shutil.which("notify-send"):
        subprocess.run(["notify-send", "Mona", message], check=False)
    else:
        print(message, file=sys.stderr)


def activate_window(pid: int) -> bool:
    """Activate the existing X11 window that belongs to this browser process."""
    if not os.environ.get("DISPLAY") or not shutil.which("xprop"):
        return False
    listing = subprocess.run(["xprop", "-root", "_NET_CLIENT_LIST"], capture_output=True, text=True, timeout=3, check=False)
    windows = re.findall(r"0x[0-9a-fA-F]+", listing.stdout.partition("#")[2])
    for window in windows:
        props = subprocess.run(["xprop", "-id", window, "_NET_WM_PID"], capture_output=True, text=True, timeout=3, check=False)
        match = re.search(r"=\s*(\d+)", props.stdout)
        if not match or int(match.group(1)) != pid:
            continue
        libname = ctypes.util.find_library("X11")
        if not libname:
            return False
        x11 = ctypes.CDLL(libname)
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x11.XInternAtom.restype = ctypes.c_ulong
        x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
        x11.XFlush.argtypes = [ctypes.c_void_p]
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

        class ClientMessage(ctypes.Structure):
            _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                        ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),
                        ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]

        class XEvent(ctypes.Union):
            _fields_ = [("client", ClientMessage), ("pad", ctypes.c_long * 24)]

        display = x11.XOpenDisplay(None)
        if not display:
            return False
        try:
            root = x11.XDefaultRootWindow(display)
            atom = x11.XInternAtom(display, b"_NET_ACTIVE_WINDOW", 0)
            event = XEvent(client=ClientMessage(33, 0, 1, display, int(window, 16), atom, 32,
                                                (ctypes.c_long * 5)(1, 0, 0, 0, 0)))
            sent = x11.XSendEvent(display, root, 0, (1 << 19) | (1 << 20), ctypes.byref(event))
            x11.XFlush(display)
            return bool(sent)
        finally:
            x11.XCloseDisplay(display)
    return False


def wait_for_office(port: int) -> None:
    result = subprocess.run(["systemctl", "--user", "start", "mona-interaction.service"],
                            capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError("Mona 暂时无法启动，请检查应用服务。")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            with opener.open(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                value = json.load(response)
            if value.get("status") == "ok" and value.get("module") == "mona-interaction" and value.get("mode") == "mona":
                return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.25)
    raise RuntimeError("Mona 暂时无法打开，请检查应用服务。")


def existing_browser(profile: Path, proc: Path = Path("/proc")) -> int | None:
    """Find a surviving browser after the launcher process was interrupted."""
    profile_arg = os.fsencode(f"--user-data-dir={profile}")
    class_arg = os.fsencode(f"--class={WINDOW_CLASS}")
    for entry in proc.iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            args = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if profile_arg in args and class_arg in args and not any(arg.startswith(b"--type=") for arg in args):
            return int(entry.name)
    return None


def open_desktop(port: int) -> None:
    import fcntl

    home = Path.home().resolve(strict=True)
    profile = (home / ".local/share/mona-interaction/browser").resolve()
    if not profile.is_relative_to(home):
        raise ValueError("浏览器资料目录超出用户目录。")
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = profile / "mona-window.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "r+", encoding="ascii") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            for _ in range(10):
                lock.seek(0)
                pid = lock.read().strip()
                if pid.isdigit() and activate_window(int(pid)):
                    return
                time.sleep(0.3)
            notify("Mona 已在运行，请从任务栏切换到已有窗口。")
            return
        lock.seek(0)
        lock.truncate()
        lock.flush()
        existing = existing_browser(profile)
        if existing:
            if not activate_window(existing):
                notify("Mona 已在运行，请从任务栏切换到已有窗口。")
            return
        browser = shutil.which("google-chrome-stable") or shutil.which("google-chrome") or shutil.which("microsoft-edge-stable")
        if not browser:
            raise RuntimeError("无法打开 Mona，请先安装受支持的浏览器。")
        wait_for_office(port)
        process = subprocess.Popen([browser, f"--user-data-dir={profile}", f"--class={WINDOW_CLASS}",
                                    "--disable-background-mode", "--no-first-run", "--no-default-browser-check",
                                    f"--app=http://127.0.0.1:{port}/"], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        lock.seek(0)
        lock.truncate()
        lock.write(str(process.pid))
        lock.flush()
        if process.wait():
            raise RuntimeError("Mona 窗口未能打开，请稍后再试。")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mona Ubuntu 桌面入口")
    parser.add_argument("action", choices=("install", "open"))
    parser.add_argument("--port", type=int, default=17880)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间。")
    try:
        if args.action == "install":
            install_desktop(args.port)
        else:
            open_desktop(args.port)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        if args.action == "open":
            notify(str(exc) if isinstance(exc, RuntimeError) else "Mona 暂时无法打开，请稍后再试。")
        else:
            print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
