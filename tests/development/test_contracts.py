import pytest
from pydantic import ValidationError

from mona.development.contracts import (
    RUN_TRANSITIONS,
    TERMINAL_RUN_STATUSES,
    Capabilities,
    DevelopmentView,
    Pane,
    RunStatus,
)
from mona.development.executors.base import DispatchReceipt, InterruptReceipt


def test_native_capabilities_are_false_until_observed():
    assert not any(Capabilities().model_dump().values())


@pytest.mark.parametrize("layout,count", [("single", 1), ("split2", 2), ("grid4", 4)])
def test_view_roundtrip_and_focused_pane(layout, count):
    view = DevelopmentView(project_id="project_one", layout=layout,
        panes=[Pane(id=f"pane_{i+1}") for i in range(count)], focused_pane_id=f"pane_{count}")
    assert DevelopmentView.model_validate(view.model_dump(by_alias=True)) == view


@pytest.mark.parametrize("values", [
    {"layout": "grid4"},
    {"focused_pane_id": "pane_missing"},
    {"layout": "split2", "panes": [{"id": "pane_1"}, {"id": "pane_1"}]},
    {"project_id": "../outside"},
    {"system_prompt": "should not be a view field"},
])
def test_malformed_view_rejected(values):
    with pytest.raises(ValidationError):
        DevelopmentView.model_validate({"project_id": "project_one", **values})


def test_terminal_and_unknown_semantics():
    assert all(not RUN_TRANSITIONS[state] for state in TERMINAL_RUN_STATUSES)
    assert RunStatus.UNKNOWN not in TERMINAL_RUN_STATUSES
    assert RUN_TRANSITIONS[RunStatus.UNKNOWN] == {RunStatus.RECOVERING}
    assert InterruptReceipt(outcome="requested").child_processes_stopped is False
    assert DispatchReceipt(input_id="input_one", outcome="queued").native_turn_id is None
