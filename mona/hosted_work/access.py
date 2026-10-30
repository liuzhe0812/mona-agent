"""Explicit website/listener policy, separate from user-tool network permissions."""
from ipaddress import ip_address, ip_network
from urllib.parse import urlsplit

from aiohttp import web

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError

_PRIVATE_NETWORKS = tuple(map(ip_network, ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")))
_PUBLIC_PATHS = frozenset({"/", "/healthz", "/work", "/work/", "/work/hosted-work.html", "/favicon.ico"})


def private_listener(value: str) -> str:
    try:
        address = ip_address(value)
    except ValueError as exc:
        raise ValueError("Work bind_host must name one loopback or private IP, not all interfaces") from exc
    if not address.is_loopback and not any(address in network for network in _PRIVATE_NETWORKS):
        raise ValueError("Work must bind one loopback or private interface")
    return str(address)


def website_origin(config: HostedWorkConfig) -> str:
    value = config.public_origin
    try:
        parts = urlsplit(value)
        if (not value or any(c.isspace() for c in value) or "\\" in value or not parts.hostname
                or parts.username is not None or parts.password is not None or "%" in parts.hostname
                or parts.path not in ("", "/") or parts.query or parts.fragment
                or parts.scheme not in {"https", "http"} or parts.port == 0):
            raise ValueError("invalid website origin")
        host = parts.hostname.lower()
        if parts.scheme == "http":
            if not config.allow_insecure_lan_http:
                raise ValueError("plain HTTP needs explicit trusted-LAN approval")
            address = "127.0.0.1" if host == "localhost" else private_listener(host)
            listener = private_listener(config.bind_host)
            if not ip_address(listener).is_loopback and address != listener:
                raise ValueError("HTTP website origin must match the configured private listener")
            if (parts.port or 80) != config.port:
                raise ValueError("HTTP website port must match the listener")
        authority = f"[{host}]" if ":" in host else host
        default_port = 443 if parts.scheme == "https" else 80
        if parts.port and parts.port != default_port:
            authority += f":{parts.port}"
        return f"{parts.scheme}://{authority}"
    except ValueError as exc:
        raise ValueError("Work public_origin must be HTTPS or an explicitly approved private HTTP address") from exc


def is_public_resource(request: web.Request) -> bool:
    return request.method in {"GET", "HEAD"} and (
        request.path in _PUBLIC_PATHS or request.path.startswith("/work/assets/")
    )


def check_request_host(request: web.Request, config: HostedWorkConfig, origin: str) -> None:
    authority = request.host.lower()
    listener = private_listener(config.bind_host)
    listener_authority = f"[{listener}]" if ":" in listener else listener
    if authority in {urlsplit(origin).netloc, f"{listener_authority}:{config.port}"}:
        return
    # Local probes may use an ephemeral port. A domain resolving to loopback is
    # not accepted, so an attacker cannot use DNS rebinding to invent an origin.
    try:
        local = urlsplit("http://" + authority)
        host = "127.0.0.1" if local.hostname == "localhost" else local.hostname
        if (local.username is None and local.password is None and local.path == "" and not local.query
                and not local.fragment and host and ip_address(host).is_loopback
                and request.remote and ip_address(request.remote).is_loopback):
            return
    except ValueError:
        pass
    raise WorkError("host_denied", "请通过管理员提供的在线工作区地址访问。", 403)
