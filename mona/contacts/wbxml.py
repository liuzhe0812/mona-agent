"""WBXML (WAP Binary XML) 编解码器，用于 Exchange ActiveSync。

参考规范：
- WAP-192-WBXML-20010725-a（WBXML 1.3）
- MS-AS* 系列规范中的代码页定义

仅实现 ActiveSync 所需子集：
- 不使用字符串表（string table）
- 不使用属性（attribute）
- 支持 SWITCH_PAGE 切换代码页
- 支持 STR_I（inline 字符串）、OPAQUE（二进制数据）、ENTITY（字符实体）
"""

from __future__ import annotations

from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# WBXML 全局 token
# ---------------------------------------------------------------------------

SWITCH_PAGE = 0x00
END = 0x01
ENTITY = 0x02
STR_I = 0x03  # inline 字符串，以 \x00 结尾
LITERAL = 0x04  # 字符串表引用的标签名
STR_T = 0x83  # 字符串表引用
OPAQUE = 0xC3  # 二进制数据

# WBXML 版本
WBXML_VERSION_1_3 = 0x03

# 字符集常量
CHARSET_UTF8 = 0x6A  # MIBenum 106

# ---------------------------------------------------------------------------
# ActiveSync 代码页
# ---------------------------------------------------------------------------

CODE_PAGES: dict[int, dict[int, str]] = {
    0: {  # AirSync
        0x05: "Sync", 0x06: "Responses", 0x07: "Add", 0x08: "Change",
        0x09: "Delete", 0x0A: "Fetch", 0x0B: "SyncKey", 0x0C: "ClientId",
        0x0D: "ServerId", 0x0E: "Status", 0x0F: "Collection", 0x10: "Class",
        0x11: "Version", 0x12: "CollectionId", 0x13: "GetChanges",
        0x14: "MoreAvailable", 0x15: "WindowSize", 0x16: "Commands",
        0x17: "Options", 0x18: "FilterType", 0x19: "Conflict",
        0x1C: "Collections", 0x1D: "ApplicationData",
    },
    5: {  # Contacts
        0x05: "Anniversary", 0x06: "AssistantName", 0x07: "AssistantPhoneNumber",
        0x08: "Birthday", 0x09: "Body", 0x0A: "Business2PhoneNumber",
        0x0B: "BusinessCity", 0x0C: "BusinessCountry", 0x0D: "BusinessPostalCode",
        0x0E: "BusinessState", 0x0F: "BusinessStreet", 0x10: "BusinessPhoneNumber",
        0x11: "CarPhoneNumber", 0x12: "Categories", 0x13: "Category",
        0x14: "Children", 0x15: "Child", 0x16: "CompanyName",
        0x17: "Department", 0x18: "Email1Address", 0x19: "Email2Address",
        0x1A: "Email3Address", 0x1B: "FileAs", 0x1C: "FirstName",
        0x1D: "Home2PhoneNumber", 0x1E: "HomeCity", 0x1F: "HomeCountry",
        0x20: "HomePostalCode", 0x21: "HomeState", 0x22: "HomeStreet",
        0x23: "HomePhoneNumber", 0x24: "JobTitle", 0x25: "LastName",
        0x26: "MiddleName", 0x27: "MobilePhoneNumber", 0x28: "OfficeLocation",
        0x29: "OtherCity", 0x2A: "OtherCountry", 0x2B: "OtherPostalCode",
        0x2C: "OtherState", 0x2D: "OtherStreet", 0x2E: "PagerNumber",
        0x2F: "RadioPhoneNumber", 0x30: "Spouse", 0x31: "Suffix",
        0x32: "Title", 0x33: "WebPage", 0x34: "YomiCompanyName",
        0x35: "YomiFirstName", 0x36: "YomiLastName", 0x37: "Picture",
        0x38: "Alias", 0x39: "WeightedRank",
    },
    7: {  # Contacts2
        0x05: "CustomerId", 0x06: "GovernmentId", 0x07: "IMAddress",
        0x08: "IMAddress2", 0x09: "IMAddress3", 0x0A: "Manager",
        0x0B: "CompanyMainPhone", 0x0C: "AccountName", 0x0D: "NickName",
        0x0E: "MMS",
    },
    14: {  # AirSyncBase
        0x05: "Body", 0x06: "Type", 0x07: "Data", 0x08: "EstimatedDataSize",
        0x09: "Truncated", 0x0A: "Attachments", 0x0B: "Attachment",
        0x0C: "DisplayName", 0x0D: "FileReference", 0x0E: "Method",
        0x0F: "Size", 0x10: "Type", 0x11: "Content", 0x12: "ContentLocation",
        0x13: "IsInline", 0x14: "NativeBodyType", 0x15: "BodyPreference",
        0x16: "BodyPartPreference", 0x17: "BodyPart", 0x18: "Status",
        0x19: "Preview",
    },
    17: {  # FolderHierarchy
        0x05: "Folders", 0x06: "Folder", 0x07: "DisplayName", 0x08: "ServerId",
        0x09: "ParentId", 0x0A: "Type", 0x0B: "Response", 0x0C: "Status",
        0x0D: "FolderCreate", 0x0E: "FolderDelete", 0x0F: "FolderUpdate",
        0x10: "SyncKey", 0x11: "FolderSync", 0x12: "FolderChanges",
        0x13: "FolderChange", 0x14: "Count", 0x15: "FolderAdd",
        0x16: "FolderRemove",
    },
    19: {  # Settings
        0x05: "Settings", 0x06: "Status", 0x07: "Get", 0x08: "Set",
        0x09: "Oof", 0x0A: "OofState", 0x0B: "StartTime", 0x0C: "EndTime",
        0x0D: "OofMessage", 0x0E: "ApptReq", 0x0F: "MaxRetries",
        0x10: "Duration", 0x11: "BodyType", 0x12: "DeviceInformation",
        0x13: "Model", 0x14: "IMEI", 0x15: "FriendlyName", 0x16: "OS",
        0x17: "OSLanguage", 0x18: "PhoneNumber", 0x19: "UserAgent",
        0x1A: "MobileOperator", 0x1B: "EnableOutboundSMS",
        0x1C: "UserInformation", 0x1D: "EmailAddresses",
    },
    24: {  # Provision
        0x05: "Provision", 0x06: "Policies", 0x07: "Policy",
        0x08: "PolicyType", 0x09: "PolicyKey", 0x0A: "Data",
        0x0B: "Status", 0x0C: "RemoteWipe", 0x0D: "EASProvisionDoc",
        0x0E: "DevicePasswordEnabled",
        0x0F: "AlphanumericDevicePasswordRequired",
        0x10: "RequireStorageCardEncryption", 0x11: "AttachmentsEnabled",
        0x12: "MinDevicePasswordLength",
        0x13: "MaxInactivityTimeDevicePasswordLock",
        0x14: "MaxDevicePasswordFailedAttempts", 0x15: "MaxAttachmentSize",
        0x16: "AllowSimpleDevicePassword", 0x17: "DevicePasswordExpiration",
        0x18: "DevicePasswordHistory", 0x19: "AllowStorageCard",
        0x1A: "AllowNonProvisionableDevices",
        0x1B: "DeviceEncryptionEnabled",
    },
}

# 反向查找表：page -> {name: token}
CODE_PAGE_REVERSE: dict[int, dict[str, int]] = {
    page: {name: token for token, name in mapping.items()}
    for page, mapping in CODE_PAGES.items()
}


# ---------------------------------------------------------------------------
# Node 数据结构
# ---------------------------------------------------------------------------


@dataclass
class Node:
    """WBXML 节点（轻量 XML 表示）。

    每个节点记录所属代码页（page），用于编解码时正确映射 token。
    """

    name: str
    page: int = 0
    children: list[Node] = field(default_factory=list)
    text: str | None = None

    def find(self, name: str) -> Node | None:
        """查找第一个名为 name 的直接子节点。"""
        for child in self.children:
            if child.name == name:
                return child
        return None

    def findall(self, name: str) -> list[Node]:
        """查找所有名为 name 的直接子节点。"""
        return [c for c in self.children if c.name == name]

    def get_text(self, name: str, default: str = "") -> str:
        """获取名为 name 的子节点的文本，不存在时返回 default。"""
        node = self.find(name)
        if node and node.text is not None:
            return node.text
        return default

    def add_child(self, name: str, text: str | None = None, page: int | None = None) -> Node:
        """添加子节点并返回新节点。page 为 None 时继承当前节点 page。"""
        child = Node(name=name, page=page if page is not None else self.page, text=text)
        self.children.append(child)
        return child


# ---------------------------------------------------------------------------
# 多字节整数编解码
# ---------------------------------------------------------------------------


def _read_mb_uint32(data: bytes, pos: int) -> tuple[int, int]:
    """读取多字节无符号整数（WBXML mb_u_int32）。

    每字节低 7 位是数据，最高位为 1 表示后续还有字节。

    Returns:
        (value, new_pos)
    """
    result = 0
    while True:
        if pos >= len(data):
            raise ValueError("WBXML 数据在 mb_uint32 中意外结束")
        byte = data[pos]
        pos += 1
        result = (result << 7) | (byte & 0x7F)
        if not (byte & 0x80):
            break
    return result, pos


# ---------------------------------------------------------------------------
# 解码：bytes → Node
# ---------------------------------------------------------------------------


def decode(data: bytes) -> Node:
    """将 WBXML 字节流解码为 Node 树。

    Args:
        data: WBXML 二进制数据

    Returns:
        根节点

    Raises:
        ValueError: 数据格式错误
    """
    if len(data) < 4:
        raise ValueError("WBXML 数据过短（< 4 字节）")

    pos = 0
    # 版本号（1 字节）
    version = data[pos]
    pos += 1
    if version not in (0x01, 0x02, 0x03):
        # 非标准版本，尝试继续
        pass

    # 公共标识符（mb_u_int32）
    _public_id, pos = _read_mb_uint32(data, pos)
    # 字符集（mb_u_int32）
    _charset, pos = _read_mb_uint32(data, pos)
    # 字符串表长度（mb_u_int32）
    str_table_len, pos = _read_mb_uint32(data, pos)
    str_table = data[pos : pos + str_table_len]
    pos += str_table_len

    root, _ = _parse_element(data, pos, 0, str_table)
    return root


def _parse_element(
    data: bytes, pos: int, current_page: int, str_table: bytes
) -> tuple[Node, int]:
    """解析单个元素节点。

    Returns:
        (node, new_pos)
    """
    if pos >= len(data):
        raise ValueError("WBXML 数据在元素开始处意外结束")

    token = data[pos]
    pos += 1

    # SWITCH_PAGE：切换代码页
    if token == SWITCH_PAGE:
        if pos >= len(data):
            raise ValueError("SWITCH_PAGE 后缺少页码")
        current_page = data[pos]
        pos += 1
        if pos >= len(data):
            raise ValueError("SWITCH_PAGE 后缺少元素 token")
        token = data[pos]
        pos += 1

    has_attrs = bool(token & 0x80)
    has_content = bool(token & 0x40)
    tag_id = token & 0x3F

    # 解析标签名
    if tag_id == 0x04:  # LITERAL：从字符串表查找
        ref, pos = _read_mb_uint32(data, pos)
        end_idx = str_table.find(b"\x00", ref)
        if end_idx < 0:
            end_idx = len(str_table)
        name = str_table[ref:end_idx].decode("utf-8", errors="replace")
    else:
        page_map = CODE_PAGES.get(current_page, {})
        name = page_map.get(tag_id, f"Unknown_{current_page}_{tag_id}")

    node = Node(name=name, page=current_page)

    # 跳过属性（ActiveSync 不使用属性）
    if has_attrs:
        while pos < len(data) and data[pos] != END:
            pos += 1
        pos += 1  # 跳过 END

    # 解析内容
    if has_content:
        while pos < len(data):
            t = data[pos]

            if t == END:
                pos += 1
                break
            elif t == SWITCH_PAGE:
                if pos + 1 >= len(data):
                    raise ValueError("SWITCH_PAGE 后缺少页码")
                current_page = data[pos + 1]
                pos += 2
            elif t == STR_I:
                pos += 1
                end_idx = data.find(b"\x00", pos)
                if end_idx < 0:
                    raise ValueError("STR_I 未找到终止符")
                text = data[pos:end_idx].decode("utf-8", errors="replace")
                if node.text is None:
                    node.text = text
                else:
                    node.text += text
                pos = end_idx + 1
            elif t == OPAQUE:
                pos += 1
                length, pos = _read_mb_uint32(data, pos)
                raw = data[pos : pos + length]
                text = raw.decode("utf-8", errors="replace")
                if node.text is None:
                    node.text = text
                else:
                    node.text += text
                pos += length
            elif t == ENTITY:
                pos += 1
                val, pos = _read_mb_uint32(data, pos)
                char = chr(val)
                if node.text is None:
                    node.text = char
                else:
                    node.text += char
            elif t == STR_T:
                pos += 1
                ref, pos = _read_mb_uint32(data, pos)
                end_idx = str_table.find(b"\x00", ref)
                if end_idx < 0:
                    end_idx = len(str_table)
                text = str_table[ref:end_idx].decode("utf-8", errors="replace")
                if node.text is None:
                    node.text = text
                else:
                    node.text += text
            else:
                # 子元素
                child, pos = _parse_element(data, pos, current_page, str_table)
                node.children.append(child)

    return node, pos


# ---------------------------------------------------------------------------
# 编码：Node → bytes
# ---------------------------------------------------------------------------


def encode(root: Node) -> bytes:
    """将 Node 树编码为 WBXML 字节流。

    Args:
        root: 根节点

    Returns:
        WBXML 二进制数据

    Raises:
        ValueError: 节点名称在代码页中找不到
    """
    out = bytearray()
    # 头部：版本 1.3 / 公共标识 unknown / UTF-8 / 无字符串表
    out.append(WBXML_VERSION_1_3)
    out.append(0x01)  # public id: unknown
    out.append(CHARSET_UTF8)
    out.append(0x00)  # string table length: 0

    _encode_node(out, root, 0)
    return bytes(out)


def _encode_node(out: bytearray, node: Node, current_page: int) -> int:
    """编码单个节点到 out，返回当前代码页。"""
    # 切换代码页
    if node.page != current_page:
        out.append(SWITCH_PAGE)
        out.append(node.page)
        current_page = node.page

    page_map = CODE_PAGE_REVERSE.get(node.page, {})
    tag_id = page_map.get(node.name)
    if tag_id is None:
        raise ValueError(
            f"标签 '{node.name}' 在代码页 {node.page} 中未定义"
        )

    has_content = bool(node.children) or node.text is not None
    token = tag_id | (0x40 if has_content else 0)
    out.append(token)

    if has_content:
        # 先输出文本
        if node.text is not None:
            out.append(STR_I)
            out.extend(node.text.encode("utf-8"))
            out.append(0x00)
        # 再输出子节点
        for child in node.children:
            current_page = _encode_node(out, child, current_page)
        out.append(END)

    return current_page
