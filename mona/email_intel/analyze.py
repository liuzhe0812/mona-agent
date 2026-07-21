"""邮件 AI 分析：一次 LLM 调用产出摘要、关键信息、意图、情绪与紧急度。

设计原则：
- 人工单次触发，不自动介入邮箱
- 一次 LLM 调用产出全部结果，降低成本
- 返回结构化 JSON，由调用方存储
- 支持多模态：邮件图片以 base64 image_url 形式传入 LLM
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Any

from loguru import logger

from mona.providers.base import LLMProvider

# 邮件正文截断上限，避免超出模型上下文
_MAX_BODY_CHARS = 6000

# 单次分析最多传入的图片数量
_MAX_IMAGES = 3

ANALYSIS_PROMPT = """你是一个邮件分析助手。请分析以下邮件并返回 JSON。

邮件主题：{subject}
发件人：{sender}
日期：{date}
正文：
{body}
{image_hint}
请返回以下 JSON 结构（只返回 JSON，不要包含 ```json 标记或其他文字）：
{{
  "summary": "3 句话摘要，概括邮件核心内容",
  "category": "work | personal | finance | notification | marketing | social",
  "intent": "needs_reply | needs_action | notify_only | needs_approval | spam",
  "urgency": "high | normal | low",
  "sentiment": "positive | neutral | negative",
  "key_info": {{
    "dates": [{{"date": "ISO 格式或自然语言", "description": "什么日期"}}],
    "amounts": [{{"value": "金额", "currency": "币种", "context": "上下文"}}],
    "deadlines": [{{"date": "ISO 格式或自然语言", "task": "什么任务"}}],
    "links": [{{"url": "链接", "description": "描述"}}]
  }}
}}

字段说明：
- summary: 3 句话摘要，简洁概括邮件要点（如含图片，需结合图片内容）
- category: 邮件分类
  - work: 工作相关
  - personal: 私人事务
  - finance: 财务/账单/发票
  - notification: 系统通知/验证码/订阅
  - marketing: 营销推广
  - social: 社交网络
- intent: 邮件意图
  - needs_reply: 需要回复
  - needs_action: 需要执行某项操作
  - notify_only: 仅通知
  - needs_approval: 需要审批
  - spam: 垃圾邮件
- urgency: 紧急度（high/normal/low）
- sentiment: 情绪（positive/neutral/negative）
- key_info: 关键信息，没有的字段返回空数组。图片中的金额、日期、链接等也应提取
"""


def _build_sender(from_name: str | None, from_address: str) -> str:
    name = (from_name or "").strip()
    addr = (from_address or "").strip()
    if name and addr:
        return f"{name} <{addr}>"
    return name or addr or "(未知)"


class _HTMLTextExtractor(HTMLParser):
    """简单的 HTML 转纯文本提取器。

    保留块级元素间的换行，忽略 script/style 内容。
    """

    _BLOCK_TAGS = frozenset({
        "p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
        "hr", "table", "section", "article", "header", "footer", "blockquote",
    })

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0  # script/style 内部深度

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("script", "style"):
            self._skip_depth += 1
            return
        if tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if tag in self._BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        self._parts.append(data)

    def get_text(self) -> str:
        text = "".join(self._parts)
        # 折叠多余空白
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def _html_to_text(html: str) -> str:
    """将 HTML 转换为纯文本（保留基本换行结构）。"""
    if not html:
        return ""
    try:
        extractor = _HTMLTextExtractor()
        extractor.feed(html)
        return extractor.get_text()
    except Exception:
        # 解析失败时退化为粗暴的标签移除
        return re.sub(r"<[^>]+>", " ", html).strip()


def _clean_body(body_text: str, body_html: str | None = None) -> str:
    """清理邮件正文：移除引用链、签名，截断过长内容。

    当 body_text 为空但 body_html 有内容时，从 HTML 提取纯文本。
    """
    text = (body_text or "").strip()
    if not text and body_html:
        text = _html_to_text(body_html)

    if not text:
        return "(无正文)"

    lines = []
    for line in text.splitlines():
        # 移除引用行（> 开头）
        if line.strip().startswith(">"):
            continue
        # 遇到签名分隔符停止
        if line.strip() == "--":
            break
        lines.append(line)
    cleaned = "\n".join(lines).strip()
    if not cleaned:
        return "(无正文)"
    if len(cleaned) > _MAX_BODY_CHARS:
        cleaned = cleaned[:_MAX_BODY_CHARS] + "\n...(正文已截断)"
    return cleaned


def _extract_json(content: str) -> dict[str, Any]:
    """从 LLM 返回中提取 JSON。

    模型可能返回纯 JSON，也可能包裹在 ```json ... ``` 中。
    """
    if not content:
        raise ValueError("LLM 返回空内容")
    text = content.strip()

    # 移除可能的 ```json 包裹
    fence_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1).strip()

    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 尝试找到第一个 { 到最后一个 } 之间的内容
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass

    raise ValueError(f"无法从 LLM 返回中解析 JSON: {content[:200]}")


def _normalize_result(raw: dict[str, Any]) -> dict[str, Any]:
    """规范化分析结果，确保字段完整且类型正确。

    keyInfo 被序列化为 JSON 字符串，便于 Rust/前端按字符串存储和解析。
    """
    key_info = raw.get("key_info") or {}
    if not isinstance(key_info, dict):
        key_info = {}

    def _ensure_list(val: Any) -> list[Any]:
        if isinstance(val, list):
            return val
        return []

    key_info_obj = {
        "dates": _ensure_list(key_info.get("dates")),
        "amounts": _ensure_list(key_info.get("amounts")),
        "deadlines": _ensure_list(key_info.get("deadlines")),
        "links": _ensure_list(key_info.get("links")),
    }

    return {
        "summary": str(raw.get("summary") or "").strip() or "(无摘要)",
        "category": str(raw.get("category") or "notification").strip().lower(),
        "intent": str(raw.get("intent") or "notify_only").strip().lower(),
        "urgency": str(raw.get("urgency") or "normal").strip().lower(),
        "sentiment": str(raw.get("sentiment") or "neutral").strip().lower(),
        "keyInfo": json.dumps(key_info_obj, ensure_ascii=False),
    }


async def analyze_email(
    provider: LLMProvider,
    *,
    subject: str,
    from_address: str,
    from_name: str | None,
    date: str,
    body_text: str,
    body_html: str | None = None,
    images: list[dict[str, str]] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """分析单封邮件，返回结构化结果。

    一次 LLM 调用产出：摘要、分类、意图、紧急度、情绪、关键信息。
    支持多模态：images 中的图片以 base64 image_url 形式传入 LLM。

    Args:
        provider: LLM provider 实例
        subject: 邮件主题
        from_address: 发件人邮箱
        from_name: 发件人名称（可选）
        date: 邮件日期（ISO 格式字符串）
        body_text: 邮件纯文本正文
        body_html: 邮件 HTML 正文（可选，当 body_text 为空时从中提取文本）
        images: 图片列表，每项 {"data": base64(无前缀), "mime": "image/png"}，
                最多 _MAX_IMAGES 张，超出截断
        model: 指定模型（None 用 provider 默认）

    Returns:
        规范化后的分析结果 dict，字段：
        summary, category, intent, urgency, sentiment, keyInfo
    """
    sender = _build_sender(from_name, from_address)
    body = _clean_body(body_text, body_html)

    # 构造图片提示
    valid_images: list[dict[str, str]] = []
    if images:
        for img in images[:_MAX_IMAGES]:
            data = (img.get("data") or "").strip()
            mime = (img.get("mime") or "image/png").strip()
            if data:
                valid_images.append({"data": data, "mime": mime})

    if valid_images:
        image_hint = f"\n（本邮件含 {len(valid_images)} 张图片，已附在消息中，请结合图片内容分析）\n"
    else:
        image_hint = "\n"

    prompt = ANALYSIS_PROMPT.format(
        subject=subject or "(无主题)",
        sender=sender,
        date=date or "(未知)",
        body=body,
        image_hint=image_hint,
    )

    logger.debug(
        "Email analyze: subject={!r} body_len={} images={}",
        subject[:50] if subject else "",
        len(body),
        len(valid_images),
    )

    # 构造多模态 content：图片在前，文本在后（与 agent context 一致）
    if valid_images:
        content: Any = []
        for img in valid_images:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:{img['mime']};base64,{img['data']}"},
            })
        content.append({"type": "text", "text": prompt})
        messages = [{"role": "user", "content": content}]
    else:
        messages = [{"role": "user", "content": prompt}]

    response = await provider.chat(
        messages=messages,
        model=model,
        max_tokens=1024,
        temperature=0.3,
    )

    content = response.content or ""
    raw = _extract_json(content)
    result = _normalize_result(raw)

    logger.debug(
        "Email analyze done: category={} intent={} urgency={}",
        result["category"],
        result["intent"],
        result["urgency"],
    )

    return result
