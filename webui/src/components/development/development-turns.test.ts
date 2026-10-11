import { describe, expect, it } from "vitest";
import type { DevMessage, DevRun } from "@/lib/development-api";
import { buildDevelopmentTurns } from "./development-turns";

const message = (id: string, role: string, content: string, patch: Partial<DevMessage> = {}): DevMessage => ({
  id, role, content, truncated: false, toolCalls: [], queued: false, ...patch,
});

const run = (id: string, status: DevRun["status"], patch: Partial<DevRun> = {}): DevRun => ({
  id, sessionId: "session_a", executor: "mona", status, revision: 1, createdAt: "2026-09-29T00:00:00Z", ...patch,
});

describe("buildDevelopmentTurns", () => {
  it("binds out-of-order answers by run and excludes queued, tool, and collaboration messages", () => {
    const turns = buildDevelopmentTurns([
      message("question_a", "user", "**第一问**", { runId: "run_a" }),
      message("queued_b", "user", "尚未派发的问题", { queued: true }),
      message("question_b", "user", "第二问", { runId: "run_b" }),
      message("child_result", "assistant", "子任务资料", { sourceKind: "collaboration", runId: "run_a" }),
      message("tool_result", "tool", "工具输出不能进入预览", { runId: "run_a" }),
      message("answer_b", "assistant", "答复 **第二问**", { runId: "run_b" }),
      message("answer_a", "assistant", "答复 `第一问`", { runId: "run_a" }),
    ], [run("run_a", "succeeded"), run("run_b", "succeeded")]);

    expect(turns).toEqual([
      { id: "question_a", userPreview: "第一问", assistantPreview: "答复 第一问", running: false },
      { id: "question_b", userPreview: "第二问", assistantPreview: "答复 第二问", running: false },
    ]);
  });

  it("filters runtime and steering inputs and uses the run request id when the user row lacks runId", () => {
    const turns = buildDevelopmentTurns([
      message("question", "user", "任务开始"),
      message("runtime_input", "user", "内部上下文", { sourceKind: "runtime", runId: "run_a" }),
      message("steering_input", "user", "纠偏内容", { sourceKind: "steering", runId: "run_a" }),
      message("answer", "assistant", "完成", { runId: "run_a" }),
    ], [run("run_a", "succeeded", { requestMessageId: "question" })]);

    expect(turns).toEqual([{ id: "question", userPreview: "任务开始", assistantPreview: "完成", running: false }]);
  });

  it("keeps image previews text-only and gives image-only questions an attachment fallback", () => {
    const turns = buildDevelopmentTurns([
      message("question_image", "user", "", { media: [{ kind: "image", url: "data:image/png;base64,secret", name: "screenshot.png" }] }),
      message("question_markdown_image", "user", "![图表](data:image/png;base64,VERY_SECRET_BASE64)", { runId: "run_a" }),
    ], [run("run_a", "succeeded")]);

    expect(turns.map((turn) => turn.userPreview)).toEqual(["图片附件", "图表"]);
    expect(JSON.stringify(turns)).not.toContain("SECRET");
  });

  it("uses the live native or local stream and Chinese empty-state fallbacks", () => {
    const turns = buildDevelopmentTurns([
      message("question_running", "user", "仍在执行", { runId: "run_running" }),
      message("question_done", "user", "已结束", { runId: "run_done" }),
    ], [run("run_running", "running", { executor: "codex" }), run("run_done", "succeeded")], {
      runId: "run_running", content: "**正在生成**",
    });

    expect(turns).toEqual([
      { id: "question_running", userPreview: "仍在执行", assistantPreview: "正在生成", running: true },
      { id: "question_done", userPreview: "已结束", assistantPreview: "暂无回复", running: false },
    ]);
    expect(buildDevelopmentTurns([
      message("question_empty_stream", "user", "等待", { runId: "run_empty" }),
    ], [run("run_empty", "running")], { runId: "run_empty", content: "" })[0].assistantPreview).toBe("正在回复…");
  });

  it.each(["unknown", "recovering"] as const)("does not project %s as a live turn", (status) => {
    const turns = buildDevelopmentTurns([
      message("question_unresolved", "user", "状态待核对", { runId: `run_${status}` }),
    ], [run(`run_${status}`, status)]);

    expect(turns).toEqual([{
      id: "question_unresolved", userPreview: "状态待核对", assistantPreview: "暂无回复", running: false,
    }]);
  });

  it("uses an unbound assistant message only for the latest user with no run association", () => {
    const turns = buildDevelopmentTurns([
      message("bound_question", "user", "前一问", { runId: "run_a" }),
      message("legacy_question", "user", "后一个旧会话问题"),
      message("legacy_answer", "assistant", "按顺序补配的回答"),
      message("unmatched_answer", "assistant", "不能回绑前一问", { runId: "missing_run" }),
    ], [run("run_a", "succeeded")]);

    expect(turns.map((turn) => turn.assistantPreview)).toEqual(["暂无回复", "按顺序补配的回答"]);
  });
});
