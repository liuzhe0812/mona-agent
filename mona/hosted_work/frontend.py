"""Own static release surface: no Gateway, desktop API or other website business routes."""
from pathlib import Path

from aiohttp import web

from mona.config.schema import HostedWorkConfig

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; "
       "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


def register_frontend(app: web.Application, config: HostedWorkConfig) -> None:
    if not config.frontend_dir:
        return
    root = Path(config.frontend_dir)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("online frontend must be an explicit release directory")
    root = root.resolve(strict=True)
    entry = root / "hosted-work.html"
    assets = root / "assets"
    if (not entry.is_file() or entry.is_symlink() or not assets.is_dir() or assets.is_symlink()
            or any(path.is_symlink() for path in assets.rglob("*"))):
        raise ValueError("invalid static Work release")

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
    app.router.add_static("/work/assets/", assets, show_index=False, follow_symlinks=False)
