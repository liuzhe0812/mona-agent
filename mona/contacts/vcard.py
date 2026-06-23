"""轻量 vCard 解析器（无第三方依赖）。

支持 vCard 3.0 / 4.0 的常用字段：
- UID / FN / N / EMAIL / TEL / ORG / TITLE / NOTE / REV
- 行折叠展开（RFC 6350 §3.2）
- 参数解析（;TYPE=work;PREF=1）
- PHOTO 字段跳过（避免大 base64 占用内存）

不实现完整 vCard 规范，只提取同步所需字段。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class VCard:
    """解析后的 vCard 联系人。"""

    uid: str = ""
    display_name: str = ""
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    organization: str = ""
    title: str = ""
    note: str = ""
    revision: str = ""  # REV 字段原始值（ISO 时间戳）
    raw: str = ""  # 原始 vCard 文本

    @property
    def primary_email(self) -> str:
        """主邮箱（第一个，优先选 TYPE=pref 的）。"""
        return self.emails[0] if self.emails else ""


def _unfold_lines(text: str) -> list[str]:
    """展开 vCard 折叠行：以空格/制表符开头的行是上一行的续行。"""
    lines: list[str] = []
    for raw_line in text.splitlines():
        if not raw_line:
            continue
        if raw_line[0] in (" ", "\t"):
            if lines:
                lines[-1] += raw_line[1:]
            # 没有上一行时丢弃孤立的续行
        else:
            lines.append(raw_line)
    return lines


def _parse_line(line: str) -> tuple[str, dict[str, str], str] | None:
    """解析一行 vCard：`PROP;PARAM=val;PARAM2=val2:value`。

    返回 (property_name, params_dict, value)。无法解析时返回 None。
    """
    # 分割属性名+参数 和 值（第一个未转义的冒号）
    # 注意：值里可能含冒号，参数值（引号内）也可能含冒号
    in_quotes = False
    colon_idx = -1
    for i, ch in enumerate(line):
        if ch == '"':
            in_quotes = not in_quotes
        elif ch == ":" and not in_quotes:
            colon_idx = i
            break
    if colon_idx < 0:
        return None

    prop_part = line[:colon_idx]
    value = line[colon_idx + 1:]

    # 分割属性名和参数
    parts = prop_part.split(";")
    name = parts[0].upper()
    params: dict[str, str] = {}
    for p in parts[1:]:
        if "=" in p:
            k, _, v = p.partition("=")
            # 去除引号
            v = v.strip('"')
            params[k.upper()] = v
        else:
            # 无值参数（如 vCard 2.1 的 TEL;HOME:...）
            params[p.upper()] = ""

    return name, params, value


def _decode_value(value: str) -> str:
    """解码 vCard 值：反转义逗号/分号/换行。"""
    # vCard 4.0 转义：\, \; \n \\ → , ; \n \
    result = []
    i = 0
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            if nxt == "n" or nxt == "N":
                result.append("\n")
            elif nxt in (",", ";", "\\"):
                result.append(nxt)
            else:
                result.append(value[i])
                result.append(nxt)
            i += 2
        else:
            result.append(value[i])
            i += 1
    return "".join(result)


def parse_vcard(text: str) -> VCard | None:
    """解析单个 vCard 文本，返回 VCard 或 None（非 vCard）。"""
    lines = _unfold_lines(text)
    if not lines or not lines[0].strip().upper().startswith("BEGIN:VCARD"):
        return None

    card = VCard(raw=text)
    # 收集所有 EMAIL，最后按 PREF 排序
    emails_with_pref: list[tuple[int, str]] = []
    phones_with_pref: list[tuple[int, str]] = []

    for line in lines[1:]:  # 跳过 BEGIN
        if line.strip().upper().startswith("END:VCARD"):
            break
        parsed = _parse_line(line)
        if not parsed:
            continue
        name, params, raw_value = parsed

        # 跳过 PHOTO（base64 太大）
        if name == "PHOTO":
            continue

        value = _decode_value(raw_value)

        if name == "UID":
            card.uid = value
        elif name == "FN":
            card.display_name = value
        elif name == "N":
            # N:姓;名;中间名;前缀;后缀
            if not card.display_name:
                parts = value.split(";")
                family = parts[0] if len(parts) > 0 else ""
                given = parts[1] if len(parts) > 1 else ""
                card.display_name = f"{family}{given}".strip()
        elif name == "EMAIL":
            pref = 0
            type_val = params.get("TYPE", "")
            if "PREF" in params:
                try:
                    pref = -int(params["PREF"])
                except ValueError:
                    pref = -1
            elif "pref" in type_val.lower():
                pref = -1
            emails_with_pref.append((pref, value))
        elif name == "TEL":
            pref = 0
            type_val = params.get("TYPE", "")
            if "PREF" in params:
                try:
                    pref = -int(params["PREF"])
                except ValueError:
                    pref = -1
            elif "pref" in type_val.lower():
                pref = -1
            phones_with_pref.append((pref, value))
        elif name == "ORG":
            # ORG:公司;部门
            card.organization = value.split(";")[0]
        elif name == "TITLE":
            card.title = value
        elif name == "NOTE":
            card.note = value
        elif name == "REV":
            card.revision = value

    # 排序：PREF 优先（pref 值越小越优先，用负数表示）
    emails_with_pref.sort(key=lambda x: x[0])
    phones_with_pref.sort(key=lambda x: x[0])
    card.emails = [e for _, e in emails_with_pref]
    card.phones = [p for _, p in phones_with_pref]

    return card


def parse_vcards(text: str) -> list[VCard]:
    """从文本中解析所有 vCard（可能包含多个）。"""
    cards: list[VCard] = []
    # 用 BEGIN:VCARD 分割
    pattern = re.compile(r"^BEGIN:VCARD\s*$", re.IGNORECASE | re.MULTILINE)
    matches = list(pattern.finditer(text))
    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end]
        card = parse_vcard(chunk)
        if card:
            cards.append(card)
    return cards


def to_dict(card: VCard) -> dict[str, Any]:
    """将 VCard 转为前端友好的 dict（与 Rust Contact 结构对齐）。"""
    primary = card.primary_email
    other_emails = [e for e in card.emails if e != primary]
    import json

    return {
        "remoteUid": card.uid,
        "displayName": card.display_name or primary or "(未命名)",
        "email": primary or None,
        "emailList": json.dumps(other_emails) if other_emails else None,
        "phone": card.phones[0] if card.phones else None,
        "organization": card.organization or None,
        "title": card.title or None,
        "note": card.note or None,
        "rawVcard": card.raw,
    }
