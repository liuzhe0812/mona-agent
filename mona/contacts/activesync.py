"""Exchange ActiveSync (EAS) 客户端。

实现联系人同步所需的 EAS 协议子集：
- PROVISION：获取策略密钥（PolicyKey），部分服务器要求
- FOLDERSYNC：发现联系人文件夹（Type=9）
- SYNC：同步联系人（全量/增量）

使用 WBXML 二进制编码（mona.contacts.wbxml），HTTP POST 到
`/Microsoft-Server-ActiveSync?Cmd=...&User=...&DeviceId=...&DeviceType=...`

参考规范：MS-ASCMD, MS-ASHTTP, MS-ASPROV, MS-ASFH, MS-ASSYNC
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx
from loguru import logger

from mona.contacts.wbxml import Node
from mona.contacts.wbxml import decode as wbxml_decode
from mona.contacts.wbxml import encode as wbxml_encode
from mona.security.network import validate_url_target

# EAS 协议版本
EAS_PROTOCOL_VERSION = "14.1"

# 请求超时（秒）
REQUEST_TIMEOUT = 60.0

# 联系人文件夹类型（FolderHierarchy Type 字段）
FOLDER_TYPE_CONTACTS = 9

# 代码页常量
PAGE_AIRSYNC = 0
PAGE_CONTACTS = 5
PAGE_AIRSYNC_BASE = 14
PAGE_FOLDER_HIERARCHY = 17
PAGE_PROVISION = 24


class EASError(Exception):
    """ActiveSync 操作错误。"""


@dataclass
class EASFolder:
    """文件夹信息。"""

    server_id: str
    parent_id: str
    display_name: str
    folder_type: int


@dataclass
class EASContact:
    """解析后的 EAS 联系人。"""

    server_id: str
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class EASSyncResult:
    """SYNC 命令结果。"""

    sync_key: str
    contacts: list[EASContact]
    deleted_ids: list[str]
    more_available: bool


class EASClient:
    """Exchange ActiveSync 客户端，每个账号一个实例。

    用法：
        async with EASClient(url, user, pwd, device_id) as client:
            policy_key = await client.provision()
            folders = await client.folder_sync("0")
            result = await client.sync_contacts(folder_id, "0")
    """

    def __init__(
        self,
        server_url: str,
        username: str,
        password: str,
        device_id: str,
        device_type: str = "iPhone",
    ) -> None:
        # server_url 形如 https://ex.exmail.qq.com/Microsoft-Server-ActiveSync
        # 自动补全 scheme，兼容用户省略 https:// 的输入
        self.server_url = _normalize_url(server_url)
        self.username = username
        self.password = password
        self.device_id = device_id
        # 腾讯企业邮等服务商对 DeviceType 有白名单，iPhone 兼容性最好
        self.device_type = device_type
        self.policy_key: str | None = None
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> EASClient:
        auth = base64.b64encode(
            f"{self.username}:{self.password}".encode("utf-8")
        ).decode("ascii")
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT),
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/vnd.ms-sync.wbxml",
                "MS-ASProtocolVersion": EAS_PROTOCOL_VERSION,
                "User-Agent": "Apple-iPhone7C2/1202.466",
            },
        )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _validate(self, url: str) -> None:
        ok, err = validate_url_target(url)
        if not ok:
            raise EASError(f"URL 安全校验失败: {err}")

    async def _request(self, cmd: str, body: Node) -> Node | None:
        """发送 EAS 请求。

        Args:
            cmd: EAS 命令（Provision / FolderSync / Sync）
            body: WBXML 请求体（Node 树）

        Returns:
            响应的 Node 树，无响应体时返回 None
        """
        if not self._client:
            raise EASError("客户端未初始化，请在 async with 上下文中使用")

        params = urlencode({
            "Cmd": cmd,
            "User": self.username,
            "DeviceId": self.device_id,
            "DeviceType": self.device_type,
        })
        url = f"{self.server_url}?{params}"
        self._validate(url)

        headers: dict[str, str] = {}
        if self.policy_key:
            headers["X-MS-PolicyKey"] = self.policy_key

        wbxml_bytes = wbxml_encode(body)

        try:
            resp = await self._client.post(url, content=wbxml_bytes, headers=headers)
        except httpx.HTTPError as e:
            raise EASError(f"HTTP 请求失败 ({cmd}): {e}") from e

        logger.debug(
            f"EAS {cmd} status={resp.status_code} headers={dict(resp.headers)} "
            f"body={resp.text[:500]!r}"
        )

        if resp.status_code == 401:
            raise EASError("认证失败：用户名或密码错误")
        if resp.status_code == 403:
            # 部分服务器在 PROVISION 前或策略未满足时返回 403；
            # 把原始响应片段暴露给日志，便于定位是策略、设备类型还是权限问题。
            logger.warning(
                f"EAS {cmd} 403 for {self.username} at {self.server_url}; "
                f"headers={dict(resp.headers)} body={resp.text[:500]!r}"
            )
            raise EASError("禁止访问：账号无权限或未启用 ActiveSync")
        if resp.status_code == 449:
            raise EASError("需要重新 Provision（449）")
        if resp.status_code >= 500:
            raise EASError(f"服务器错误 {resp.status_code}: {resp.text[:200]}")

        if not resp.content:
            return None

        try:
            return wbxml_decode(resp.content)
        except ValueError as e:
            raise EASError(f"WBXML 解码失败: {e}") from e

    # -----------------------------------------------------------------
    # PROVISION
    # -----------------------------------------------------------------

    async def provision(self) -> str:
        """执行 PROVISION 握手，返回 PolicyKey。

        流程：
        1. 请求策略 → 服务器返回临时 PolicyKey + 策略数据
        2. 确认策略 → 服务器返回最终 PolicyKey

        若服务器不需要策略，可能直接返回空 PolicyKey。
        """
        # Step 1: 请求策略
        req = Node(
            name="Provision",
            page=PAGE_PROVISION,
            children=[
                Node(
                    name="Policies",
                    page=PAGE_PROVISION,
                    children=[
                        Node(
                            name="Policy",
                            page=PAGE_PROVISION,
                            children=[
                                Node(
                                    name="PolicyType",
                                    page=PAGE_PROVISION,
                                    text="MS-EAS-Provisioning-WBXML",
                                ),
                            ],
                        ),
                    ],
                ),
            ],
        )

        resp = await self._request("Provision", req)
        if resp is None:
            raise EASError("PROVISION 无响应")

        policies = resp.find("Policies")
        if not policies:
            # 某些服务器不需要 provision
            logger.debug("PROVISION 响应无 Policies 节点，跳过")
            return ""

        policy = policies.find("Policy")
        if not policy:
            return ""

        temp_key = policy.get_text("PolicyKey")
        status = policy.get_text("Status", "1")

        if not temp_key or status not in ("1", "2"):
            logger.warning(f"PROVISION 返回异常状态: status={status}")
            return temp_key or ""

        # Step 2: 确认策略
        ack = Node(
            name="Provision",
            page=PAGE_PROVISION,
            children=[
                Node(
                    name="Policies",
                    page=PAGE_PROVISION,
                    children=[
                        Node(
                            name="Policy",
                            page=PAGE_PROVISION,
                            children=[
                                Node(
                                    name="PolicyType",
                                    page=PAGE_PROVISION,
                                    text="MS-EAS-Provisioning-WBXML",
                                ),
                                Node(
                                    name="PolicyKey",
                                    page=PAGE_PROVISION,
                                    text=temp_key,
                                ),
                                Node(
                                    name="Status",
                                    page=PAGE_PROVISION,
                                    text="1",
                                ),
                            ],
                        ),
                    ],
                ),
            ],
        )

        resp = await self._request("Provision", ack)
        if resp is None:
            self.policy_key = temp_key
            return temp_key

        final_policies = resp.find("Policies")
        if final_policies:
            final_policy = final_policies.find("Policy")
            if final_policy:
                final_key = final_policy.get_text("PolicyKey")
                if final_key:
                    self.policy_key = final_key
                    return final_key

        self.policy_key = temp_key
        return temp_key

    # -----------------------------------------------------------------
    # FOLDERSYNC
    # -----------------------------------------------------------------

    async def folder_sync(self, sync_key: str = "0") -> tuple[str, list[EASFolder]]:
        """同步文件夹层次结构。

        Args:
            sync_key: 上次的 SyncKey，首次传 "0"

        Returns:
            (new_sync_key, folders)
        """
        req = Node(
            name="FolderSync",
            page=PAGE_FOLDER_HIERARCHY,
            children=[
                Node(
                    name="SyncKey",
                    page=PAGE_FOLDER_HIERARCHY,
                    text=sync_key,
                ),
            ],
        )

        resp = await self._request("FolderSync", req)
        if resp is None:
            raise EASError("FOLDERSYNC 无响应")

        new_key = resp.get_text("SyncKey", sync_key)
        folders: list[EASFolder] = []

        folders_node = resp.find("Folders")
        if folders_node:
            for folder_node in folders_node.findall("Folder"):
                folders.append(
                    EASFolder(
                        server_id=folder_node.get_text("ServerId"),
                        parent_id=folder_node.get_text("ParentId"),
                        display_name=folder_node.get_text("DisplayName"),
                        folder_type=int(folder_node.get_text("Type", "0")),
                    )
                )

        return new_key, folders

    async def find_contacts_folder(self) -> str:
        """查找联系人文件夹的 ServerId。

        执行完整 FolderSync（从 sync_key=0 开始），返回 Type=9 的文件夹 ID。
        """
        _, folders = await self.folder_sync("0")
        for f in folders:
            if f.folder_type == FOLDER_TYPE_CONTACTS:
                logger.info(
                    f"找到联系人文件夹: {f.display_name} (id={f.server_id})"
                )
                return f.server_id
        raise EASError("未找到联系人文件夹（Type=9）")

    # -----------------------------------------------------------------
    # SYNC（联系人）
    # -----------------------------------------------------------------

    async def sync_contacts(
        self,
        collection_id: str,
        sync_key: str = "0",
        window_size: int = 100,
    ) -> EASSyncResult:
        """同步联系人集合。

        Args:
            collection_id: 联系人文件夹的 ServerId
            sync_key: 上次的 SyncKey，首次传 "0" 表示全量
            window_size: 单次请求最大条数

        Returns:
            EASSyncResult
        """
        collection = Node(
            name="Collection",
            page=PAGE_AIRSYNC,
            children=[
                Node(name="Class", page=PAGE_AIRSYNC, text="Contacts"),
                Node(name="SyncKey", page=PAGE_AIRSYNC, text=sync_key),
                Node(name="CollectionId", page=PAGE_AIRSYNC, text=collection_id),
                Node(name="DeletesAsMoves", page=PAGE_AIRSYNC),
                Node(
                    name="Options",
                    page=PAGE_AIRSYNC,
                    children=[
                        Node(name="FilterType", page=PAGE_AIRSYNC, text="0"),
                        Node(name="WindowSize", page=PAGE_AIRSYNC, text=str(window_size)),
                    ],
                ),
            ],
        )

        req = Node(
            name="Sync",
            page=PAGE_AIRSYNC,
            children=[
                Node(
                    name="Collections",
                    page=PAGE_AIRSYNC,
                    children=[collection],
                ),
            ],
        )

        resp = await self._request("Sync", req)
        if resp is None:
            raise EASError("SYNC 无响应")

        result = EASSyncResult(
            sync_key=sync_key,
            contacts=[],
            deleted_ids=[],
            more_available=False,
        )

        collections = resp.find("Collections")
        if not collections:
            return result

        col = collections.find("Collection")
        if not col:
            return result

        result.sync_key = col.get_text("SyncKey", sync_key)
        result.more_available = col.find("MoreAvailable") is not None

        # 检查状态
        status = col.get_text("Status", "1")
        if status not in ("1", "3"):
            raise EASError(f"SYNC 返回错误状态: {status}")

        commands = col.find("Commands")
        if not commands:
            return result

        for add_node in commands.findall("Add"):
            server_id = add_node.get_text("ServerId")
            app_data = add_node.find("ApplicationData")
            if app_data and server_id:
                result.contacts.append(_parse_contact(server_id, app_data))

        for change_node in commands.findall("Change"):
            server_id = change_node.get_text("ServerId")
            app_data = change_node.find("ApplicationData")
            if app_data and server_id:
                result.contacts.append(_parse_contact(server_id, app_data))

        for del_node in commands.findall("Delete"):
            server_id = del_node.get_text("ServerId")
            if server_id:
                result.deleted_ids.append(server_id)

        # SoftDelete（部分服务器用）
        for del_node in commands.findall("SoftDelete"):
            server_id = del_node.get_text("ServerId")
            if server_id:
                result.deleted_ids.append(server_id)

        return result


# ---------------------------------------------------------------------------
# 联系人解析
# ---------------------------------------------------------------------------


def _parse_contact(server_id: str, app_data: Node) -> EASContact:
    """从 ApplicationData 节点解析联系人字段。

    ApplicationData 的子节点来自不同代码页：
    - Contacts (page=5): FirstName, LastName, Email1Address, ...
    - AirSyncBase (page=14): Body (含 Type + Data 子节点)
    """
    first_name = app_data.get_text("FirstName")
    last_name = app_data.get_text("LastName")
    file_as = app_data.get_text("FileAs")

    # 显示名优先级：FileAs > FirstName+LastName > Email1Address
    display_name = file_as
    if not display_name:
        parts = [n for n in (first_name, last_name) if n]
        display_name = " ".join(parts) if parts else ""

    email1 = app_data.get_text("Email1Address")
    email2 = app_data.get_text("Email2Address")
    email3 = app_data.get_text("Email3Address")

    # 主邮箱
    primary_email = email1 or email2 or email3 or ""
    # 其他邮箱
    other_emails: list[str] = []
    for e in (email2, email3):
        if e and e != primary_email:
            other_emails.append(e)

    # 电话（优先级：手机 > 住宅 > 工作）
    phone = (
        app_data.get_text("MobilePhoneNumber")
        or app_data.get_text("HomePhoneNumber")
        or app_data.get_text("BusinessPhoneNumber")
        or app_data.get_text("Home2PhoneNumber")
        or app_data.get_text("Business2PhoneNumber")
    )

    company = app_data.get_text("CompanyName")
    title = app_data.get_text("JobTitle")
    department = app_data.get_text("Department")

    # 备注：AirSyncBase:Body → Data 子节点
    note = ""
    body_node = app_data.find("Body")
    if body_node:
        data_node = body_node.find("Data")
        if data_node and data_node.text:
            note = data_node.text
        elif body_node.text:
            # 旧版 Contacts:Body 直接含文本
            note = body_node.text

    web_page = app_data.get_text("WebPage")

    import json

    data: dict[str, Any] = {
        "remoteUid": server_id,
        "displayName": display_name or primary_email or "(未命名)",
        "email": primary_email or None,
        "emailList": json.dumps(other_emails) if other_emails else None,
        "phone": phone or None,
        "organization": company or None,
        "title": title or None,
        "note": note or None,
        "rawVcard": None,  # EAS 无原始 vCard
    }
    if department:
        data["department"] = department
    if web_page:
        data["webPage"] = web_page

    return EASContact(server_id=server_id, data=data)


# ---------------------------------------------------------------------------
# DeviceID 生成
# ---------------------------------------------------------------------------


def generate_device_id(account_id: str) -> str:
    """根据账号 ID 生成稳定的 DeviceID。

    EAS DeviceID 要求：字母数字，长度 1-16，同一设备保持稳定。
    使用 SHA-256 截断前 16 位（大写十六进制）。
    """
    digest = hashlib.sha256(f"mona-eas-{account_id}".encode("utf-8")).hexdigest()
    return digest[:16].upper()


def _normalize_url(url: str) -> str:
    """规范化 URL：去除首尾空白，自动补全 https:// scheme。

    用户可能输入 "ex.exmail.qq.com/..." 而省略 scheme，
    此函数补全为 "https://ex.exmail.qq.com/..."。
    """
    url = url.strip()
    if not url:
        return url
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url.rstrip("/")
