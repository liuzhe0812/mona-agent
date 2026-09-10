"""Verified bindings between materials-library PDFs and stock instruments.

This module is deliberately a persistence and validation boundary only.  It
does not extract facts from a report and it does not make the material
available to Evidence until a user explicitly confirms the binding.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from mona.config.schema import Base
from mona.materials.frontmatter import _parse_frontmatter
from mona.materials.index import _parse_text_document
from mona.services.stock.provenance import SourceRecord, normalize_asia_datetime

SCHEMA_VERSION = 1
REPORT_TYPE = "financial_report"
_MATERIAL_ID_RE = re.compile(r"^material-[A-Za-z0-9][A-Za-z0-9._-]*$")
_INSTRUMENT_ID_RE = re.compile(r"^(XSHG|XSHE|BJSE):\d{6}$")
_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NUMERIC_TEXT_RE = re.compile(
    r"^(?:[+-]?(?:(?:\d{1,3}(?:[,，]\d{3})+)|\d+)(?:\.\d+)?%?|\(\s*"
    r"(?:(?:\d{1,3}(?:[,，]\d{3})+)|\d+)(?:\.\d+)?%?\))$"
)
_NUMERIC_TOKEN_RE = re.compile(
    r"(?<![\d.])(?:[+-]?\(?\s*\d[\d\s,，]*(?:\.\d+)?%?\)?)(?![\d.])"
)
_MAX_CONFIRMED_FACTS = 7
CONFIRMED_METRIC_LABELS = {
    "revenue": "营业收入",
    "net_profit": "归母净利润",
    "operating_cash_flow": "经营活动现金流净额",
    "total_assets": "总资产",
    "total_liabilities": "总负债",
    "parent_equity": "归属于母公司所有者权益",
    "basic_eps": "基本每股收益",
}
CONFIRMED_UNIT_LABELS = {
    "yuan": "元",
    "ten_thousand_yuan": "万元",
    "hundred_million_yuan": "亿元",
    "yuan_per_share": "元/股",
}
_METRIC_ALIASES = {
    **{key: key for key in CONFIRMED_METRIC_LABELS},
    **{label: key for key, label in CONFIRMED_METRIC_LABELS.items()},
}
_UNIT_ALIASES = {
    **{key: key for key in CONFIRMED_UNIT_LABELS},
    **{label: key for key, label in CONFIRMED_UNIT_LABELS.items()},
    "元每股": "yuan_per_share",
}
_ERROR_LABELS = {
    "extraction_not_ready": "等待提取",
    "extraction_failed": "提取失败",
    "extraction_unsupported": "格式不支持",
    "scan_without_text": "没有可验证文本",
    "file_changed": "文件已变化",
    "file_missing": "文件不存在",
    "source_missing": "缺少原始文件",
    "not_pdf": "不是 PDF 财报",
}
_BINDING_LABELS = {
    "pending": "待用户确认",
    "confirmed": "已确认",
    "invalidated": "已失效",
}


class MaterialBindingError(ValueError):
    """A binding cannot be used as verified Evidence."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ConfirmedFinancialFact(Base):
    """One financial value manually checked against a selected PDF page."""

    metric: Literal[
        "revenue",
        "net_profit",
        "operating_cash_flow",
        "total_assets",
        "total_liabilities",
        "parent_equity",
        "basic_eps",
    ]
    value_text: str = Field(min_length=1, max_length=128)
    unit: Literal[
        "yuan",
        "ten_thousand_yuan",
        "hundred_million_yuan",
        "yuan_per_share",
    ]
    page: int = Field(gt=0)
    excerpt: str = Field(min_length=1, max_length=2000)

    @field_validator("value_text")
    @classmethod
    def _check_value_text(cls, value: str) -> str:
        value = value.strip()
        if not value or not _NUMERIC_TEXT_RE.fullmatch(value):
            raise ValueError("数值文本必须是可核对的数字")
        return value

    @field_validator("excerpt")
    @classmethod
    def _check_excerpt(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 and char not in "\n\r\t" for char in value):
            raise ValueError("原文摘录不能为空")
        return value

    @model_validator(mode="after")
    def _check_metric_unit(self) -> "ConfirmedFinancialFact":
        if self.metric == "basic_eps" and self.unit != "yuan_per_share":
            raise ValueError("基本每股收益只能使用元/股")
        if self.metric != "basic_eps" and self.unit == "yuan_per_share":
            raise ValueError("当前指标不支持该单位")
        return self


class MaterialBinding(Base):
    """One user-confirmable PDF binding stored in the materials workspace."""

    schema_version: Literal[1] = SCHEMA_VERSION
    binding_id: str = Field(pattern=r"^binding_[0-9a-f]{32}$")
    material_id: str = Field(pattern=r"^material-[A-Za-z0-9][A-Za-z0-9._-]*$")
    instrument_id: str = Field(pattern=r"^(XSHG|XSHE|BJSE):\d{6}$")
    report_type: Literal["financial_report"] = REPORT_TYPE
    report_period: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    first_published_at: str
    publisher: str = Field(min_length=1, max_length=200)
    file_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    pages: list[int] = Field(min_length=1)
    page_text_hashes: dict[str, str] = Field(default_factory=dict)
    confirmed_facts: list[ConfirmedFinancialFact] = Field(
        default_factory=list,
        max_length=_MAX_CONFIRMED_FACTS,
    )
    user_confirmed: bool = False
    confirmed_at: str | None = None
    status: Literal["pending", "confirmed", "invalidated"] = "pending"
    invalidated_at: str | None = None
    invalidation_reason: str | None = None
    created_at: str

    @field_validator("material_id")
    @classmethod
    def _check_material_id(cls, value: str) -> str:
        if not _MATERIAL_ID_RE.fullmatch(value):
            raise ValueError("invalid material_id")
        return value

    @field_validator("instrument_id")
    @classmethod
    def _check_instrument_id(cls, value: str) -> str:
        if not _INSTRUMENT_ID_RE.fullmatch(value):
            raise ValueError("invalid instrument_id")
        return value

    @field_validator("report_period")
    @classmethod
    def _check_report_period(cls, value: str) -> str:
        if not _DATE_RE.fullmatch(value):
            raise ValueError("report_period must be YYYY-MM-DD")
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("report_period is not a real date") from exc
        return value

    @field_validator("first_published_at", "created_at", "confirmed_at", "invalidated_at")
    @classmethod
    def _check_timestamps(cls, value: str | None) -> str | None:
        if value is None:
            return value
        normalized = normalize_asia_datetime(value)
        if normalized is None:
            raise ValueError("timestamp is invalid")
        return normalized

    @field_validator("publisher")
    @classmethod
    def _check_publisher(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("publisher is invalid")
        return value

    @field_validator("pages")
    @classmethod
    def _check_pages(cls, value: list[int]) -> list[int]:
        if not value or any(isinstance(page, bool) or page <= 0 for page in value):
            raise ValueError("pages must be positive integers")
        if len(set(value)) != len(value):
            raise ValueError("pages must not contain duplicates")
        return sorted(value)

    @model_validator(mode="after")
    def _check_state(self) -> "MaterialBinding":
        if self.status == "confirmed" and not self.user_confirmed:
            raise ValueError("confirmed binding must have user_confirmed=true")
        if self.status == "confirmed" and not self.confirmed_at:
            raise ValueError("confirmed binding must have confirmed_at")
        # An invalidated record retains the original confirmation timestamp
        # as audit history; pending records must not claim confirmation.
        if self.status == "pending" and self.confirmed_at:
            raise ValueError("pending binding must not have confirmed_at")
        if self.status == "invalidated" and not self.invalidation_reason:
            raise ValueError("invalidated binding must have invalidation_reason")
        try:
            published = datetime.fromisoformat(self.first_published_at)
        except ValueError as exc:
            raise ValueError("首次公开时间格式无效") from exc
        if datetime.strptime(self.report_period, "%Y-%m-%d").date() > published.date():
            raise ValueError("报告期不能晚于首次公开日期")
        return self


class MaterialBindingStore:
    """Persist and verify stock material bindings inside one materials vault."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = Path(workspace).expanduser().resolve()
        materials_base = self.workspace / ".mona" / "materials"
        default_library = materials_base / "libraries" / "kb-default"
        self.materials_root = default_library if default_library.exists() else materials_base
        self.text_root = self.materials_root / "text"
        self.raw_root = self.materials_root / "raw"
        self.path = materials_base / "stock-bindings.json"

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    def create_pending(
        self,
        *,
        material_id: str,
        instrument_id: str,
        report_period: str | None,
        first_published_at: str | None,
        publisher: str,
        pages: list[int] | tuple[int, ...] | range,
    ) -> MaterialBinding:
        """Create a pending binding after verifying the real PDF and pages.

        ``report_period`` and ``first_published_at`` are explicit user inputs;
        this method never infers them from a title or extracted text.
        """
        if not report_period:
            raise MaterialBindingError("missing_report_period", "缺少报告期，不能建立材料绑定")
        if not isinstance(report_period, str) or not _DATE_RE.fullmatch(report_period):
            raise MaterialBindingError("invalid_report_period", "报告期必须是有效日期")
        try:
            datetime.strptime(report_period, "%Y-%m-%d")
        except ValueError as exc:
            raise MaterialBindingError("invalid_report_period", "报告期必须是有效日期") from exc
        if not first_published_at:
            raise MaterialBindingError("missing_first_published_at", "缺少首次公开时间，不能建立材料绑定")
        if not isinstance(instrument_id, str) or not _INSTRUMENT_ID_RE.fullmatch(instrument_id):
            raise MaterialBindingError("invalid_instrument_id", "股票代码格式无效")
        if not isinstance(publisher, str) or not publisher.strip():
            raise MaterialBindingError("invalid_publisher", "发布机构不能为空")
        source = self._load_source(material_id)
        normalized_pages = _normalize_pages(pages)
        page_texts = self._validate_pages(source, normalized_pages)
        normalized_published_at = normalize_asia_datetime(first_published_at)
        if normalized_published_at is None:
            raise MaterialBindingError("invalid_first_published_at", "首次公开时间格式无效")
        _validate_report_publication_date(report_period, normalized_published_at)
        binding = MaterialBinding(
            binding_id=f"binding_{uuid.uuid4().hex}",
            material_id=material_id,
            instrument_id=instrument_id,
            report_type=REPORT_TYPE,
            report_period=report_period,
            first_published_at=normalized_published_at,
            publisher=publisher,
            file_hash=source["file_hash"],
            pages=normalized_pages,
            page_text_hashes=_page_text_hashes(page_texts),
            user_confirmed=False,
            status="pending",
            created_at=normalize_asia_datetime(datetime.now().astimezone()),
        )
        # Validate the page extraction before writing.  The result is not a
        # financial fact; it is only used to prove the selected pages exist.
        if not page_texts:
            raise MaterialBindingError("no_text", "确认页没有可用文本")
        data = self._load_data()
        data["bindings"].append(binding.model_dump(mode="json", by_alias=True))
        self._save_data(data)
        return binding

    def confirm(
        self,
        binding_id: str,
        confirmed_facts: list[dict[str, Any]] | None = None,
    ) -> MaterialBinding:
        """Explicitly confirm a pending binding after rechecking its source."""
        return self._confirm(binding_id, confirmed_facts=confirmed_facts)

    def _confirm(
        self,
        binding_id: str,
        *,
        confirmed_facts: list[dict[str, Any]] | None,
    ) -> MaterialBinding:
        """Confirm a binding, optionally persisting user-verified values."""
        binding = self._get(binding_id, refresh=False)
        if binding.status == "invalidated":
            raise MaterialBindingError("invalidated", "材料文件已失效，需重新建立绑定")
        try:
            source = self._load_source(binding.material_id)
        except MaterialBindingError as exc:
            if exc.code in {"file_changed", "file_missing", "extraction_failed", "scan_without_text"}:
                self._invalidate(binding, exc.message)
            raise
        if source["file_hash"] != binding.file_hash:
            self._invalidate(binding, "文件哈希变化")
            raise MaterialBindingError("file_changed", "材料文件哈希已变化，不能确认")
        try:
            page_texts = self._validate_pages(source, binding.pages)
            self._validate_page_text_stability(binding, page_texts)
        except MaterialBindingError as exc:
            if binding.status == "confirmed" and exc.code in {
                "page_text_changed",
                "page_out_of_range",
                "page_without_text",
            }:
                self._invalidate(binding, exc.message)
            raise
        if binding.status == "confirmed" and not _confirmed_facts_match(
            binding.confirmed_facts,
            confirmed_facts,
        ):
            raise MaterialBindingError(
                "already_confirmed",
                "材料已确认，关键财务数据不可直接修改，请重新建立绑定",
            )
        normalized_facts = self._normalize_confirmed_facts(
            confirmed_facts,
            page_texts,
            selected_pages=binding.pages,
        )
        if binding.status == "confirmed":
            if binding.confirmed_facts != normalized_facts:
                raise MaterialBindingError(
                    "already_confirmed",
                    "材料已确认，关键财务数据不可直接修改，请重新建立绑定",
                )
            return binding
        confirmed = binding.model_copy(
            update={
                "user_confirmed": True,
                "status": "confirmed",
                "confirmed_facts": normalized_facts,
                "confirmed_at": normalize_asia_datetime(datetime.now().astimezone()),
                "invalidated_at": None,
                "invalidation_reason": None,
            }
        )
        data = self._load_data()
        self._replace(data, confirmed)
        self._save_data(data)
        return confirmed

    def get(self, binding_id: str) -> MaterialBinding:
        """Read one binding and automatically invalidate stale confirmed data."""
        return self._get(binding_id, refresh=True)

    def list(self) -> list[MaterialBinding]:
        """Read all bindings, preserving invalidated records for audit."""
        data = self._load_data()
        changed = False
        result: list[MaterialBinding] = []
        for item in data["bindings"]:
            binding = self._parse_binding(item)
            if binding.status == "confirmed":
                try:
                    source = self._load_source(binding.material_id)
                    page_texts = self._validate_pages(source, binding.pages)
                    self._validate_page_text_stability(binding, page_texts)
                    if source["file_hash"] != binding.file_hash:
                        raise MaterialBindingError("file_changed", "文件哈希变化")
                except MaterialBindingError as exc:
                    binding = self._invalidated_copy(binding, exc.message)
                    self._replace(data, binding)
                    changed = True
            result.append(binding)
        if changed:
            self._save_data(data)
        return result

    def list_available(self, instrument_id: str | None = None) -> list[dict[str, Any]]:
        """List real PDF materials and their binding state for one stock."""
        if instrument_id is not None and (
            not isinstance(instrument_id, str)
            or not _INSTRUMENT_ID_RE.fullmatch(instrument_id)
        ):
            raise MaterialBindingError("invalid_instrument_id", "股票代码格式无效")
        bindings = [
            binding
            for binding in self.list()
            if instrument_id is None or binding.instrument_id == instrument_id
        ]
        by_material: dict[str, list[MaterialBinding]] = {}
        for binding in bindings:
            by_material.setdefault(binding.material_id, []).append(binding)
        rows: list[dict[str, Any]] = []
        if not self.text_root.exists():
            return rows
        for text_path in sorted(self.text_root.rglob("*.md")):
            try:
                content = text_path.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, _ = _parse_frontmatter(content)
            material_id = fm.get("id")
            if not isinstance(material_id, str) or not _MATERIAL_ID_RE.fullmatch(material_id):
                continue
            source_rel = fm.get("source")
            source_rel = (
                source_rel.removeprefix("raw/").replace("\\", "/")
                if isinstance(source_rel, str)
                else ""
            )
            if not source_rel.lower().endswith(".pdf"):
                continue
            status_code = "ready"
            status_label = "已完成"
            page_count = 0
            material_name = Path(source_rel).name or text_path.name.removesuffix(".md")
            try:
                source = self._load_source(material_id)
                page_count = len(source["pages"])
            except MaterialBindingError as exc:
                status_code = exc.code
                status_label = _ERROR_LABELS.get(exc.code, "不可用")
                # Count only structurally valid page markers; never turn their
                # text into a financial fact or a confirmed source.
                _fm, segments = _parse_text_document(content)
                page_count = len({
                    meta.get("page")
                    for meta, _text in segments
                    if isinstance(meta.get("page"), int)
                    and not isinstance(meta.get("page"), bool)
                })
            rows.append(
                {
                    "material_id": material_id,
                    "material_name": material_name,
                    "extraction_status": status_code,
                    "extraction_status_label": status_label,
                    "page_count": page_count,
                    "bindings": [
                        {
                            "binding_id": binding.binding_id,
                            "status": binding.status,
                            "status_label": _BINDING_LABELS[binding.status],
                            "report_period": binding.report_period,
                            "first_published_at": binding.first_published_at,
                            "publisher": binding.publisher,
                            "pages": binding.pages,
                            "confirmed_facts": [
                                fact.model_dump(mode="json")
                                for fact in binding.confirmed_facts
                            ],
                            "confirmed_at": binding.confirmed_at,
                            "invalidation_reason": binding.invalidation_reason,
                        }
                        for binding in by_material.get(material_id, [])
                    ],
                }
            )
        return rows

    def confirmed_binding_ids(self, instrument_id: str) -> list[str]:
        """Return only currently valid, user-confirmed binding IDs."""
        return [
            binding.binding_id
            for binding in self.list()
            if binding.instrument_id == instrument_id and binding.status == "confirmed"
        ]

    def confirmed_projections(
        self,
        binding_ids: list[str],
        *,
        instrument_id: str,
        research_cutoff_at: str | None = None,
    ) -> list[dict[str, Any]]:
        """Re-read and validate a bounded set of confirmed material pages."""
        if not isinstance(binding_ids, list) or not binding_ids:
            raise MaterialBindingError("invalid_binding_ids", "材料绑定记录编号必须是非空数组")
        if len(binding_ids) > 8:
            raise MaterialBindingError("too_many_bindings", "一次投研最多绑定 8 份财报材料")
        if len(set(binding_ids)) != len(binding_ids):
            raise MaterialBindingError("duplicate_binding_ids", "材料绑定记录编号不能重复")
        projections: list[dict[str, Any]] = []
        for binding_id in binding_ids:
            if not isinstance(binding_id, str) or not re.fullmatch(
                r"binding_[0-9a-f]{32}", binding_id
            ):
                raise MaterialBindingError("invalid_binding_id", "材料绑定记录编号格式无效")
            projection = self.evidence_projection(
                binding_id,
                research_cutoff_at=research_cutoff_at,
            )
            if projection.get("instrument_id") != instrument_id:
                raise MaterialBindingError(
                    "instrument_mismatch", "材料绑定与本次投研股票不一致"
                )
            projections.append(projection)
        return projections

    def evidence_projection(
        self,
        binding_id: str,
        *,
        research_cutoff_at: str | None = None,
    ) -> dict[str, Any]:
        """Return only confirmed page text plus verifiable provenance data."""
        binding = self.get(binding_id)
        if binding.status == "invalidated":
            raise MaterialBindingError(
                "invalidated",
                f"材料绑定已失效：{binding.invalidation_reason or '来源不可验证'}",
            )
        if binding.status != "confirmed" or not binding.user_confirmed:
            raise MaterialBindingError("not_confirmed", "材料尚未获得用户确认，不能进入证据")
        _validate_material_cutoff(binding.first_published_at, research_cutoff_at)
        source = self._load_source(binding.material_id)
        if source["file_hash"] != binding.file_hash:
            self._invalidate(binding, "文件哈希变化")
            raise MaterialBindingError("file_changed", "材料文件哈希已变化，不能进入证据")
        pages = self._validate_pages(source, binding.pages)
        self._validate_page_text_stability(binding, pages)
        source_record = SourceRecord.create(
            provider=binding.publisher,
            url=f"materials://{binding.material_id}",
            body=source["raw_bytes"],
            fields=["page_text", "page"],
            published_at=binding.first_published_at,
            period_end=binding.report_period,
        )
        page_records = [
            _page_projection(
                binding=binding,
                source_record=source_record,
                material_name=source["raw_path"].name,
                page=page,
                text=text,
            )
            for page, text in pages.items()
        ]
        page_source_ids = {
            page_record["page"]: page_record["source_id"]
            for page_record in page_records
        }
        confirmed_facts = [
            _confirmed_fact_projection(
                fact,
                binding=binding,
                source_id=page_source_ids[fact.page],
            )
            for fact in binding.confirmed_facts
        ]
        return {
            "schema_version": SCHEMA_VERSION,
            "binding_id": binding.binding_id,
            "material_id": binding.material_id,
            "instrument_id": binding.instrument_id,
            "report_type": binding.report_type,
            "report_period": binding.report_period,
            "first_published_at": binding.first_published_at,
            "material_name": page_records[0]["material_name"] if page_records else binding.material_id,
            "confirmed_facts": confirmed_facts,
            "pages": page_records,
        }

    @staticmethod
    def _normalize_confirmed_facts(
        raw_facts: list[dict[str, Any]] | None,
        page_texts: dict[int, str],
        *,
        selected_pages: list[int],
    ) -> list[ConfirmedFinancialFact]:
        if raw_facts is None:
            raw_facts = []
        if not isinstance(raw_facts, list):
            raise MaterialBindingError("invalid_confirmed_facts", "关键财务数据必须是数组")
        if len(raw_facts) > _MAX_CONFIRMED_FACTS:
            raise MaterialBindingError(
                "too_many_confirmed_facts",
                f"关键财务数据最多填写 {_MAX_CONFIRMED_FACTS} 项",
            )
        normalized: list[ConfirmedFinancialFact] = []
        seen_metrics: set[str] = set()
        for index, raw in enumerate(raw_facts, start=1):
            if not isinstance(raw, dict):
                raise MaterialBindingError(
                    "invalid_confirmed_fact",
                    f"第 {index} 项关键财务数据格式无效",
                )
            metric_raw = (
                raw.get("metric")
                or raw.get("metricCode")
                or raw.get("metric_code")
                or raw.get("metricName")
            )
            unit_raw = raw.get("unit") or raw.get("unitCode") or raw.get("unit_code")
            value_text = (
                raw.get("valueText")
                if "valueText" in raw
                else raw.get("value_text", raw.get("rawValue", raw.get("raw_value")))
            )
            page = raw.get("page", raw.get("pageNumber"))
            excerpt = (
                raw.get("excerpt")
                if "excerpt" in raw
                else raw.get("originalExcerpt", raw.get("original_excerpt"))
            )
            metric = _METRIC_ALIASES.get(metric_raw) if isinstance(metric_raw, str) else None
            unit = _UNIT_ALIASES.get(unit_raw) if isinstance(unit_raw, str) else None
            if metric is None:
                raise MaterialBindingError(
                    "unknown_confirmed_metric",
                    f"第 {index} 项关键财务数据的指标不受支持",
                )
            if unit is None:
                raise MaterialBindingError(
                    "unknown_confirmed_unit",
                    f"第 {index} 项关键财务数据的单位不受支持",
                )
            if metric == "basic_eps" and unit != "yuan_per_share":
                raise MaterialBindingError(
                    "metric_unit_mismatch",
                    f"第 {index} 项基本每股收益只能使用元/股",
                )
            if metric != "basic_eps" and unit == "yuan_per_share":
                raise MaterialBindingError(
                    "metric_unit_mismatch",
                    f"第 {index} 项{CONFIRMED_METRIC_LABELS[metric]}不能使用元/股",
                )
            if metric in seen_metrics:
                raise MaterialBindingError(
                    "duplicate_confirmed_metric",
                    f"关键财务数据不能重复填写{CONFIRMED_METRIC_LABELS[metric]}",
                )
            try:
                fact = ConfirmedFinancialFact(
                    metric=metric,
                    value_text=value_text,
                    unit=unit,
                    page=page,
                    excerpt=excerpt,
                )
            except Exception as exc:
                raise MaterialBindingError(
                    "invalid_confirmed_fact",
                    f"第 {index} 项关键财务数据格式无效，请检查数值、页码和原文摘录",
                ) from exc
            if fact.page not in selected_pages or fact.page not in page_texts:
                raise MaterialBindingError(
                    "fact_page_not_selected",
                    f"第 {index} 项关键财务数据的页码不在本次确认页范围内",
                )
            page_text = page_texts[fact.page]
            if _compact_text(fact.excerpt) not in _compact_text(page_text):
                raise MaterialBindingError(
                    "excerpt_not_found",
                    f"第 {index} 项关键财务数据的原文摘录不在第 {fact.page} 页中",
                )
            if not _excerpt_has_numeric_value(fact.value_text, fact.excerpt):
                raise MaterialBindingError(
                    "value_not_in_excerpt",
                    f"第 {index} 项关键财务数据的数值未出现在原文摘录中",
                )
            if not _unit_in_excerpt(unit, fact.excerpt):
                raise MaterialBindingError(
                    "unit_not_in_excerpt",
                    f"第 {index} 项关键财务数据的单位未出现在原文摘录中",
                )
            if "%" in _compact_number(fact.value_text):
                raise MaterialBindingError(
                    "unit_mismatch",
                    f"第 {index} 项关键财务数据的数值与单位不一致",
                )
            seen_metrics.add(metric)
            normalized.append(fact)
        return sorted(normalized, key=lambda item: item.metric)

    # ------------------------------------------------------------------
    # Source validation
    # ------------------------------------------------------------------

    def _load_source(self, material_id: str) -> dict[str, Any]:
        if not isinstance(material_id, str) or not _MATERIAL_ID_RE.fullmatch(material_id):
            raise MaterialBindingError("invalid_material_id", "资料编号格式无效")
        matches: list[tuple[Path, dict[str, Any], str]] = []
        if not self.text_root.exists():
            raise MaterialBindingError("material_not_found", "资料库中不存在该材料")
        for text_path in sorted(self.text_root.rglob("*.md")):
            try:
                content = text_path.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, body = _parse_frontmatter(content)
            if fm.get("id") == material_id:
                matches.append((text_path, fm, content))
        if not matches:
            raise MaterialBindingError("material_not_found", "资料库中不存在该材料")
        if len(matches) != 1:
            raise MaterialBindingError("material_ambiguous", "资料编号对应多个提取文件")
        text_path, fm, content = matches[0]
        if fm.get("status") == "unsupported":
            raise MaterialBindingError("extraction_unsupported", "材料格式不支持文本提取")
        if fm.get("status") == "error" or fm.get("error"):
            raise MaterialBindingError("extraction_failed", "材料提取失败，无法验证或预览文本")
        if fm.get("status") != "ok":
            raise MaterialBindingError("extraction_not_ready", "材料尚未完成文本提取")
        source_rel = fm.get("source")
        if not isinstance(source_rel, str) or not source_rel.strip():
            raise MaterialBindingError("source_missing", "材料缺少原始文件路径")
        source_rel = source_rel.removeprefix("raw/").replace("\\", "/")
        if not _safe_relative(source_rel):
            raise MaterialBindingError("invalid_source_path", "材料原始文件路径无效")
        raw_path = (self.raw_root / source_rel).resolve()
        try:
            raw_path.relative_to(self.raw_root.resolve())
        except ValueError as exc:
            raise MaterialBindingError("cross_workspace", "材料路径不在当前工作区") from exc
        if raw_path.suffix.lower() != ".pdf":
            raise MaterialBindingError("not_pdf", "当前只允许绑定 PDF 财报")
        try:
            raw_bytes = raw_path.read_bytes()
        except OSError as exc:
            raise MaterialBindingError("file_missing", "材料原始文件不存在或无法读取") from exc
        actual_hash = hashlib.sha256(raw_bytes).hexdigest()
        recorded_hash = fm.get("sha256")
        if not isinstance(recorded_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", recorded_hash):
            raise MaterialBindingError("extraction_metadata_invalid", "材料缺少有效文件哈希")
        if actual_hash != recorded_hash:
            raise MaterialBindingError("file_changed", "材料文件哈希已变化，请重新提取")
        _fm, segments = _parse_text_document(content)
        page_texts: dict[int, str] = {}
        for meta, text in segments:
            page = meta.get("page")
            if isinstance(page, bool) or not isinstance(page, int) or page <= 0:
                continue
            if page in page_texts:
                raise MaterialBindingError("extraction_invalid", "材料页码提取结果重复")
            page_texts[page] = _clean_segment_text(text)
        if not page_texts or not any(page_texts.values()):
            raise MaterialBindingError("scan_without_text", "材料没有可验证文本，可能是扫描件")
        return {
            "material_id": material_id,
            "raw_path": raw_path,
            "raw_bytes": raw_bytes,
            "file_hash": f"sha256:{actual_hash}",
            "pages": page_texts,
        }

    @staticmethod
    def _validate_pages(source: dict[str, Any], pages: list[int]) -> dict[int, str]:
        page_texts = source["pages"]
        selected: dict[int, str] = {}
        for page in pages:
            if page not in page_texts:
                raise MaterialBindingError("page_out_of_range", f"确认页码不存在：第 {page} 页")
            text = page_texts[page]
            if not text.strip():
                raise MaterialBindingError("page_without_text", f"第 {page} 页没有可验证文本")
            selected[page] = text
        return selected

    @staticmethod
    def _validate_page_text_stability(
        binding: MaterialBinding,
        page_texts: dict[int, str],
    ) -> None:
        if not binding.page_text_hashes:
            return
        current = _page_text_hashes(page_texts)
        for page in binding.pages:
            expected = binding.page_text_hashes.get(str(page))
            if expected is not None and current.get(str(page)) != expected:
                raise MaterialBindingError(
                    "page_text_changed",
                    f"第 {page} 页提取文本已变化，材料绑定和已确认数据已失效",
                )

    # ------------------------------------------------------------------
    # Persistence and audit helpers
    # ------------------------------------------------------------------

    def _load_data(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schema_version": SCHEMA_VERSION, "bindings": []}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise MaterialBindingError("store_corrupt", "材料绑定记录无法读取") from exc
        if (
            not isinstance(payload, dict)
            or payload.get("schema_version") != SCHEMA_VERSION
            or not isinstance(payload.get("bindings"), list)
        ):
            raise MaterialBindingError("store_corrupt", "材料绑定记录格式无效")
        return payload

    @staticmethod
    def _parse_binding(value: Any) -> MaterialBinding:
        try:
            return MaterialBinding.model_validate(value)
        except Exception as exc:
            raise MaterialBindingError("store_corrupt", "材料绑定记录包含非法字段") from exc

    def _get(self, binding_id: str, *, refresh: bool) -> MaterialBinding:
        if not isinstance(binding_id, str) or not re.fullmatch(r"binding_[0-9a-f]{32}", binding_id):
            raise MaterialBindingError("invalid_binding_id", "绑定记录编号格式无效")
        data = self._load_data()
        for item in data["bindings"]:
            binding = self._parse_binding(item)
            if binding.binding_id != binding_id:
                continue
            if refresh and binding.status == "confirmed":
                try:
                    source = self._load_source(binding.material_id)
                    page_texts = self._validate_pages(source, binding.pages)
                    self._validate_page_text_stability(binding, page_texts)
                    if source["file_hash"] != binding.file_hash:
                        raise MaterialBindingError("file_changed", "文件哈希变化")
                except MaterialBindingError as exc:
                    invalidated = self._invalidated_copy(binding, exc.message)
                    self._replace(data, invalidated)
                    self._save_data(data)
                    return invalidated
            return binding
        raise MaterialBindingError("binding_not_found", "不存在该材料绑定")

    def _invalidate(self, binding: MaterialBinding, reason: str) -> MaterialBinding:
        data = self._load_data()
        invalidated = self._invalidated_copy(binding, reason)
        self._replace(data, invalidated)
        self._save_data(data)
        return invalidated

    @staticmethod
    def _invalidated_copy(binding: MaterialBinding, reason: str) -> MaterialBinding:
        return binding.model_copy(
            update={
                "status": "invalidated",
                "invalidation_reason": reason,
                "invalidated_at": normalize_asia_datetime(datetime.now().astimezone()),
            }
        )

    @staticmethod
    def _replace(data: dict[str, Any], binding: MaterialBinding) -> None:
        for index, item in enumerate(data["bindings"]):
            if item.get("bindingId") == binding.binding_id or item.get("binding_id") == binding.binding_id:
                data["bindings"][index] = binding.model_dump(mode="json", by_alias=True)
                return
        raise MaterialBindingError("binding_not_found", "不存在该材料绑定")

    def _save_data(self, data: dict[str, Any]) -> None:
        self.materials_root.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix="stock-bindings-", suffix=".tmp", dir=self.materials_root
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
        except Exception:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise


def _normalize_pages(pages: list[int] | tuple[int, ...] | range) -> list[int]:
    if isinstance(pages, range):
        values = list(pages)
    elif isinstance(pages, (list, tuple)):
        values = list(pages)
    else:
        raise MaterialBindingError("invalid_pages", "确认页码必须是正整数列表")
    if not values or any(isinstance(page, bool) or not isinstance(page, int) or page <= 0 for page in values):
        raise MaterialBindingError("invalid_pages", "确认页码必须是正整数列表")
    if len(set(values)) != len(values):
        raise MaterialBindingError("invalid_pages", "确认页码不能重复")
    return sorted(values)


def _validate_report_publication_date(report_period: str, first_published_at: str) -> None:
    try:
        report_date = datetime.strptime(report_period, "%Y-%m-%d").date()
        published_date = datetime.fromisoformat(first_published_at).date()
    except (TypeError, ValueError) as exc:
        raise MaterialBindingError("invalid_publication_date", "报告期或首次公开时间格式无效") from exc
    if report_date > published_date:
        raise MaterialBindingError("report_period_after_publication", "报告期不能晚于首次公开日期")


def _validate_material_cutoff(
    first_published_at: str,
    research_cutoff_at: str | None,
) -> None:
    if research_cutoff_at is None:
        return
    normalized_cutoff = normalize_asia_datetime(research_cutoff_at)
    normalized_published = normalize_asia_datetime(first_published_at)
    if normalized_cutoff is None:
        raise MaterialBindingError("invalid_research_cutoff", "本次研究截止时间格式无效")
    if normalized_published is None:
        raise MaterialBindingError("invalid_first_published_at", "首次公开时间格式无效")
    try:
        published = datetime.fromisoformat(normalized_published)
        cutoff = datetime.fromisoformat(normalized_cutoff)
    except ValueError as exc:
        raise MaterialBindingError("invalid_research_cutoff", "本次研究截止时间格式无效") from exc
    if published > cutoff:
        raise MaterialBindingError(
            "material_after_cutoff",
            "材料首次公开时间晚于本次研究截止时间，不能进入本次投研",
        )


def _compact_text(value: str) -> str:
    return re.sub(r"\s+", "", value)


def _compact_number(value: str) -> str:
    return _compact_text(value).replace(",", "").replace("，", "")


def _excerpt_has_numeric_value(value: str, excerpt: str) -> bool:
    expected = _compact_number(value)
    return any(
        _compact_number(match.group(0)) == expected
        for match in _NUMERIC_TOKEN_RE.finditer(excerpt)
    )


def _unit_in_excerpt(unit: str, excerpt: str) -> bool:
    excerpt = _compact_text(excerpt)
    if unit == "yuan":
        return bool(re.search(r"(?<![亿万])元(?![/／每])", excerpt))
    if unit == "ten_thousand_yuan":
        return "万元" in excerpt
    if unit == "hundred_million_yuan":
        return "亿元" in excerpt
    if unit == "yuan_per_share":
        return bool(re.search(r"元\s*(?:[/／]\s*股|每\s*股)", excerpt))
    return False


def _confirmed_facts_match(
    existing: list[ConfirmedFinancialFact],
    raw_facts: list[dict[str, Any]] | None,
) -> bool:
    if raw_facts is None:
        raw_facts = []
    if not isinstance(raw_facts, list):
        return False
    incoming: list[tuple[Any, ...]] = []
    for raw in raw_facts:
        if not isinstance(raw, dict):
            return False
        metric_raw = (
            raw.get("metric")
            or raw.get("metricCode")
            or raw.get("metric_code")
            or raw.get("metricName")
        )
        unit_raw = raw.get("unit") or raw.get("unitCode") or raw.get("unit_code")
        value_text = (
            raw.get("valueText")
            if "valueText" in raw
            else raw.get("value_text", raw.get("rawValue", raw.get("raw_value")))
        )
        page = raw.get("page", raw.get("pageNumber"))
        excerpt = (
            raw.get("excerpt")
            if "excerpt" in raw
            else raw.get("originalExcerpt", raw.get("original_excerpt"))
        )
        metric = _METRIC_ALIASES.get(metric_raw) if isinstance(metric_raw, str) else None
        unit = _UNIT_ALIASES.get(unit_raw) if isinstance(unit_raw, str) else None
        if metric is None or unit is None or not isinstance(value_text, str) or not isinstance(page, int) or isinstance(page, bool) or not isinstance(excerpt, str):
            return False
        incoming.append((metric, value_text.strip(), unit, page, excerpt.strip()))
    expected = [
        (fact.metric, fact.value_text, fact.unit, fact.page, fact.excerpt)
        for fact in existing
    ]
    return sorted(incoming) == sorted(expected)


def _page_text_hashes(page_texts: dict[int, str]) -> dict[str, str]:
    return {
        str(page): hashlib.sha256(text.encode("utf-8")).hexdigest()
        for page, text in page_texts.items()
    }


def _confirmed_fact_projection(
    fact: ConfirmedFinancialFact,
    *,
    binding: MaterialBinding,
    source_id: str,
) -> dict[str, Any]:
    return {
        "metric_name": CONFIRMED_METRIC_LABELS[fact.metric],
        "value_text": fact.value_text,
        "unit": CONFIRMED_UNIT_LABELS[fact.unit],
        "report_period": binding.report_period,
        "first_published_at": binding.first_published_at,
        "page": fact.page,
        "excerpt": fact.excerpt,
        "source_id": source_id,
    }


def confirmed_fact_user_payload(
    fact: ConfirmedFinancialFact | dict[str, Any],
) -> dict[str, Any]:
    """Serialize a confirmed fact with Chinese labels at the API boundary."""
    if isinstance(fact, ConfirmedFinancialFact):
        metric = fact.metric
        value_text = fact.value_text
        unit = fact.unit
        page = fact.page
        excerpt = fact.excerpt
    else:
        metric = fact.get("metric")
        value_text = fact.get("value_text", fact.get("valueText"))
        unit = fact.get("unit")
        page = fact.get("page")
        excerpt = fact.get("excerpt")
    return {
        "metricName": CONFIRMED_METRIC_LABELS.get(metric, "未知指标"),
        "valueText": value_text,
        "unit": CONFIRMED_UNIT_LABELS.get(unit, "未知单位"),
        "page": page,
        "excerpt": excerpt,
    }


def _safe_relative(value: str) -> bool:
    path = Path(value)
    return (
        value
        and not path.is_absolute()
        and all(part not in ("", ".", "..") for part in value.split("/"))
        and not re.match(r"^[A-Za-z]:", value)
    )


def _clean_segment_text(value: str) -> str:
    """Remove the extractor's markdown heading, keeping only source text."""
    lines = value.strip().splitlines()
    if lines and lines[0].strip().startswith("## "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _page_projection(
    *,
    binding: MaterialBinding,
    source_record: SourceRecord,
    material_name: str,
    page: int,
    text: str,
) -> dict[str, Any]:
    """Build a page-scoped provenance record without extracting facts."""
    page_source = source_record.model_copy(
        update={"id": f"{source_record.id}_p{page}"}
    )
    source_payload = page_source.model_dump(mode="json")
    source_payload["material_id"] = binding.material_id
    source_payload["material_name"] = material_name
    source_payload["page"] = page
    source_payload["location_label"] = f"用户上传财报，第 {page} 页"
    return {
        "material_id": binding.material_id,
        "material_name": material_name,
        "instrument_id": binding.instrument_id,
        "report_type": binding.report_type,
        "report_period": binding.report_period,
        "first_published_at": binding.first_published_at,
        "page": page,
        "text": text,
        "file_hash": binding.file_hash,
        "location": {"page": page},
        "source_id": page_source.id,
        "source": source_payload,
    }


__all__ = [
    "ConfirmedFinancialFact",
    "CONFIRMED_METRIC_LABELS",
    "CONFIRMED_UNIT_LABELS",
    "MaterialBinding",
    "MaterialBindingError",
    "MaterialBindingStore",
    "confirmed_fact_user_payload",
]
