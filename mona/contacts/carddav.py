"""CardDAV 客户端（RFC 6352）。

实现：
- PROPFIND 发现地址簿集合（addressbook-collection）
- addressbook-query / sync-collection（RFC 6578 增量同步）
- GET 单个 vCard

使用 httpx 异步客户端，所有出站请求经 SSRF 校验。
XML 解析用 defusedxml 防 XXE。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import defusedxml.ElementTree  # type: ignore[import-untyped]
import httpx
from loguru import logger

from mona.contacts.vcard import VCard, parse_vcards
from mona.security.network import validate_url_target

# XML 命名空间
NS_DAV = "DAV:"
NS_CARD = "urn:ietf:params:xml:ns:carddav"

# 同步超时（秒）
SYNC_TIMEOUT = 60.0
# 单次 GET 并发数
GET_CONCURRENCY = 5


class CardDavError(Exception):
    """CardDAV 操作错误。"""


@dataclass
class ContactChange:
    """sync-collection 返回的单个变更。"""

    href: str
    etag: str | None
    vcard: VCard | None  # None 表示已删除
    deleted: bool = False


@dataclass
class SyncResult:
    """sync-collection 结果。"""

    changes: list[ContactChange]
    new_sync_token: str | None


class CardDavClient:
    """CardDAV 客户端，每个账号一个实例。"""

    def __init__(self, base_url: str, username: str, password: str) -> None:
        # 自动补全 scheme，兼容用户省略 https:// 的输入
        url = base_url.strip()
        if url and not url.startswith(("http://", "https://")):
            url = "https://" + url
        self.base_url = url.rstrip("/") + "/"
        self.username = username
        self.password = password
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> "CardDavClient":
        self._client = httpx.AsyncClient(
            auth=httpx.BasicAuth(self.username, self.password),
            timeout=httpx.Timeout(SYNC_TIMEOUT),
            follow_redirects=True,
            headers={"User-Agent": "Mona-Desktop/1.0 (CardDAV client)"},
        )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _validate(self, url: str) -> None:
        ok, err = validate_url_target(url)
        if not ok:
            raise CardDavError(f"URL 安全校验失败: {err}")

    async def _request(
        self,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        content: str | bytes | None = None,
        depth: str = "0",
    ) -> httpx.Response:
        if not self._client:
            raise CardDavError("客户端未初始化，请在 async with 上下文中使用")
        self._validate(url)
        req_headers = {"Depth": depth}
        if headers:
            req_headers.update(headers)
        if content is not None and "Content-Type" not in req_headers:
            req_headers["Content-Type"] = "application/xml; charset=utf-8"

        try:
            resp = await self._client.request(
                method, url, headers=req_headers, content=content
            )
        except httpx.HTTPError as e:
            raise CardDavError(f"HTTP 请求失败 ({method} {url}): {e}") from e

        if resp.status_code == 401:
            raise CardDavError("认证失败：用户名或密码错误")
        if resp.status_code == 403:
            raise CardDavError("禁止访问：账号无权限或需应用专用密码")
        if resp.status_code == 404:
            raise CardDavError(f"资源不存在: {url}")
        if resp.status_code >= 500:
            raise CardDavError(f"服务器错误 {resp.status_code}: {resp.text[:200]}")
        return resp

    async def discover_addressbook(self) -> str:
        """通过 PROPFIND 当前用户 principals 发现地址簿 URL。

        返回地址簿集合的完整 URL。
        """
        # 先 PROPFIND base_url 找 current-user-principal
        resp = await self._request(
            "PROPFIND",
            self.base_url,
            content=_PROPFIND_PRINCIPAL_XML,
            depth="0",
        )
        principal_url = _extract_principal(resp.text)
        if not principal_url:
            # base_url 可能就是地址簿本身，直接返回
            logger.debug("未找到 principal，假设 base_url 即地址簿")
            return self.base_url

        # 拼接为绝对 URL
        principal_url = urljoin(self.base_url, principal_url)

        # PROPFIND principal 找 addressbook-home-set
        resp = await self._request(
            "PROPFIND",
            principal_url,
            content=_PROPFIND_ADDRESSBOOK_HOME_XML,
            depth="0",
        )
        home_set = _extract_addressbook_home(resp.text)
        if not home_set:
            return self.base_url

        home_url = urljoin(self.base_url, home_set)

        # PROPFIND addressbook-home-set 找具体地址簿集合
        resp = await self._request(
            "PROPFIND",
            home_url,
            content=_PROPFIND_ADDRESSBOOK_COLLECTION_XML,
            depth="1",
        )
        addressbook_url = _extract_addressbook_collection(resp.text, home_url)
        return addressbook_url or home_url

    async def full_sync(self, addressbook_url: str) -> list[tuple[str, str | None, VCard]]:
        """全量同步：PROPFIND 列出所有 vCard href + etag，再 GET 每个内容。

        返回 [(href, etag, vcard), ...]
        """
        resp = await self._request(
            "PROPFIND",
            addressbook_url,
            content=_PROPFIND_ALL_HREFS_XML,
            depth="1",
        )
        hrefs_etags = _extract_hrefs_etags(resp.text, addressbook_url)
        # 过滤掉地址簿本身（无 vCard 数据的条目）
        items = [(h, e) for h, e in hrefs_etags if h.rstrip("/").split("/")[-1]]

        # 并发 GET 每个 vCard
        semaphore = asyncio.Semaphore(GET_CONCURRENCY)

        async def fetch_one(href: str) -> tuple[str, VCard | None]:
            url = urljoin(self.base_url, href)
            try:
                get_resp = await self._request("GET", url, depth="0")
                cards = parse_vcards(get_resp.text)
                return href, cards[0] if cards else None
            except CardDavError as e:
                logger.warning(f"GET vCard 失败 {href}: {e}")
                return href, None

        results: list[tuple[str, str | None, VCard]] = []
        tasks = []
        for href, etag in items:
            async def _task(h: str = href, e: str | None = etag) -> tuple[str, str | None, VCard | None]:
                async with semaphore:
                    _, card = await fetch_one(h)
                    return h, e, card

            tasks.append(_task())

        for coro in asyncio.as_completed(tasks):
            href, etag, card = await coro
            if card:
                results.append((href, etag, card))
        return results

    async def sync_collection(
        self, addressbook_url: str, sync_token: str | None
    ) -> SyncResult:
        """增量同步（RFC 6578 sync-collection）。

        若服务器不支持 sync-collection，回退到全量。
        """
        xml = _build_sync_collection_xml(sync_token)
        resp = await self._request(
            "REPORT",
            addressbook_url,
            content=xml,
            depth="1",
        )
        if resp.status_code == 501 or resp.status_code == 403:
            # 不支持 sync-collection，回退全量
            logger.info("服务器不支持 sync-collection，回退全量同步")
            all_items = await self.full_sync(addressbook_url)
            changes = [
                ContactChange(href=h, etag=e, vcard=c, deleted=False)
                for h, e, c in all_items
            ]
            return SyncResult(changes=changes, new_sync_token=None)

        changes = _parse_sync_response(resp.text, addressbook_url)
        new_token = _extract_sync_token(resp.text)
        return SyncResult(changes=changes, new_sync_token=new_token)

    async def test_connection(self) -> tuple[bool, int, str | None]:
        """测试连接，返回 (ok, contacts_count, error)。"""
        try:
            ab_url = await self.discover_addressbook()
            items = await self.full_sync(ab_url)
            return True, len(items), None
        except CardDavError as e:
            return False, 0, str(e)
        except Exception as e:
            return False, 0, f"未知错误: {e}"


# ---------------------------------------------------------------------------
# XML 请求模板
# ---------------------------------------------------------------------------

_PROPFIND_PRINCIPAL_XML = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>
"""

_PROPFIND_ADDRESSBOOK_HOME_XML = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:addressbook-home-set/>
  </d:prop>
</d:propfind>
"""

_PROPFIND_ADDRESSBOOK_COLLECTION_XML = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
  </d:prop>
</d:propfind>
"""

_PROPFIND_ALL_HREFS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
  </d:prop>
</d:propfind>
"""


def _build_sync_collection_xml(sync_token: str | None) -> str:
    token_xml = f"<d:sync-token>{sync_token}</d:sync-token>" if sync_token else "<d:sync-token/>"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  {token_xml}
  <d:sync-level>1</d:sync-level>
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
</d:sync-collection>
"""


# ---------------------------------------------------------------------------
# XML 响应解析
# ---------------------------------------------------------------------------

def _ns(tag: str) -> str:
    """构造带命名空间的标签。"""
    if tag.startswith("{"):
        return tag
    return f"{{{NS_DAV}}}{tag}"


def _ns_card(tag: str) -> str:
    return f"{{{NS_CARD}}}{tag}"


def _extract_principal(xml_text: str) -> str | None:
    """从 PROPFIND 响应提取 current-user-principal href。"""
    try:
        root = defusedxml.ElementTree.fromstring(xml_text)
    except Exception:
        return None
    for resp in root.iter(_ns("response")):
        for propstat in resp.iter(_ns("propstat")):
            for prop in propstat.iter(_ns("prop")):
                principal = prop.find(_ns("current-user-principal"))
                if principal is not None:
                    href = principal.find(_ns("href"))
                    if href is not None and href.text:
                        return href.text.strip()
    return None


def _extract_addressbook_home(xml_text: str) -> str | None:
    """提取 addressbook-home-set href。"""
    try:
        root = defusedxml.ElementTree.fromstring(xml_text)
    except Exception:
        return None
    for resp in root.iter(_ns("response")):
        for propstat in resp.iter(_ns("propstat")):
            for prop in propstat.iter(_ns("prop")):
                home = prop.find(_ns_card("addressbook-home-set"))
                if home is not None:
                    href = home.find(_ns("href"))
                    if href is not None and href.text:
                        return href.text.strip()
    return None


def _extract_addressbook_collection(xml_text: str, base: str) -> str | None:
    """从 PROPFIND 响应找 addressbook 类型的集合 URL。"""
    try:
        root = defusedxml.ElementTree.fromstring(xml_text)
    except Exception:
        return None
    for resp in root.iter(_ns("response")):
        href_elem = resp.find(_ns("href"))
        if href_elem is None or not href_elem.text:
            continue
        for propstat in resp.iter(_ns("propstat")):
            for prop in propstat.iter(_ns("prop")):
                rtype = prop.find(_ns("resourcetype"))
                if rtype is not None:
                    ab = rtype.find(_ns_card("addressbook"))
                    if ab is not None:
                        return urljoin(base, href_elem.text.strip())
    return None


def _extract_hrefs_etags(
    xml_text: str, base: str
) -> list[tuple[str, str | None]]:
    """从 PROPFIND 响应提取所有 (href, etag)。"""
    result: list[tuple[str, str | None]] = []
    try:
        root = defusedxml.ElementTree.fromstring(xml_text)
    except Exception:
        return result
    for resp in root.iter(_ns("response")):
        href_elem = resp.find(_ns("href"))
        if href_elem is None or not href_elem.text:
            continue
        href = href_elem.text.strip()
        etag: str | None = None
        for propstat in resp.iter(_ns("propstat")):
            for prop in propstat.iter(_ns("prop")):
                etag_elem = prop.find(_ns("getetag"))
                if etag_elem is not None and etag_elem.text:
                    etag = etag_elem.text.strip()
        result.append((href, etag))
    return result


def _extract_sync_token(xml_text: str) -> str | None:
    """从 sync-collection 响应提取 sync-token。"""
    try:
        root = defusedxml.ElementTree.fromstring(xml_text)
    except Exception:
        return None
    token = root.find(_ns("sync-token"))
    if token is not None and token.text:
        return token.text.strip()
    return None


def _parse_sync_response(
    xml_text: str, base: str
) -> list[ContactChange]:
    """解析 sync-collection REPORT 响应。"""
    changes: list[ContactChange] = []
    try:
        root = defusedxml.ElementTree.fromstring(xml_text)
    except Exception:
        return changes

    for resp in root.iter(_ns("response")):
        href_elem = resp.find(_ns("href"))
        if href_elem is None or not href_elem.text:
            continue
        href = href_elem.text.strip()

        # 检查是否删除（status 404）
        is_deleted = False
        for propstat in resp.iter(_ns("propstat")):
            status = propstat.find(_ns("status"))
            if status is not None and status.text and "404" in status.text:
                is_deleted = True
                break

        if is_deleted:
            changes.append(ContactChange(href=href, etag=None, vcard=None, deleted=True))
            continue

        etag: str | None = None
        vcard_text: str | None = None
        for propstat in resp.iter(_ns("propstat")):
            for prop in propstat.iter(_ns("prop")):
                etag_elem = prop.find(_ns("getetag"))
                if etag_elem is not None and etag_elem.text:
                    etag = etag_elem.text.strip()
                addr = prop.find(_ns_card("address-data"))
                if addr is not None and addr.text:
                    vcard_text = addr.text

        vcard = None
        if vcard_text:
            cards = parse_vcards(vcard_text)
            vcard = cards[0] if cards else None

        changes.append(ContactChange(href=href, etag=etag, vcard=vcard, deleted=False))

    return changes
