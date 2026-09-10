import json

import pytest

from mona.providers.base import LLMResponse
from mona.system_agent import (
    generate_diagnostic_report,
    generate_storage_assessment,
    generate_system_plan,
    handle_storage_analyze,
    handle_system_plan,
)


class FakeProvider:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict] = []

    async def chat(self, **kwargs):
        self.calls.append(kwargs)
        return LLMResponse(content=self.content)

    def get_default_model(self) -> str:
        return "test-model"


@pytest.mark.asyncio
async def test_system_agent_only_returns_actions_grounded_in_evidence():
    provider = FakeProvider(json.dumps({
        "summary": "发现可处理项目",
        "findings": ["临时文件可安全清理"],
        "actions": [
            {"type": "storage_clean", "targets": ["temp", "made-up"], "title": "清理缓存", "reason": "释放空间", "risk": "low"},
            {"type": "software_update", "targets": ["Google.Chrome.EXE", "missing.app"], "title": "更新浏览器", "reason": "安全更新", "risk": "low"},
            {"type": "startup_disable", "targets": ["machine-service", "wechat"], "title": "关闭启动项", "reason": "减少启动负担", "risk": "low"},
            {"type": "uninstall", "targets": ["Google.Chrome.EXE"], "title": "卸载", "reason": "不需要", "risk": "high"},
        ],
    }, ensure_ascii=False))
    evidence = {
        "software": {"updates": [{"id": "Google.Chrome.EXE", "name": "Google Chrome"}]},
        "startup": {"items": [
            {"id": "wechat", "name": "WeChat", "scope": "user", "enabled": True},
            {"id": "machine-service", "name": "Service", "scope": "machine", "enabled": True},
        ]},
        "storage": {"cleanupItems": [
            {"id": "temp", "name": "临时文件", "cleanable": True, "sizeGb": 1.2},
            {"id": "recycle-bin", "name": "回收站", "cleanable": False, "sizeGb": 3.1},
        ]},
    }

    result = await generate_system_plan(provider, "优化电脑", evidence)

    assert provider.calls[0]["tools"] is None
    assert [(action["type"], action["targetIds"]) for action in result["actions"]] == [
        ("storage_clean", ["temp"]),
        ("software_update", ["Google.Chrome.EXE"]),
        ("startup_disable", ["wechat"]),
    ]
    assert result["actions"][1]["risk"] == "medium"
    assert result["actions"][2]["risk"] == "medium"


@pytest.mark.asyncio
async def test_system_agent_rejects_non_json_model_output():
    provider = FakeProvider("请清理所有文件")

    with pytest.raises(ValueError, match="结构化"):
        await generate_system_plan(provider, "优化电脑", {})


@pytest.mark.asyncio
async def test_system_agent_derives_display_text_from_verified_targets():
    provider = FakeProvider(json.dumps({
        "summary": "电脑有严重漏洞，请立刻处理",
        "findings": ["删除全部文件可以提速"],
        "actions": [{
            "type": "storage_clean",
            "targets": ["temp"],
            "title": "删除整个磁盘",
            "reason": "未知漏洞",
            "risk": "low",
        }],
    }, ensure_ascii=False))

    result = await generate_system_plan(provider, "释放空间", {
        "storage": {"cleanupItems": [{
            "id": "temp", "name": "临时文件", "cleanable": True, "sizeGb": 1.2,
        }]},
    })

    assert result["summary"] == "基于当前系统证据，生成 1 项需确认操作。"
    assert result["findings"] == ["扫描结果显示「临时文件」可安全清理"]
    assert result["actions"][0]["title"] == "清理临时文件"
    assert result["actions"][0]["reason"] == "扫描结果显示「临时文件」可安全清理"


@pytest.mark.asyncio
async def test_diagnostic_report_only_keeps_hypotheses_linked_to_collected_evidence():
    provider = FakeProvider(json.dumps({
        "summary": "更新未完成可能需要先重启。",
        "hypotheses": [
            {
                "title": "系统存在待重启状态",
                "confidence": "high",
                "evidenceIds": ["pending_reboot"],
                "explanation": "检测到更新组件要求重启。",
                "nextStep": "先保存工作并重启，再复查更新。",
            },
            {
                "title": "虚构的硬件故障",
                "confidence": "high",
                "evidenceIds": ["not-collected"],
                "explanation": "没有依据。",
                "nextStep": "不要展示。",
            },
        ],
        "cautions": ["未收集蓝屏转储时，不应断言硬件损坏。"],
    }, ensure_ascii=False))

    result = await generate_diagnostic_report(provider, "更新失败", {
        "symptom": "update",
        "checks": [{"id": "pending_reboot", "status": "attention", "summary": "检测到待重启状态"}],
    })

    assert provider.calls[0]["tools"] is None
    assert result["hypotheses"] == [{
        "title": "系统存在待重启状态",
        "confidence": "high",
        "evidenceIds": ["pending_reboot"],
        "explanation": "检测到更新组件要求重启。",
        "nextStep": "先保存工作并重启，再复查更新。",
    }]


@pytest.mark.asyncio
async def test_system_plan_endpoint_requires_goal_and_evidence():
    class Request:
        app = {}

        async def json(self):
            return {"goal": "", "evidence": {}}

    response = await handle_system_plan(Request())

    assert response.status == 400


@pytest.mark.asyncio
async def test_storage_assessment_redacts_paths_and_rejects_unknown_evidence_ids():
    provider = FakeProvider(json.dumps({
        "summary": "发现两个值得处理的方向。",
        "findings": [
            {
                "title": "清理系统缓存",
                "detail": "扫描标记的缓存可以进入确认流程。",
                "confidence": "high",
                "evidenceIds": ["temp"],
                "action": "plan_cleanup",
                "targetIds": ["temp", "invented-cleanup"],
            },
            {
                "title": "审查长期未修改文件",
                "detail": "修改时间不能单独证明文件无用。",
                "confidence": "medium",
                "evidenceIds": ["file-1"],
                "action": "review_files",
                "targetIds": ["file-1"],
            },
            {
                "title": "虚构目录",
                "detail": "没有真实证据。",
                "confidence": "high",
                "evidenceIds": ["not-scanned"],
                "action": "inspect_directory",
                "targetIds": ["not-scanned"],
            },
        ],
        "cautions": ["个人文件需要用户确认。"],
    }, ensure_ascii=False))
    evidence = {
        "scanId": "scan-1",
        "scope": {
            "id": "dir-root",
            "path": "C:\\Users\\Mona\\SecretProject",
            "sizeGb": 12,
            "fileCount": 20,
            "directSizeGb": 1,
            "artifactKind": "Node.js 依赖目录",
        },
        "children": [],
        "largeFiles": [{
            "id": "file-1",
            "fileName": "private-backup.zip",
            "path": "C:\\Users\\Mona\\private-backup.zip",
            "extension": "zip",
            "sizeGb": 3,
            "modifiedBucket": "old",
        }],
        "cleanupItems": [{
            "id": "temp",
            "name": "临时文件",
            "path": "C:\\Users\\Mona\\AppData\\Local\\Temp",
            "sizeGb": 1.2,
            "cleanable": True,
            "reason": "应用临时文件",
        }],
    }

    result = await generate_storage_assessment(provider, "分析当前范围", evidence)

    prompt = provider.calls[0]["messages"][0]["content"]
    assert "SecretProject" not in prompt
    assert "private-backup.zip" not in prompt
    assert "C:\\Users" not in prompt
    assert result["scanId"] == "scan-1"
    assert [finding["action"] for finding in result["findings"]] == [
        "plan_cleanup",
        "review_files",
    ]
    assert result["findings"][0]["targetIds"] == ["temp"]
    assert result["findings"][0]["relatedSizeGb"] == 1.2


@pytest.mark.asyncio
async def test_storage_assessment_endpoint_requires_scan_id():
    class Request:
        app = {}

        async def json(self):
            return {"goal": "分析空间", "evidence": {}}

    response = await handle_storage_analyze(Request())

    assert response.status == 400
