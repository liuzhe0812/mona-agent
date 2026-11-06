"""Origin-bound model HTTPS with validated DNS and a pinned TCP destination."""
from __future__ import annotations

import asyncio
import ipaddress
import math
import re
import socket
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from mona.hosted_work.contracts import WorkError

Resolver = Callable[[str, int], Awaitable[Sequence[tuple]]]
# IANA special-purpose blocks that Python 3.11 can still label global, plus
# transition/anycast ranges. Model endpoints use ordinary public unicast only.
# https://www.iana.org/assignments/iana-ipv4-special-registry/
# https://www.iana.org/assignments/iana-ipv6-special-registry/
_SPECIAL = tuple(map(ipaddress.ip_network, (
    "192.0.0.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.175.48.0/24",
    "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "100:0:0:1::/64", "2001::/23", "2001:db8::/32",
    "2002::/16", "2620:4f:8000::/48", "3fff::/20", "5f00::/16",
)))


def _blocked(message="模型接口仅允许公共 HTTPS 地址，不允许访问私有或特殊网络。"):
    return WorkError("invalid_model_endpoint", message, 400)


def _public(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return ("%" not in value and address.is_global and not address.is_reserved and not address.is_multicast
            and not address.is_loopback and not address.is_link_local and not address.is_unspecified
            and not any(address.version == network.version and address in network for network in _SPECIAL)
            and not (isinstance(address, ipaddress.IPv6Address)
                     and (address.ipv4_mapped or address.sixtofour or address.teredo)))


def _origin(url: httpx.URL):
    return url.scheme, url.raw_host, url.port if url.port is not None else (443 if url.scheme == "https" else 80)


@dataclass(frozen=True)
class _Endpoint:
    url: httpx.URL
    host: str
    port: int
    loopback: bool


def _endpoint(api_base: str, allow_loopback: bool) -> _Endpoint:
    if type(allow_loopback) is not bool:
        raise _blocked("模型本机线路开关无效。")
    if (not isinstance(api_base, str) or not 1 <= len(api_base) <= 4096 or "\\" in api_base
            or any(ord(char) < 33 or ord(char) == 127 for char in api_base)):
        raise _blocked("模型接口地址格式无效。")
    try:
        parsed = urlsplit(api_base)
        if (parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment or "%" in parsed.hostname
                or parsed.port == 0):
            raise ValueError
        url = httpx.URL(api_base)
        host, port = url.raw_host.decode("ascii"), url.port or (443 if url.scheme == "https" else 80)
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
            labels = host.rstrip(".").split(".")
            if (host.lower().rstrip(".") == "localhost" or host.lower().rstrip(".").endswith((".localhost", ".local"))
                    or any(not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label) for label in labels)):
                raise ValueError
        loopback = bool(allow_loopback and address is not None and host in {"127.0.0.1", "::1"})
        if url.scheme != "https" and not loopback or address is not None and not (loopback or _public(host)):
            raise ValueError
    except (ValueError, UnicodeError, httpx.InvalidURL):
        raise _blocked() from None
    return _Endpoint(url, host, port, loopback)


async def _getaddrinfo(host: str, port: int):
    return await asyncio.get_running_loop().getaddrinfo(
        host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP,
    )


async def _addresses(endpoint: _Endpoint, resolver: Resolver | None, dns_timeout: float) -> list[str]:
    if not math.isfinite(dns_timeout) or dns_timeout <= 0:
        raise ValueError("dns_timeout must be finite and positive")
    if endpoint.loopback:
        return [endpoint.host]
    try:
        ipaddress.ip_address(endpoint.host)
    except ValueError:
        try:
            async with asyncio.timeout(dns_timeout):
                records = await (resolver or _getaddrinfo)(endpoint.host, endpoint.port)
        except (OSError, TimeoutError, UnicodeError):
            raise WorkError("model_endpoint_unavailable", "暂时无法确认模型地址的公共网络解析，请稍后重试。", 503) from None
        addresses = []
        if not records:
            raise _blocked()
        for record in records:
            try:
                family, kind, _protocol, _canonical, target = record
                value = target[0]
                if (family not in {socket.AF_INET, socket.AF_INET6} or kind != socket.SOCK_STREAM
                        or family == socket.AF_INET6 and (len(target) != 4 or target[3] != 0)
                        or not isinstance(value, str) or not _public(value)):
                    raise ValueError
                address = ipaddress.ip_address(value)
                if address.version != (4 if family == socket.AF_INET else 6):
                    raise ValueError
            except (TypeError, ValueError, IndexError):
                raise _blocked() from None
            if address.compressed not in addresses:
                addresses.append(address.compressed)
        # Prefer IPv4 when both exist; do not retry an already-dispatched POST.
        return sorted(addresses, key=lambda value: ipaddress.ip_address(value).version)
    return [endpoint.host]


async def validate_model_endpoint(api_base: str, allow_loopback: bool = False, *, resolver: Resolver | None = None,
                                  dns_timeout: float = 10.0) -> str:
    """Preflight for field validation; requests still re-resolve and pin at use."""
    endpoint = _endpoint(api_base, allow_loopback)
    await _addresses(endpoint, resolver, dns_timeout)
    return str(endpoint.url).rstrip("/")


class HostedModelTransport(httpx.AsyncBaseTransport):
    def __init__(self, api_base: str, *, allow_loopback: bool = False, resolver: Resolver | None = None,
                 dns_timeout: float = 10.0, transport: httpx.AsyncBaseTransport | None = None,
                 limits: httpx.Limits | None = None):
        self.endpoint = _endpoint(api_base, allow_loopback)
        self.resolver, self.dns_timeout = resolver, dns_timeout
        self._transport = transport if transport is not None else httpx.AsyncHTTPTransport(
            trust_env=False, verify=True, retries=0, http1=True, http2=False,
            limits=limits or httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )
        self._closed = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._closed:
            raise WorkError("model_transport_closed", "模型连接已关闭。", 503)
        if (request.url.username or request.url.password or request.url.fragment
                or _origin(request.url) != _origin(self.endpoint.url)):
            raise _blocked("模型请求超出已批准的接口地址。")
        addresses = await _addresses(self.endpoint, self.resolver, self.dns_timeout)
        headers = httpx.Headers(request.headers)
        headers["Host"] = self.endpoint.url.netloc.decode("ascii")
        # httpx forwards this extension unchanged. httpcore 1.0.9 uses it as
        # start_tls(server_hostname=...), including certificate hostname checks.
        pinned = httpx.Request(request.method, request.url.copy_with(host=addresses[0]), headers=headers,
                               stream=request.stream,
                               extensions={**request.extensions, "sni_hostname": self.endpoint.host})
        response = await self._transport.handle_async_request(pinned)
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise _blocked("模型接口发生跳转，请填写最终的公共 HTTPS 地址。")
        response.request = request
        return response

    async def aclose(self):
        if not self._closed:
            self._closed = True
            await self._transport.aclose()
