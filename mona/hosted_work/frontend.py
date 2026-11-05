"""Own static release surface: no Gateway, desktop API or other website business routes."""
import os
import re
import stat
from pathlib import Path

from aiohttp import web

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import PUBLIC_STATIC_DIRS

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; "
       "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
WIDGET_CHANNEL = "MONA_HOSTED_WIDGET_CHANNEL_PLACEHOLDER"
WIDGET_CSP = "sandbox allow-scripts; frame-ancestors 'self'"
WIDGET_LIMIT = 2 * 1024 * 1024


def _is_link(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return (stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)))


def _validate_static_directory(directory: Path) -> None:
    def fail(error):
        raise error

    for current, directories, files in os.walk(directory, followlinks=False, onerror=fail):
        for name in directories + files:
            path = Path(current) / name
            if (_is_link(path) or not path.resolve(strict=True).is_relative_to(directory)
                    or not (path.is_dir() or path.is_file())):
                raise ValueError("invalid static Work release")


def register_frontend(app: web.Application, config: HostedWorkConfig) -> None:
    if not config.frontend_dir:
        return
    root = Path(config.frontend_dir)
    if not root.is_absolute() or _is_link(root) or not root.is_dir():
        raise ValueError("online frontend must be an explicit release directory")
    root = root.resolve(strict=True)
    entry = root / "hosted-work.html"
    if not entry.is_file() or _is_link(entry):
        raise ValueError("invalid static Work release")
    admin_entry = root / "hosted-admin.html"
    if _is_link(admin_entry) or (admin_entry.exists() and not admin_entry.is_file()):
        raise ValueError("invalid static Work release")
    widget_path = root / "widget-frame.html"
    if _is_link(widget_path):
        raise ValueError("invalid static Work release")
    widget_template = None
    if widget_path.exists():
        if (not widget_path.is_file() or not stat.S_ISREG(widget_path.stat().st_mode)
                or not widget_path.resolve(strict=True).is_relative_to(root)):
            raise ValueError("invalid static Work release")
        with widget_path.open("rb") as source:
            data = source.read(WIDGET_LIMIT + 1)
        try:
            widget_template = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("invalid static Work release") from exc
        if len(data) > WIDGET_LIMIT or widget_template.count(WIDGET_CHANNEL) != 1:
            raise ValueError("invalid static Work release")
    static_directories = []
    for name in PUBLIC_STATIC_DIRS:
        directory = root / name
        if _is_link(directory) or (directory.exists() and not directory.is_dir()):
            raise ValueError("invalid static Work release")
        if not directory.exists():
            if name == "assets":
                raise ValueError("invalid static Work release")
            continue
        _validate_static_directory(directory)
        static_directories.append((name, directory))

    async def index(request):
        return web.FileResponse(entry, headers={"Cache-Control": "no-store", "Content-Security-Policy": CSP,
                                               "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"})

    async def home(request):
        raise web.HTTPFound("/work/")

    async def admin(request):
        return web.FileResponse(admin_entry, headers={"Cache-Control": "no-store", "Content-Security-Policy": CSP,
                                                     "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"})

    async def favicon(request):
        return web.Response(status=204, headers={"Cache-Control": "public, max-age=86400"})

    async def widget_frame(request):
        headers = {"Cache-Control": "no-store", "Content-Security-Policy": WIDGET_CSP,
                   "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}
        channels = request.query.getall("channel", [])
        if len(request.query) != 1 or len(channels) != 1 or not re.fullmatch(r"[0-9a-f]{48}", channels[0]):
            return web.Response(status=400, headers=headers)
        return web.Response(text=widget_template.replace(WIDGET_CHANNEL, channels[0]),
                            content_type="text/html", headers=headers)

    app.router.add_get("/", home)
    app.router.add_get("/favicon.ico", favicon)
    app.router.add_get("/work", index)
    app.router.add_get("/work/", index)
    app.router.add_get("/work/hosted-work.html", index)
    if admin_entry.is_file():
        app.router.add_get("/work/admin", admin)
        app.router.add_get("/work/admin/", admin)
        app.router.add_get("/work/hosted-admin.html", admin)
    if widget_template is not None:
        app.router.add_get("/work/widget-frame.html", widget_frame)
    for name, directory in static_directories:
        app.router.add_static(f"/work/{name}/", directory, show_index=False, follow_symlinks=False)
