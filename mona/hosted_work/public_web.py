"""Mediated read-only public HTTP access; user processes have no network interface."""
from __future__ import annotations

import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import DefaultResolver

from mona.hosted_work.contracts import WorkError


def public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped:
            return public_address(str(address.ipv4_mapped))
        if address.sixtofour or address.teredo or "%" in value:
            return False
    return address.is_global and not address.is_multicast and not address.is_reserved


def validate_public_url(url: str) -> str:
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 33 for c in url) or "\\" in url:
        raise WorkError("invalid_url", "网页地址无效。")
    try:
        parsed = urlsplit(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 80, 443)
                or "%" in parsed.hostname):
            raise ValueError("invalid public URL")
        try:
            ipaddress.ip_address(parsed.hostname)
        except ValueError:
            if parsed.hostname.lower() == "localhost" or parsed.hostname.lower().endswith((".localhost", ".local")):
                raise ValueError("local hostname")
        else:
            if not public_address(parsed.hostname):
                raise ValueError("nonpublic IP")
    except ValueError as exc:
        raise WorkError("blocked_url", "仅允许访问公共网站，不允许访问本机或私有网络。") from exc
    return url


class PublicResolver(AbstractResolver):
    def __init__(self):
        self.resolver = DefaultResolver()

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET):
        records = await self.resolver.resolve(host, port, family)
        if not records or any(not public_address(item["host"]) for item in records):
            raise OSError("nonpublic DNS answer refused")
        return records

    async def close(self):
        await self.resolver.close()


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


async def fetch_public_text(url: str) -> dict:
    resolver = PublicResolver()
    try:
        connector = aiohttp.TCPConnector(resolver=resolver, use_dns_cache=False, limit=4, family=socket.AF_UNSPEC)
        async with aiohttp.ClientSession(connector=connector, trust_env=False, auto_decompress=False,
                                         cookie_jar=aiohttp.DummyCookieJar(),
                                         timeout=aiohttp.ClientTimeout(total=20)) as client:
            for _ in range(6):
                validate_public_url(url)
                async with client.get(url, allow_redirects=False, headers={"Accept-Encoding": "identity"}) as response:
                    if response.status in {301, 302, 303, 307, 308}:
                        location = response.headers.get("Location")
                        if not location:
                            raise WorkError("web_unavailable", "网页跳转无效。")
                        url = urljoin(url, location)
                        continue
                    if response.status >= 400:
                        raise WorkError("web_unavailable", "网站未能提供该网页。")
                    if response.headers.get("Content-Encoding", "identity").lower() not in {"identity", ""}:
                        raise WorkError("unsupported_content", "网站未提供可安全读取的文本。")
                    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                    if content_type not in {"text/plain", "text/html", "application/json", "application/xhtml+xml"}:
                        raise WorkError("unsupported_content", "此入口仅支持网页和文本，请通过附件上传文件。")
                    data = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        data.extend(chunk)
                        if len(data) > 2 * 1024 * 1024:
                            raise WorkError("web_too_large", "网页超过读取上限。")
                    text = bytes(data).decode(response.charset or "utf-8", errors="replace")
                    if content_type in {"text/html", "application/xhtml+xml"}:
                        parser = PageText()
                        parser.feed(text)
                        text = "\n".join(parser.parts)
                    return {"url": str(response.url), "content": text[:24000], "truncated": len(text) > 24000}
    except (aiohttp.ClientError, OSError, TimeoutError, LookupError) as exc:
        raise WorkError("web_unavailable", "网页无法安全访问，请换一个公共网页地址。") from exc
    finally:
        await resolver.close()
    raise WorkError("redirect_limit", "网页跳转次数过多，已停止访问。")
