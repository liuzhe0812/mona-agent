"""Own static release surface: no Gateway, desktop API or other website business routes."""
import os
import stat
from pathlib import Path

from aiohttp import web

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import PUBLIC_STATIC_DIRS

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; "
       "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


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

    async def favicon(request):
        return web.Response(status=204, headers={"Cache-Control": "public, max-age=86400"})

    app.router.add_get("/", home)
    app.router.add_get("/favicon.ico", favicon)
    app.router.add_get("/work", index)
    app.router.add_get("/work/", index)
    app.router.add_get("/work/hosted-work.html", index)
    for name, directory in static_directories:
        app.router.add_static(f"/work/{name}/", directory, show_index=False, follow_symlinks=False)
