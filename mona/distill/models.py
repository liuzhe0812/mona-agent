"""Validated contracts for the user-profile dashboard and advice workflow."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ObservedProfileField = Literal[
    "background",
    "current_focus",
    "preferences",
    "work_context",
    "interests",
]
ProfileField = Literal[
    "background",
    "current_focus",
    "preferences",
    "work_context",
    "interests",
    "special_instructions",
]
AdviceDimension = Literal["learning", "method", "reuse", "opportunity"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UnderstandingItem(_Contract):
    field: ObservedProfileField
    text: str = Field(min_length=1, max_length=500)
    source_refs: list[str] = Field(min_length=1, max_length=5)


class ProfileUnderstandingOutput(_Contract):
    understanding: list[UnderstandingItem] = Field(default_factory=list, max_length=5)


class AdviceKnowledge(_Contract):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=3000)


class AdviceResource(_Contract):
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2000)


class OneInsightAdviceOutput(_Contract):
    knowledge: AdviceKnowledge | None = None
    learning_advice: str = Field(default="", max_length=2400)
    resources: list[AdviceResource] = Field(default_factory=list, max_length=3)
    empty_reason: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def validate_content(self) -> "OneInsightAdviceOutput":
        if self.knowledge is None:
            if not self.empty_reason.strip():
                raise ValueError("empty_reason is required when knowledge is empty")
            self.learning_advice = ""
            self.resources = []
        elif not self.learning_advice.strip():
            raise ValueError("learning_advice is required when knowledge is present")
        else:
            self.empty_reason = ""
        return self


class ExplicitContextValue(_Contract):
    mode: Literal["override", "suppress"]
    value: str = Field(default="", max_length=2000)
    updated_at: datetime

    @model_validator(mode="after")
    def validate_value(self) -> "ExplicitContextValue":
        value = self.value.strip()
        if self.mode == "override" and not value:
            raise ValueError("override value is required")
        if self.mode == "suppress" and value:
            raise ValueError("suppress value must be empty")
        self.value = value
        return self


class ProfileContextPatch(_Contract):
    field: ProfileField
    mode: Literal["override", "suppress", "reset"]
    value: str = Field(default="", max_length=2000)
    expected_context_revision: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_value(self) -> "ProfileContextPatch":
        value = self.value.strip()
        if self.mode == "override" and not value:
            raise ValueError("value is required for override")
        if self.mode != "override" and value:
            raise ValueError("value is only valid for override")
        if self.field == "special_instructions" and self.mode == "suppress":
            raise ValueError("special_instructions supports override or reset")
        self.value = value
        return self


class AdviceFeedbackPatch(_Contract):
    useful: bool | None = None
    disposition: Literal["active", "dismissed", "completed"] | None = None
    dismiss_reason: Literal["already_known", "not_now", "incorrect"] | None = None
    expected_item_revision: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_dismiss_reason(self) -> "AdviceFeedbackPatch":
        if self.disposition == "dismissed" and self.dismiss_reason is None:
            raise ValueError("dismiss_reason is required for dismissed advice")
        if self.disposition not in (None, "dismissed") and self.dismiss_reason is not None:
            raise ValueError("dismiss_reason is only valid for dismissed advice")
        if self.useful is None and self.disposition is None:
            raise ValueError("feedback must change useful or disposition")
        return self


class ArtifactFeedbackPatch(_Contract):
    adopted: bool
    expected_item_revision: int = Field(ge=0)


class EvidenceRef(_Contract):
    ref: str = Field(min_length=1, max_length=160)
    kind: Literal["user_message", "note", "artifact", "explicit_context"]
    source_scope_id: str = Field(min_length=1, max_length=160)
    title: str = Field(default="", max_length=300)
    occurred_at: datetime | None = None
    excerpt: str = Field(default="", max_length=600)
    truncated: bool = False
    session_key: str | None = Field(default=None, max_length=500)
    message_id: str | None = Field(default=None, max_length=500)
    message_index: int | None = Field(default=None, ge=0)
    note_relative_path: str | None = Field(default=None, max_length=1000)
    artifact_id: str | None = Field(default=None, max_length=500)
    content_hash: str = Field(min_length=1, max_length=128)


__all__ = [
    "AdviceFeedbackPatch",
    "AdviceKnowledge",
    "AdviceResource",
    "ArtifactFeedbackPatch",
    "EvidenceRef",
    "ExplicitContextValue",
    "OneInsightAdviceOutput",
    "ObservedProfileField",
    "ProfileContextPatch",
    "ProfileField",
    "ProfileUnderstandingOutput",
    "UnderstandingItem",
]
