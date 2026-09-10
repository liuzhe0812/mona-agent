import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RichProfile } from "@/lib/profile-api";

const mocks = vi.hoisted(() => ({ fetchProfile: vi.fn(), triggerDistill: vi.fn() }));

vi.mock("@/lib/profile-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/profile-api")>("@/lib/profile-api");
  return { ...actual, fetchProfile: mocks.fetchProfile, triggerDistill: mocks.triggerDistill };
});

import { ProfileView } from "./ProfileView";

const profile: RichProfile = {
  version: "3.0",
  revision: 3,
  last_distilled_at: "2026-09-08T09:00:00+08:00",
  effective_context: [
    { field: "background", value: "产品设计与工程协作", origin: "observed", source_refs: [] },
    { field: "current_focus", value: "整理用户画像产品", origin: "confirmed", source_refs: [] },
  ],
  facts: { context_revision: 2 },
  profile: {
    understanding: [{ field: "current_focus", text: "正在整理用户画像产品", source_refs: [] }],
  },
  advice: {
    current_ids: ["advice-1"],
    generation_status: "ready",
    items: [{
      id: "advice-1",
      dimension: "method",
      title: "把画像指标分成观察与结果",
      why_now: "近期正在定义画像数据口径。",
      source_refs: [],
      first_step: "列出三个指标及其证据来源。",
      starter_content: "- 观察指标\n- 结果指标",
      expected_output: "一份指标草案",
      done_when: "每个指标都能指出数据来源。",
      start_prompt: "请帮我整理画像指标草案。",
      created_at: "2026-09-08T09:00:00+08:00",
      last_supported_at: "2026-09-08T09:00:00+08:00",
      source_scope_id: "scope",
    }],
  },
  dashboard: {
    window_start: "2026-08-09T00:00:00+08:00",
    window_end: "2026-09-08T00:00:00+08:00",
    metrics: {
      active_conversations: { current: { value: 2, availability: "available" }, previous: { value: 1, availability: "available" }, delta: 1, comparison_available: true },
      user_messages: { current: { value: 7, availability: "available" }, previous: { value: 4, availability: "available" }, delta: 3, comparison_available: true },
      active_dates: { current: { value: 3, availability: "available" }, previous: { value: 2, availability: "available" }, delta: 1, comparison_available: true },
      generated_artifacts: { current: { value: 1, availability: "available" }, previous: { value: 0, availability: "available" }, delta: 1, comparison_available: true },
    },
    topic_records: [{ topic: "画像设计", count: 3, source: "sessions" }],
    daily_activity: [{ date: "2026-09-07", user_messages: 2 }],
    coverage: [{ source: "sessions", status: "available", scanned_count: 2, selected_count: 2, unknown_time_count: 0, assumed_timezone_count: 0, truncated_count: 0, earliest: null, latest: null, reason_code: null }],
    artifacts: [],
    profile_charts: {
      profile_dimensions: [
        { axis: "AI 应用", count: 7 },
        { axis: "产品设计", count: 5 },
        { axis: "知识检索", count: 4 },
      ],
      previous_profile_dimensions: [
        { axis: "AI 应用", count: 4 },
        { axis: "产品设计", count: 6 },
        { axis: "知识检索", count: 2 },
      ],
      topic_graph: {
        nodes: [
          { id: "topic:AI", label: "AI 应用", group: "AI 应用", count: 7 },
          { id: "topic:RAG", label: "RAG", group: "知识检索", count: 4 },
        ],
        links: [{ source: "topic:AI", target: "topic:RAG", weight: 2 }],
      },
      collaboration_types: [{ label: "分析", count: 4 }, { label: "设计", count: 3 }],
      artifact_types: [{ label: "文档", count: 1 }],
      domain_task_matrix: {
        domains: ["AI 应用", "产品设计"],
        tasks: ["开发", "分析", "写作", "设计"],
        values: [[1, 3, 0, 1], [0, 1, 0, 2]],
      },
      topic_trends: {
        labels: ["08-11", "08-18", "08-25", "09-01"],
        series: [{ topic: "AI 应用", values: [1, 2, 2, 3] }],
      },
      topic_comparison: [{ topic: "AI 应用", current: 7, previous: 4, delta: 3 }],
      new_topics: [{ topic: "RAG", count: 4, first_seen_at: "2026-08-25T09:00:00+08:00" }],
    },
  },
};

describe("ProfileView dashboard shell", () => {
  beforeEach(() => {
    mocks.fetchProfile.mockResolvedValue(profile);
    mocks.triggerDistill.mockResolvedValue({ ok: true, status: "success", results: [{ task: "profile", success: true, confidence: 1, status: "success" }] });
  });

  it("uses the new Chinese tabs and removes the old pain and skill sections", async () => {
    render(<ProfileView />);

    expect((await screen.findAllByText("我的画像")).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "变化轨迹" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI 建议" })).toBeInTheDocument();
    expect(screen.queryByText("近期痛点与开放问题")).not.toBeInTheDocument();
    expect(screen.queryByText("技能矩阵")).not.toBeInTheDocument();
    expect(screen.queryByText("需要补强 Top 3")).not.toBeInTheDocument();
    expect(screen.queryByText("查看支撑记录")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-08-09 至 2026-09-08")).not.toBeInTheDocument();
    expect(screen.getByLabelText("关注领域雷达图")).toBeInTheDocument();
    expect(screen.getByLabelText("主题关联图")).toBeInTheDocument();
  });

  it("shows the dashboard tabs without requesting legacy growth comparison", async () => {
    render(<ProfileView />);
    await screen.findAllByText("我的画像");

    await userEvent.click(screen.getByRole("tab", { name: "AI 建议" }));
    expect(await screen.findByText("AI 给你的一个建议")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "变化轨迹" }));
    expect((await screen.findAllByText("变化轨迹")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("话题变化趋势")).toBeInTheDocument();
    expect(screen.getByLabelText("关注结构对比")).toBeInTheDocument();
  });

  it("keeps a readable error state when the profile request fails", async () => {
    mocks.fetchProfile.mockRejectedValueOnce(new Error("profile unavailable"));
    render(<ProfileView />);
    await waitFor(() => expect(screen.getByText("profile unavailable")).toBeInTheDocument());
  });

  it("names the unfinished update stage instead of showing an unexplained ratio", async () => {
    mocks.triggerDistill.mockResolvedValueOnce({
      ok: true,
      status: "success",
      results: [
        { task: "dashboard", success: true, confidence: 1, status: "success" },
        { task: "work-pattern", success: true, confidence: 1, status: "success" },
        { task: "profile", success: true, confidence: 1, status: "success" },
        { task: "advice", success: false, confidence: 0, status: "failed" },
      ],
    });
    render(<ProfileView />);

    await userEvent.click(await screen.findByRole("button", { name: "更新画像" }));

    expect(await screen.findByText("部分内容已更新；AI 建议未完成，可稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText(/3\/4/)).not.toBeInTheDocument();
  });
});
